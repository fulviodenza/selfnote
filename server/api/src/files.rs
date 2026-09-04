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
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("read: {e}")))?;
        let size = data.len() as i64;

        let row: (Uuid,) = sqlx::query_as(
            "insert into files (workspace_id, doc_id, mime, size, data) \
             values ($1, $2, $3, $4, $5) returning id",
        )
        .bind(q.workspace_id)
        .bind(q.doc_id)
        .bind(&mime)
        .bind(size)
        .bind(&data[..])
        .fetch_one(&state.pool)
        .await?;

        return Ok(Json(UploadedFile {
            id: row.0,
            url: format!("/api/files/{}", row.0),
        }));
    }

    Err(AppError::BadRequest("no file field in upload".into()))
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
