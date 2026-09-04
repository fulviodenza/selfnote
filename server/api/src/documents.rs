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
    use base64::Engine;
    let doc = load_document(&state, doc_id).await?;
    match member_role(&state, doc.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.update.as_bytes())
        .map_err(|_| AppError::BadRequest("invalid base64 update".into()))?;
    sqlx::query("insert into doc_updates (doc_id, update) values ($1, $2)")
        .bind(doc_id)
        .bind(&bytes)
        .execute(&state.pool)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
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
