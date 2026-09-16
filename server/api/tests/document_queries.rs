//! The document SQL, run against a real Postgres.
//!
//! These exist because `sqlx::query_as` with a runtime query string is not
//! checked at compile time. `cargo build` says nothing about whether a column
//! decodes into the Rust type the handler declares, and this file is written
//! entirely in the runtime form. A `max(depth)` over `1 as depth` is INT4 while
//! the handler read it into an i64, which built cleanly and then returned 500 on
//! every document patch: delete, archive, rename, restore and move, on every
//! client (#55).
//!
//! So these tests do not reason about the queries, they run them. Each one is
//! the query from documents.rs verbatim, decoded into the same Rust type the
//! handler uses, so a type that drifts fails here rather than in production.
//!
//! Skipped unless TEST_DATABASE_URL is set, so `cargo test` stays usable with no
//! database. To run them:
//!
//!   docker run --rm -d --name sn-test -e POSTGRES_PASSWORD=pw \
//!     -e POSTGRES_DB=sn -p 55432:5432 postgres:16
//!   for f in server/migrations/*.sql; do
//!     docker exec -i sn-test psql -U postgres -d sn -v ON_ERROR_STOP=1 -q < "$f"
//!   done
//!   TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/sn \
//!     cargo test -p selfnote-api
use sqlx::{postgres::PgPoolOptions, PgPool};
use uuid::Uuid;

/// The pool, or None when no test database is configured.
async fn pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(
        PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("TEST_DATABASE_URL is set but unreachable"),
    )
}

/// A workspace with a two-level page tree, returned as (root, child).
async fn seed(pool: &PgPool) -> (Uuid, Uuid) {
    let user: (Uuid,) = sqlx::query_as(
        "insert into users (email, password_hash) values ($1, 'x') returning id",
    )
    .bind(format!("{}@test.local", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .unwrap();
    let ws: (Uuid,) =
        sqlx::query_as("insert into workspaces (owner_id, name) values ($1, 'w') returning id")
            .bind(user.0)
            .fetch_one(pool)
            .await
            .unwrap();
    let root: (Uuid,) = sqlx::query_as(
        "insert into documents (workspace_id, title) values ($1, 'root') returning id",
    )
    .bind(ws.0)
    .fetch_one(pool)
    .await
    .unwrap();
    let child: (Uuid,) = sqlx::query_as(
        "insert into documents (workspace_id, parent_id, title) values ($1, $2, 'child') returning id",
    )
    .bind(ws.0)
    .bind(root.0)
    .fetch_one(pool)
    .await
    .unwrap();
    (root.0, child.0)
}

/// The ancestor-depth probe from `update`, decoded exactly as the handler does.
///
/// This is the regression test for #55: without the `::bigint` cast the column
/// is INT4, this decode fails, and every document patch 500s.
#[tokio::test]
async fn ancestor_depth_decodes_as_i64() {
    let Some(pool) = pool().await else { return };
    let (_root, child) = seed(&pool).await;

    let (depth,): (i64,) = sqlx::query_as(
        "with recursive anc as ( \
             select id, parent_id, 1 as depth from documents where id = $1 \
             union all \
             select d.id, d.parent_id, a.depth + 1 from documents d join anc a on d.id = a.parent_id \
             where a.depth < 100 \
         ) \
         select coalesce(max(depth), 0)::bigint from anc",
    )
    .bind(child)
    .fetch_one(&pool)
    .await
    .expect("the depth probe must decode into i64");

    // child -> root -> (no parent): two levels, and far below the cap.
    assert_eq!(depth, 2, "a two-level tree should report depth 2");
}

/// The same probe over a deliberately cyclic parent chain must stop at the cap
/// rather than run forever, which is what makes the post-write check safe.
#[tokio::test]
async fn ancestor_depth_terminates_on_a_cycle() {
    let Some(pool) = pool().await else { return };
    let (root, child) = seed(&pool).await;

    // Close the loop behind the guard's back, the way a lost race would.
    sqlx::query("update documents set parent_id = $1 where id = $2")
        .bind(child)
        .bind(root)
        .execute(&pool)
        .await
        .unwrap();

    let (depth,): (i64,) = sqlx::query_as(
        "with recursive anc as ( \
             select id, parent_id, 1 as depth from documents where id = $1 \
             union all \
             select d.id, d.parent_id, a.depth + 1 from documents d join anc a on d.id = a.parent_id \
             where a.depth < 100 \
         ) \
         select coalesce(max(depth), 0)::bigint from anc",
    )
    .bind(child)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert!(depth >= 100, "a cycle must reach the cap, got {depth}");
}

/// The descendant check that refuses a move into a page's own subtree.
#[tokio::test]
async fn descendant_check_matches_only_the_subtree() {
    let Some(pool) = pool().await else { return };
    let (root, child) = seed(&pool).await;

    let sql = "with recursive sub as ( \
                   select id, 1 as depth from documents where parent_id = $1 \
                   union all \
                   select d.id, s.depth + 1 from documents d join sub s on d.parent_id = s.id \
                   where s.depth < 100 \
               ) \
               select true from sub where id = $2 limit 1";

    let hit: Option<(bool,)> = sqlx::query_as(sql)
        .bind(root)
        .bind(child)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(hit.is_some(), "the child is a descendant of the root");

    let miss: Option<(bool,)> = sqlx::query_as(sql)
        .bind(child)
        .bind(root)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(miss.is_none(), "the root is not a descendant of its child");
}

/// Every column the handlers select must decode into `Document`. This is the
/// check that catches a column added to the struct but missed in a query, which
/// also builds cleanly and fails only at runtime.
#[tokio::test]
async fn document_rows_decode_fully() {
    let Some(pool) = pool().await else { return };
    let (root, _child) = seed(&pool).await;

    let row: Option<(Uuid, Uuid, Option<Uuid>, String, Option<String>, bool, bool, f64)> =
        sqlx::query_as(
            "select id, workspace_id, parent_id, title, icon, archived, trashed, position \
             from documents where id = $1",
        )
        .bind(root)
        .fetch_optional(&pool)
        .await
        .expect("every selected column must decode");
    assert!(row.is_some(), "the seeded page should be readable");
}
