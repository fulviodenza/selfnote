//! Version history / time-travel.
//!
//! A note's content lives only as an append-only Yjs CRDT log (`doc_updates`)
//! compacted into `doc_snapshots`, which is too fine-grained and gets pruned on
//! compaction — so it can't back a durable timeline on its own. This module adds
//! an explicit **checkpoints** table (`doc_checkpoints`): each row is a full,
//! immutable merged snapshot of a document's state at a point in time, plus a
//! `label`, `kind`, and author. Users browse these, preview any past state
//! read-only, and restore one.
//!
//! Restore never destroys history: it is implemented as a *forward* CRDT update —
//! a diff that turns the current state back into the chosen past state — appended
//! to `doc_updates` exactly like `set_content`, so all live sync clients converge.
//!
//! The CRDT math (merging the update log into one snapshot, and computing the
//! forward restore diff) can't be done in pure Rust here, so — like `proposals.rs`
//! — we shell out to the Node helper (`tools/mcp-server` → `dist/diff-cli.js`),
//! reusing the same y-prosemirror path the live editor and MCP server use.

use axum::extract::{Path, Query, State};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::documents;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
const MAX_LABEL_CHARS: usize = 200;
const DEFAULT_RESTORE_LABEL: &str = "Before restore";

/* --------------------------------------------------------------- helpers --- */

/// Standard base64, matching the convention used by `GET /documents/:id/content`.
fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Load a doc and assert the caller is a member (any role) of its workspace.
/// `404` if the doc is missing, `403` if the caller can't access it. Used for
/// the read endpoints (list, get, diff).
async fn authorize_read(state: &AppState, user: &AuthUser, doc_id: Uuid) -> ApiResult<()> {
    let doc = documents::get_document(state, doc_id).await?;
    if member_role(state, doc.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

/// Load a doc and assert the caller is a non-viewer member of its workspace.
/// `404` if missing, `403` if not a member or a viewer. Used for the write
/// endpoints (create, restore, delete).
async fn authorize_write(state: &AppState, user: &AuthUser, doc_id: Uuid) -> ApiResult<()> {
    let doc = documents::get_document(state, doc_id).await?;
    match member_role(state, doc.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

/// Validate + normalize an optional label: trimmed, `None`/empty → `None`,
/// `400` if it exceeds `MAX_LABEL_CHARS`.
fn normalize_label(label: Option<String>) -> ApiResult<Option<String>> {
    match label {
        Some(l) => {
            let trimmed = l.trim();
            if trimmed.chars().count() > MAX_LABEL_CHARS {
                return Err(AppError::BadRequest(format!(
                    "label exceeds {MAX_LABEL_CHARS} characters"
                )));
            }
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            })
        }
        None => Ok(None),
    }
}

/// The metadata columns for a checkpoint list/get row (no `snapshot`), joining
/// the author's display name. `created_by_name` is null for auto checkpoints
/// (null `created_by`) and for users whose display name is empty.
const META_SELECT: &str = "c.id, c.doc_id, c.kind, c.label, c.size_bytes, c.created_by, \
     nullif(u.display_name, '') as created_by_name, c.created_at";

/// One checkpoint's metadata, as returned by list / create (and embedded in get).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CheckpointMeta {
    pub id: Uuid,
    pub doc_id: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub size_bytes: i64,
    pub created_by: Option<Uuid>,
    pub created_by_name: Option<String>,
    pub created_at: DateTime<Utc>,
}

/* --------------------------------------------------------- node diff CLI --- */

#[derive(Debug, Deserialize)]
struct Merged {
    snapshot: String,
    size_bytes: i64,
}

#[derive(Debug, Deserialize)]
struct Restored {
    update: String,
    #[allow(dead_code)]
    size_bytes: i64,
}

/// Run the Node diff helper with a JSON job on stdin, parse its JSON stdout into
/// `T`. Mirrors `proposals::run_diff_cli` — `SELFNOTE_EDIT_DIFF_CMD` overrides the
/// command (default `selfnote-edit-diff`); the helper is expected on PATH.
async fn run_diff_cli<T: for<'de> Deserialize<'de>>(job: serde_json::Value) -> ApiResult<T> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let cmd = std::env::var("SELFNOTE_EDIT_DIFF_CMD")
        .unwrap_or_else(|_| "selfnote-edit-diff".to_string());
    let mut child = Command::new(&cmd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("spawn {cmd}: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(job.to_string().as_bytes())
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!("write stdin: {e}")))?;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("diff cli wait: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(AppError::Conflict(format!("could not compute checkpoint: {err}")));
        }
    }
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Conflict(format!("could not compute checkpoint: {err}")));
    }
    serde_json::from_str::<T>(&stdout)
        .map_err(|e| AppError::Other(anyhow::anyhow!("diff cli parse: {e}; body: {stdout}")))
}

/// Merge a document's current content (snapshot + tail of `doc_updates`, exactly
/// as `get_content` does) into a single v1 Yjs update and its byte length.
async fn current_snapshot(state: &AppState, doc_id: Uuid) -> ApiResult<(Vec<u8>, i64)> {
    let updates = documents::load_content_updates(state, doc_id).await?;
    let merged: Merged = run_diff_cli(serde_json::json!({
        "mode": "merge",
        "updates": updates,
    }))
    .await?;
    let bytes = b64()
        .decode(merged.snapshot.as_bytes())
        .map_err(|_| AppError::Other(anyhow::anyhow!("diff cli returned invalid base64")))?;
    Ok((bytes, merged.size_bytes))
}

/// Insert a checkpoint row and return its metadata. `snapshot` is the merged v1
/// update bytes; `created_by` is null for auto captures.
async fn insert_checkpoint(
    state: &AppState,
    doc_id: Uuid,
    snapshot: &[u8],
    size_bytes: i64,
    kind: &str,
    label: Option<&str>,
    created_by: Option<Uuid>,
) -> ApiResult<CheckpointMeta> {
    let meta: CheckpointMeta = sqlx::query_as(&format!(
        "with ins as ( \
             insert into doc_checkpoints (doc_id, snapshot, size_bytes, kind, label, created_by) \
             values ($1, $2, $3, $4, $5, $6) \
             returning id, doc_id, kind, label, size_bytes, created_by, created_at \
         ) \
         select {META_SELECT} from ins c left join users u on u.id = c.created_by"
    ))
    .bind(doc_id)
    .bind(snapshot)
    .bind(size_bytes)
    .bind(kind)
    .bind(label)
    .bind(created_by)
    .fetch_one(&state.pool)
    .await?;
    Ok(meta)
}

/* ----------------------------------------------------------------- list --- */

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub before: Option<DateTime<Utc>>,
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ListResp {
    pub checkpoints: Vec<CheckpointMeta>,
    /// `created_at` of the last returned row, or null when fewer than `limit` rows
    /// were returned (no more pages).
    pub next_before: Option<DateTime<Utc>>,
}

/// `GET /documents/:id/history` — list checkpoints, newest-first. Any member.
/// `limit` defaults to 50, clamped to `1..=200`; `before` paginates (strictly
/// older than the timestamp); `kind` filters (`manual|auto|restore`).
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<ListResp>> {
    authorize_read(&state, &user, doc_id).await?;

    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let kind = match q.kind.as_deref() {
        None => None,
        Some(k @ ("manual" | "auto" | "restore")) => Some(k.to_string()),
        Some(_) => return Err(AppError::BadRequest("invalid kind".into())),
    };

    let checkpoints: Vec<CheckpointMeta> = sqlx::query_as(&format!(
        "select {META_SELECT} from doc_checkpoints c \
         left join users u on u.id = c.created_by \
         where c.doc_id = $1 \
           and ($2::timestamptz is null or c.created_at < $2) \
           and ($3::text is null or c.kind = $3) \
         order by c.created_at desc \
         limit $4"
    ))
    .bind(doc_id)
    .bind(q.before)
    .bind(kind)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    // Only advertise another page when this one filled the limit; otherwise null.
    let next_before = if (checkpoints.len() as i64) < limit {
        None
    } else {
        checkpoints.last().map(|c| c.created_at)
    };

    Ok(Json(ListResp {
        checkpoints,
        next_before,
    }))
}

/* ------------------------------------------------------------------ get --- */

#[derive(Debug, Serialize)]
pub struct CheckpointFull {
    pub id: Uuid,
    pub doc_id: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub size_bytes: i64,
    pub created_by: Option<Uuid>,
    pub created_by_name: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Ordered list of base64 v1 Yjs updates (same shape as `GET …/content`); for
    /// a checkpoint always exactly one element — the full merged snapshot.
    pub updates: Vec<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct CheckpointRow {
    id: Uuid,
    doc_id: Uuid,
    kind: String,
    label: Option<String>,
    size_bytes: i64,
    created_by: Option<Uuid>,
    created_by_name: Option<String>,
    created_at: DateTime<Utc>,
    snapshot: Vec<u8>,
}

/// Load a checkpoint that belongs to `doc_id`, `404` otherwise.
async fn load_checkpoint(
    state: &AppState,
    doc_id: Uuid,
    checkpoint_id: Uuid,
) -> ApiResult<CheckpointRow> {
    let row: Option<CheckpointRow> = sqlx::query_as(&format!(
        "select {META_SELECT}, c.snapshot from doc_checkpoints c \
         left join users u on u.id = c.created_by \
         where c.id = $1 and c.doc_id = $2"
    ))
    .bind(checkpoint_id)
    .bind(doc_id)
    .fetch_optional(&state.pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

/// `GET /documents/:id/history/:checkpoint_id` — one checkpoint with its full
/// merged state as a single base64 update. Any member. `404` if the checkpoint
/// does not belong to `:id`.
pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((doc_id, checkpoint_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<CheckpointFull>> {
    authorize_read(&state, &user, doc_id).await?;
    let row = load_checkpoint(&state, doc_id, checkpoint_id).await?;
    Ok(Json(CheckpointFull {
        id: row.id,
        doc_id: row.doc_id,
        kind: row.kind,
        label: row.label,
        size_bytes: row.size_bytes,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        updates: vec![b64().encode(&row.snapshot)],
    }))
}

/* --------------------------------------------------------------- create --- */

#[derive(Debug, Deserialize)]
pub struct CreateReq {
    #[serde(default)]
    pub label: Option<String>,
}

/// `POST /documents/:id/history` — capture the doc's *current* merged state as a
/// `manual` checkpoint. Member, non-viewer. `created_by` = caller. `400` if
/// `label` exceeds 200 chars.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(req): Json<CreateReq>,
) -> ApiResult<(axum::http::StatusCode, Json<CheckpointMeta>)> {
    authorize_write(&state, &user, doc_id).await?;
    let label = normalize_label(req.label)?;

    let (snapshot, size_bytes) = current_snapshot(&state, doc_id).await?;
    let meta = insert_checkpoint(
        &state,
        doc_id,
        &snapshot,
        size_bytes,
        "manual",
        label.as_deref(),
        Some(user.id),
    )
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(meta)))
}

/* -------------------------------------------------------------- restore --- */

#[derive(Debug, Deserialize)]
pub struct RestoreReq {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RestoreResp {
    pub restored_from: Uuid,
    pub pre_restore_checkpoint: Uuid,
    /// The forward v1 Yjs update appended to the log (base64) — a live editor can
    /// apply it immediately; other clients receive it over the sync socket.
    pub update: String,
}

/// `POST /documents/:id/history/:checkpoint_id/restore` — restore a checkpoint by
/// replaying it forward. Member, non-viewer. Transactional:
///   1. Capture current state as a `restore`-kind checkpoint (pre-restore).
///   2. Compute a forward update turning current state into the target state.
///   3. Append it to `doc_updates` (all sync clients converge) and bump
///      `documents.updated_at`.
/// No rows are deleted — history is preserved. `404` if the checkpoint is missing
/// or does not belong to `:id`.
pub async fn restore(
    State(state): State<AppState>,
    user: AuthUser,
    Path((doc_id, checkpoint_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<RestoreReq>,
) -> ApiResult<Json<RestoreResp>> {
    authorize_write(&state, &user, doc_id).await?;
    let label = normalize_label(req.label)?;
    let target = load_checkpoint(&state, doc_id, checkpoint_id).await?;

    // 1. Snapshot the current state (before we touch anything) as the pre-restore
    //    checkpoint, so the state we're about to move away from is never lost.
    let (pre_snapshot, pre_size) = current_snapshot(&state, doc_id).await?;

    // 2. Compute the forward diff from current content into the target snapshot.
    let updates = documents::load_content_updates(&state, doc_id).await?;
    let restored: Restored = run_diff_cli(serde_json::json!({
        "mode": "restore",
        "updates": updates,
        "target": b64().encode(&target.snapshot),
    }))
    .await?;

    // 3. Persist atomically: the pre-restore checkpoint, the forward update in the
    //    content log, and the doc's touched `updated_at`.
    let mut tx = state.pool.begin().await?;

    let pre: (Uuid,) = sqlx::query_as(
        "insert into doc_checkpoints (doc_id, snapshot, size_bytes, kind, label, created_by) \
         values ($1, $2, $3, 'restore', $4, $5) returning id",
    )
    .bind(doc_id)
    .bind(&pre_snapshot)
    .bind(pre_size)
    .bind(label.as_deref().unwrap_or(DEFAULT_RESTORE_LABEL))
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;

    let update_bytes = b64()
        .decode(restored.update.as_bytes())
        .map_err(|_| AppError::Other(anyhow::anyhow!("diff cli returned invalid base64")))?;
    sqlx::query("insert into doc_updates (doc_id, update) values ($1, $2)")
        .bind(doc_id)
        .bind(&update_bytes)
        .execute(&mut *tx)
        .await?;

    sqlx::query("update documents set updated_at = now() where id = $1")
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(RestoreResp {
        restored_from: checkpoint_id,
        pre_restore_checkpoint: pre.0,
        update: restored.update,
    }))
}

/* --------------------------------------------------------------- delete --- */

/// `DELETE /documents/:id/history/:checkpoint_id` — delete a checkpoint row.
/// Member, non-viewer. History-management only; does not touch document content.
/// `204` on success, `404` if not found / not owned by `:id`.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((doc_id, checkpoint_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<axum::http::StatusCode> {
    authorize_write(&state, &user, doc_id).await?;
    let res = sqlx::query("delete from doc_checkpoints where id = $1 and doc_id = $2")
        .bind(checkpoint_id)
        .bind(doc_id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
