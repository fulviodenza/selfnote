//! Document persistence for the sync server.
//!
//! `MemoryStore` is a no-op (Phase 1 behaviour: clients are the source of truth).
//! `PgStore` appends every CRDT update to the `doc_updates` log and, on room drop,
//! compacts the log into a single `doc_snapshots` row so loads stay fast and the
//! log stays bounded. A document survives a full server restart because its state
//! is the snapshot + the tail of the update log.

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

#[async_trait]
pub trait Store: Send + Sync {
    /// Return the document's full state as a single merged v1 update, if any.
    async fn load(&self, doc_id: &str) -> anyhow::Result<Option<Vec<u8>>>;
    /// Append an update to the log.
    async fn persist(&self, doc_id: &str, update: &[u8]) -> anyhow::Result<()>;
    /// Fold the log into a snapshot and prune folded updates.
    async fn compact(&self, doc_id: &str) -> anyhow::Result<()>;
}

/// No persistence — used when no DATABASE_URL is configured.
pub struct MemoryStore;

#[async_trait]
impl Store for MemoryStore {
    async fn load(&self, _doc_id: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    async fn persist(&self, _doc_id: &str, _update: &[u8]) -> anyhow::Result<()> {
        Ok(())
    }
    async fn compact(&self, _doc_id: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Merge a snapshot plus a list of updates into one v1 update.
fn merge_updates(snapshot: Option<&[u8]>, updates: &[Vec<u8>]) -> anyhow::Result<Vec<u8>> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        if let Some(snap) = snapshot {
            txn.apply_update(Update::decode_v1(snap)?)?;
        }
        for u in updates {
            txn.apply_update(Update::decode_v1(u)?)?;
        }
    }
    let txn = doc.transact();
    Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}

#[async_trait]
impl Store for PgStore {
    async fn load(&self, doc_id: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let Ok(id) = Uuid::parse_str(doc_id) else {
            return Ok(None); // non-UUID room (e.g. tests) → memory-only
        };

        let snapshot: Option<(Vec<u8>, i64)> =
            sqlx::query_as("select snapshot, last_update_id from doc_snapshots where doc_id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;

        let since = snapshot.as_ref().map(|(_, last)| *last).unwrap_or(0);

        let updates: Vec<(Vec<u8>,)> =
            sqlx::query_as("select update from doc_updates where doc_id = $1 and id > $2 order by id")
                .bind(id)
                .bind(since)
                .fetch_all(&self.pool)
                .await?;

        if snapshot.is_none() && updates.is_empty() {
            return Ok(None);
        }

        let update_bytes: Vec<Vec<u8>> = updates.into_iter().map(|(u,)| u).collect();
        let merged = merge_updates(snapshot.as_ref().map(|(s, _)| s.as_slice()), &update_bytes)?;
        Ok(Some(merged))
    }

    async fn persist(&self, doc_id: &str, update: &[u8]) -> anyhow::Result<()> {
        let Ok(id) = Uuid::parse_str(doc_id) else {
            return Ok(());
        };
        // Ignore FK violations for rooms without a documents row.
        let res = sqlx::query("insert into doc_updates (doc_id, update) values ($1, $2)")
            .bind(id)
            .bind(update)
            .execute(&self.pool)
            .await;
        if let Err(sqlx::Error::Database(e)) = &res {
            if e.is_foreign_key_violation() {
                return Ok(());
            }
        }
        res?;
        Ok(())
    }

    async fn compact(&self, doc_id: &str) -> anyhow::Result<()> {
        let Ok(id) = Uuid::parse_str(doc_id) else {
            return Ok(());
        };

        let max_id: Option<(i64,)> =
            sqlx::query_as("select max(id) from doc_updates where doc_id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        let Some((max_id,)) = max_id.filter(|(m,)| *m > 0) else {
            return Ok(()); // nothing to compact
        };

        // Merge existing snapshot + all updates up to max_id.
        let snapshot: Option<(Vec<u8>,)> =
            sqlx::query_as("select snapshot from doc_snapshots where doc_id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        let updates: Vec<(Vec<u8>,)> =
            sqlx::query_as("select update from doc_updates where doc_id = $1 and id <= $2 order by id")
                .bind(id)
                .bind(max_id)
                .fetch_all(&self.pool)
                .await?;
        let update_bytes: Vec<Vec<u8>> = updates.into_iter().map(|(u,)| u).collect();
        let merged = merge_updates(snapshot.as_ref().map(|(s,)| s.as_slice()), &update_bytes)?;

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "insert into doc_snapshots (doc_id, snapshot, last_update_id, updated_at) \
             values ($1, $2, $3, now()) \
             on conflict (doc_id) do update set snapshot = excluded.snapshot, \
             last_update_id = excluded.last_update_id, updated_at = now()",
        )
        .bind(id)
        .bind(&merged)
        .bind(max_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from doc_updates where doc_id = $1 and id <= $2")
            .bind(id)
            .bind(max_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
