//! File upload/serve. Small files (imported images) are stored inline in Postgres.
//! Upload requires workspace membership; download is public by opaque id so images
//! render in both private pages and public share links.

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderValue};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

#[derive(Debug, Deserialize)]
pub struct UploadQuery {
    pub workspace_id: Uuid,
    pub doc_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct UploadedFile {
    pub id: Uuid,
    pub url: String,
}

pub async fn upload(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<UploadQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<UploadedFile>> {
    if member_role(&state, q.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?
    {
        let mime = field
            .content_type()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let name = field.file_name().map(|s| s.to_string());
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("read: {e}")))?;
        let size = data.len() as i64;

        let row: (Uuid,) = sqlx::query_as(
            "insert into files (workspace_id, doc_id, mime, size, data, name) \
             values ($1, $2, $3, $4, $5, $6) returning id",
        )
        .bind(q.workspace_id)
        .bind(q.doc_id)
        .bind(&mime)
        .bind(size)
        .bind(&data[..])
        .bind(&name)
        .fetch_one(&state.pool)
        .await?;

        return Ok(Json(UploadedFile {
            id: row.0,
            url: format!("/api/files/{}", row.0),
        }));
    }

    Err(AppError::BadRequest("no file field in upload".into()))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct FileMeta {
    pub id: Uuid,
    pub doc_id: Option<Uuid>,
    pub name: Option<String>,
    pub mime: String,
    pub size: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// `GET /workspaces/:id/files` — the workspace's uploaded assets (metadata only),
/// newest first. Files owned by a trashed page are hidden (they come back if the
/// page is restored, and disappear for good when it is deleted forever).
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<Vec<FileMeta>>> {
    if member_role(&state, workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let rows: Vec<FileMeta> = sqlx::query_as(
        "select f.id, f.doc_id, f.name, f.mime, f.size, f.created_at from files f \
         left join documents d on d.id = f.doc_id \
         where f.workspace_id = $1 and (f.doc_id is null or not d.trashed) \
         order by f.created_at desc",
    )
    .bind(workspace_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// `DELETE /files/:id` — permanently delete one uploaded asset (editor+). Lets
/// the Assets view clean up files no page references (e.g. pre-association
/// uploads whose page is long gone).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<axum::http::StatusCode> {
    let row: Option<(Uuid,)> = sqlx::query_as("select workspace_id from files where id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let (workspace_id,) = row.ok_or(AppError::NotFound)?;
    match member_role(&state, workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }
    sqlx::query("delete from files where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn download(State(state): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<Response> {
    let row: Option<(Option<Vec<u8>>, String)> =
        sqlx::query_as("select data, mime from files where id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let (data, mime) = row.ok_or(AppError::NotFound)?;
    let data = data.ok_or(AppError::NotFound)?;

    let mut resp = Response::new(Body::from(data));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(resp)
}
