//! Document (page) tree CRUD.

use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

#[derive(Debug, Serialize, FromRow)]
pub struct Document {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub title: String,
    pub icon: Option<String>,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub workspace_id: Uuid,
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    if member_role(&state, q.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let rows: Vec<Document> = sqlx::query_as(
        "select id, workspace_id, parent_id, title, icon, archived, created_at, updated_at \
         from documents where workspace_id = $1 and not archived order by created_at",
    )
    .bind(q.workspace_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub workspace_id: Uuid,
    pub q: String,
}

/// Full-text search over document titles within a workspace (Postgres FTS).
pub async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<Document>>> {
    if member_role(&state, q.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let rows: Vec<Document> = sqlx::query_as(
        "select id, workspace_id, parent_id, title, icon, archived, created_at, updated_at \
         from documents \
         where workspace_id = $1 and not archived \
           and to_tsvector('english', title) @@ websearch_to_tsquery('english', $2) \
         order by ts_rank(to_tsvector('english', title), websearch_to_tsquery('english', $2)) desc \
         limit 50",
    )
    .bind(q.workspace_id)
    .bind(&q.q)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct CreateDocument {
    pub workspace_id: Uuid,
    pub parent_id: Option<Uuid>,
    #[serde(default)]
    pub title: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateDocument>,
) -> ApiResult<Json<Document>> {
    match member_role(&state, body.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        Some(_) => return Err(AppError::Forbidden),
        None => return Err(AppError::Forbidden),
    }
    let title = body.title.unwrap_or_else(|| "Untitled".to_string());
    let doc: Document = sqlx::query_as(
        "insert into documents (workspace_id, parent_id, title) values ($1, $2, $3) \
         returning id, workspace_id, parent_id, title, icon, archived, created_at, updated_at",
    )
    .bind(body.workspace_id)
    .bind(body.parent_id)
    .bind(title)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(doc))
}

#[derive(Debug, Deserialize)]
pub struct DocContent {
    /// Base64-encoded Yjs update to append to the document's log (used by import).
    pub update: String,
}

/// Seed a document's CRDT content by appending an update to its log. Used by the
/// Obsidian importer to populate freshly-created pages without opening a socket.
pub async fn set_content(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<DocContent>,
) -> ApiResult<axum::http::StatusCode> {
    let doc = load_document(&state, doc_id).await?;
    match member_role(&state, doc.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }
    append_update(&state, doc_id, &body.update).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
pub struct DocContentOut {
    /// The document's current CRDT state as an ordered list of base64 Yjs updates
    /// (snapshot first if present, then the update log). Apply them in order to
    /// reconstruct the doc — used by the MCP server to read-modify-write a note.
    pub updates: Vec<String>,
}

pub async fn get_content(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<DocContentOut>> {
    let doc = load_document(&state, doc_id).await?;
    if member_role(&state, doc.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let updates = load_content_updates(&state, doc_id).await?;
    Ok(Json(DocContentOut { updates }))
}

/// A document's current CRDT state as an ordered list of base64 Yjs updates
/// (snapshot first if present, then the update log). Reused by `get_content` and
/// by the AI-proposal path, which reconstructs the doc to compute a diff.
pub async fn load_content_updates(state: &AppState, doc_id: Uuid) -> ApiResult<Vec<String>> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut updates = Vec::new();

    // A compacted snapshot (if any) covers the log up to last_update_id; only the
    // rows after it are still in doc_updates.
    let snap: Option<(Vec<u8>, i64)> =
        sqlx::query_as("select snapshot, last_update_id from doc_snapshots where doc_id = $1")
            .bind(doc_id)
            .fetch_optional(&state.pool)
            .await?;
    let since = match snap {
        Some((snapshot, last_id)) => {
            updates.push(b64.encode(&snapshot));
            last_id
        }
        None => 0,
    };

    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("select update from doc_updates where doc_id = $1 and id > $2 order by id")
            .bind(doc_id)
            .bind(since)
            .fetch_all(&state.pool)
            .await?;
    for (u,) in rows {
        updates.push(b64.encode(&u));
    }
    Ok(updates)
}

/// Append a base64 Yjs update to a document's content log (the same mutation as
/// `set_content`). Used when an AI edit proposal is accepted.
pub async fn append_update(state: &AppState, doc_id: Uuid, update_base64: &str) -> ApiResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(update_base64.as_bytes())
        .map_err(|_| AppError::BadRequest("invalid base64 update".into()))?;
    sqlx::query("insert into doc_updates (doc_id, update) values ($1, $2)")
        .bind(doc_id)
        .bind(&bytes)
        .execute(&state.pool)
        .await?;
    Ok(())
}

/// Load a document by id, `404` if missing. Exposed for the AI-proposal module.
pub async fn get_document(state: &AppState, doc_id: Uuid) -> ApiResult<Document> {
    load_document(state, doc_id).await
}

async fn load_document(state: &AppState, doc_id: Uuid) -> ApiResult<Document> {
    let doc: Option<Document> = sqlx::query_as(
        "select id, workspace_id, parent_id, title, icon, archived, created_at, updated_at \
         from documents where id = $1",
    )
    .bind(doc_id)
    .fetch_optional(&state.pool)
    .await?;
    doc.ok_or(AppError::NotFound)
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<Document>> {
    let doc = load_document(&state, doc_id).await?;
    if member_role(&state, doc.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(Json(doc))
}

#[derive(Debug, Deserialize)]
pub struct UpdateDocument {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub parent_id: Option<Option<Uuid>>,
    pub archived: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<UpdateDocument>,
) -> ApiResult<Json<Document>> {
    let doc = load_document(&state, doc_id).await?;
    match member_role(&state, doc.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }

    let title = body.title.unwrap_or(doc.title);
    let icon = body.icon.or(doc.icon);
    let parent_id = body.parent_id.unwrap_or(doc.parent_id);
    let archived = body.archived.unwrap_or(doc.archived);

    let updated: Document = sqlx::query_as(
        "update documents set title = $2, icon = $3, parent_id = $4, archived = $5, updated_at = now() \
         where id = $1 \
         returning id, workspace_id, parent_id, title, icon, archived, created_at, updated_at",
    )
    .bind(doc_id)
    .bind(title)
    .bind(icon)
    .bind(parent_id)
    .bind(archived)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(updated))
}

/* ----------------------------------------------- multi-note context ------- */

/// How many recently-viewed rows to keep per user; older ones are trimmed on write.
const RECENT_KEEP: i64 = 50;

/// Load a doc and assert the caller is a member (any role) of its workspace.
/// `404` if the doc is missing, `403` if the caller can't access it.
async fn authorize_member(state: &AppState, user_id: Uuid, doc_id: Uuid) -> ApiResult<Document> {
    let doc = load_document(state, doc_id).await?;
    if member_role(state, doc.workspace_id, user_id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(doc)
}

/// `POST /documents/:id/viewed` — record a view. Idempotent upsert into
/// `recent_documents`, bumping `viewed_at` to now and trimming the caller's log
/// to the most recent `RECENT_KEEP` rows.
pub async fn mark_viewed(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    authorize_member(&state, user.id, doc_id).await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "insert into recent_documents (user_id, doc_id, viewed_at) values ($1, $2, now()) \
         on conflict (user_id, doc_id) do update set viewed_at = now()",
    )
    .bind(user.id)
    .bind(doc_id)
    .execute(&mut *tx)
    .await?;

    // Keep only the most recent `RECENT_KEEP` rows for this user.
    sqlx::query(
        "delete from recent_documents where user_id = $1 and doc_id not in ( \
             select doc_id from recent_documents where user_id = $1 \
             order by viewed_at desc limit $2 \
         )",
    )
    .bind(user.id)
    .bind(RECENT_KEEP)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct RecentQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RecentDocument {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub title: String,
    pub icon: Option<String>,
    pub viewed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RecentDocuments {
    pub documents: Vec<RecentDocument>,
}

/// `GET /documents/recent?limit=N` — the caller's recently-viewed, non-archived
/// documents, newest first. `limit` defaults to 10, clamped to `1..=50`. Rows
/// whose workspace the caller can no longer access are silently filtered.
pub async fn recent(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<RecentQuery>,
) -> ApiResult<Json<RecentDocuments>> {
    let limit = q.limit.unwrap_or(10).clamp(1, 50);
    let documents: Vec<RecentDocument> = sqlx::query_as(
        "select d.id, d.workspace_id, d.title, d.icon, r.viewed_at \
         from recent_documents r \
         join documents d on d.id = r.doc_id \
         join workspace_members m on m.workspace_id = d.workspace_id and m.user_id = $1 \
         where r.user_id = $1 and not d.archived \
         order by r.viewed_at desc \
         limit $2",
    )
    .bind(user.id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(RecentDocuments { documents }))
}

// Note-to-note links (backlinks & graph view) live in `crate::links`.
