//! Workspace CRUD and membership.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

#[derive(Debug, Serialize, FromRow)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspace {
    pub name: String,
}

/// Return the caller's role in a workspace, or None if not a member.
pub async fn member_role(
    state: &AppState,
    workspace_id: Uuid,
    user_id: Uuid,
) -> ApiResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "select role from workspace_members where workspace_id = $1 and user_id = $2",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|r| r.0))
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<Workspace>>> {
    let rows: Vec<Workspace> = sqlx::query_as(
        "select w.id, w.name, w.owner_id, w.created_at from workspaces w \
         join workspace_members m on m.workspace_id = w.id \
         where m.user_id = $1 order by w.created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateWorkspace>,
) -> ApiResult<Json<Workspace>> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("workspace name required".into()));
    }
    let mut tx = state.pool.begin().await?;

    let ws: Workspace = sqlx::query_as(
        "insert into workspaces (name, owner_id) values ($1, $2) \
         returning id, name, owner_id, created_at",
    )
    .bind(body.name.trim())
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')",
    )
    .bind(ws.id)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(Json(ws))
}

#[derive(Debug, Deserialize)]
pub struct AddMember {
    pub email: String,
    pub role: String,
}

pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<AddMember>,
) -> ApiResult<Json<serde_json::Value>> {
    let role = match body.role.as_str() {
        "admin" | "editor" | "viewer" => body.role.as_str(),
        _ => return Err(AppError::BadRequest("invalid role".into())),
    };
    match member_role(&state, workspace_id, user.id).await? {
        Some(r) if r == "owner" || r == "admin" => {}
        Some(_) => return Err(AppError::Forbidden),
        None => return Err(AppError::NotFound),
    }

    let target: Option<(Uuid,)> = sqlx::query_as("select id from users where email = $1")
        .bind(body.email.trim())
        .fetch_optional(&state.pool)
        .await?;
    let target_id = target.ok_or_else(|| AppError::BadRequest("no such user".into()))?.0;

    sqlx::query(
        "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3) \
         on conflict (workspace_id, user_id) do update set role = excluded.role",
    )
    .bind(workspace_id)
    .bind(target_id)
    .bind(role)
    .execute(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
