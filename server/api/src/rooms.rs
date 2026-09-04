//! Room-token issuance. The client asks the API "may I open document X?"; the API
//! checks permissions and returns a short-lived JWT the sync server will accept.

use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use selfnote_common::{RoomClaims, RoomMode};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

#[derive(Debug, Serialize)]
pub struct RoomToken {
    pub token: String,
    pub doc_id: Uuid,
    pub mode: &'static str,
    pub expires_in: usize,
}

pub async fn issue(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<RoomToken>> {
    // Resolve the document's workspace and the caller's role.
    let ws: Option<(Uuid,)> = sqlx::query_as("select workspace_id from documents where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let workspace_id = ws.ok_or(AppError::NotFound)?.0;

    let role = member_role(&state, workspace_id, user.id)
        .await?
        .ok_or(AppError::Forbidden)?;

    let mode = if role == "viewer" {
        RoomMode::ReadOnly
    } else {
        RoomMode::ReadWrite
    };

    let now = Utc::now().timestamp() as usize;
    let claims = RoomClaims {
        doc: doc_id.to_string(),
        sub: user.id.to_string(),
        mode,
        exp: now + state.room_ttl,
    };
    let token = selfnote_common::sign(&claims, &state.room_secret)
        .map_err(|e| AppError::Other(anyhow::anyhow!("room token sign: {e}")))?;

    Ok(Json(RoomToken {
        token,
        doc_id,
        mode: match mode {
            RoomMode::ReadOnly => "ro",
            RoomMode::ReadWrite => "rw",
        },
        expires_in: state.room_ttl,
    }))
}
