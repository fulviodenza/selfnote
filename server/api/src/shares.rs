//! Public share links. An editor creates a link for a document; anyone with the
//! link can resolve it (no account) to receive a scoped room token and open the
//! document read-only or read-write via the sync server.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use selfnote_common::{RoomClaims, RoomMode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

fn default_mode() -> String {
    "ro".to_string()
}

#[derive(Debug, Deserialize)]
pub struct CreateShare {
    #[serde(default = "default_mode")]
    pub mode: String,
    pub expires_in_days: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ShareInfo {
    pub id: Uuid,
    pub doc_id: Uuid,
    pub mode: String,
    pub url: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<CreateShare>,
) -> ApiResult<Json<ShareInfo>> {
    let mode = match body.mode.as_str() {
        "ro" | "rw" => body.mode.as_str(),
        _ => return Err(AppError::BadRequest("mode must be 'ro' or 'rw'".into())),
    };

    let ws: Option<(Uuid,)> = sqlx::query_as("select workspace_id from documents where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let workspace_id = ws.ok_or(AppError::NotFound)?.0;
    match member_role(&state, workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }

    let expires: Option<DateTime<Utc>> = body.expires_in_days.map(|d| Utc::now() + Duration::days(d));

    let row: (Uuid,) =
        sqlx::query_as("insert into shares (doc_id, mode, expires_at) values ($1, $2, $3) returning id")
            .bind(doc_id)
            .bind(mode)
            .bind(expires)
            .fetch_one(&state.pool)
            .await?;

    Ok(Json(ShareInfo {
        id: row.0,
        doc_id,
        mode: mode.to_string(),
        url: format!("/shared/{}", row.0),
    }))
}

#[derive(Debug, Serialize)]
pub struct ResolvedShare {
    pub doc_id: Uuid,
    pub mode: String,
    /// Room token the visitor uses to open the document via the sync server.
    pub token: String,
    pub expires_in: usize,
}

/// Resolve a share link (no authentication) into a scoped room token.
pub async fn resolve(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ResolvedShare>> {
    let row: Option<(Uuid, String, Option<DateTime<Utc>>)> =
        sqlx::query_as("select doc_id, mode, expires_at from shares where id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let (doc_id, mode, expires) = row.ok_or(AppError::NotFound)?;
    if let Some(exp) = expires {
        if exp < Utc::now() {
            return Err(AppError::NotFound);
        }
    }

    let room_mode = if mode == "rw" {
        RoomMode::ReadWrite
    } else {
        RoomMode::ReadOnly
    };
    let now = Utc::now().timestamp() as usize;
    let claims = RoomClaims {
        doc: doc_id.to_string(),
        sub: format!("share:{id}"),
        mode: room_mode,
        exp: now + state.room_ttl,
    };
    let token = selfnote_common::sign(&claims, &state.room_secret)
        .map_err(|e| AppError::Other(anyhow::anyhow!("share token sign: {e}")))?;

    Ok(Json(ResolvedShare {
        doc_id,
        mode,
        token,
        expires_in: state.room_ttl,
    }))
}
