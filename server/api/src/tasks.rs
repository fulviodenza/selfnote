//! Calendar & task sync. Any document can be promoted to a *task* (a 1:1 sidecar
//! row in `document_tasks`) with a status, priority, and due date; those tasks are
//! surfaced by an agenda query (`GET /tasks`) and published as a per-workspace
//! read-only iCal feed subscribable from Google/Apple/Outlook calendars.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

/// A task: the sidecar `document_tasks` row joined with its document's title/icon.
#[derive(Debug, Serialize, FromRow)]
pub struct Task {
    pub doc_id: Uuid,
    pub workspace_id: Uuid,
    /// Mirrored from `documents.title` (read-only here).
    pub title: String,
    /// Mirrored from `documents.icon` (read-only here).
    pub icon: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_at: Option<DateTime<Utc>>,
    pub due_all_day: bool,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const TASK_SELECT: &str = "select t.doc_id, t.workspace_id, d.title, d.icon, \
     t.status, t.priority, t.due_at, t.due_all_day, t.completed_at, \
     t.created_at, t.updated_at \
     from document_tasks t join documents d on d.id = t.doc_id";

fn valid_status(s: &str) -> bool {
    matches!(s, "todo" | "in_progress" | "done")
}

fn valid_priority(s: &str) -> bool {
    matches!(s, "none" | "low" | "medium" | "high")
}

/// Load a document and assert the caller may write to its workspace (member with a
/// role other than `viewer`). `404` if the document is missing, `403` otherwise.
async fn authorize_writer(state: &AppState, user_id: Uuid, doc_id: Uuid) -> ApiResult<Uuid> {
    let ws: Option<(Uuid,)> = sqlx::query_as("select workspace_id from documents where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let workspace_id = ws.ok_or(AppError::NotFound)?.0;
    match member_role(state, workspace_id, user_id).await? {
        Some(r) if r != "viewer" => Ok(workspace_id),
        _ => Err(AppError::Forbidden),
    }
}

async fn load_task(state: &AppState, doc_id: Uuid) -> ApiResult<Task> {
    let task: Option<Task> = sqlx::query_as(&format!("{TASK_SELECT} where t.doc_id = $1"))
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    task.ok_or(AppError::NotFound)
}

/* ---------------------------------------------------------- promote / get -- */

#[derive(Debug, Deserialize)]
pub struct SetTask {
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, with = "serde_with_due")]
    pub due_at: DueField,
    pub due_all_day: Option<bool>,
}

/// `POST /documents/:id/task` — promote a document to a task (idempotent upsert).
/// Provided fields are updated; omitted fields keep their current value (or the
/// default on first promotion).
pub async fn set_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<SetTask>,
) -> ApiResult<Json<Task>> {
    let workspace_id = authorize_writer(&state, user.id, doc_id).await?;

    if let Some(s) = &body.status {
        if !valid_status(s) {
            return Err(AppError::BadRequest("invalid status".into()));
        }
    }
    if let Some(p) = &body.priority {
        if !valid_priority(p) {
            return Err(AppError::BadRequest("invalid priority".into()));
        }
    }

    let existing: Option<Task> = sqlx::query_as(&format!("{TASK_SELECT} where t.doc_id = $1"))
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;

    let status = body
        .status
        .clone()
        .or_else(|| existing.as_ref().map(|t| t.status.clone()))
        .unwrap_or_else(|| "todo".to_string());
    let priority = body
        .priority
        .clone()
        .or_else(|| existing.as_ref().map(|t| t.priority.clone()))
        .unwrap_or_else(|| "none".to_string());
    let due_all_day = body
        .due_all_day
        .or_else(|| existing.as_ref().map(|t| t.due_all_day))
        .unwrap_or(false);
    let due_at = match &body.due_at {
        DueField::Missing => existing.as_ref().and_then(|t| t.due_at),
        DueField::Null => None,
        DueField::Set(v) => Some(*v),
    };
    // completed_at follows status: set when done, cleared otherwise.
    let completed_at: Option<DateTime<Utc>> = if status == "done" {
        existing
            .as_ref()
            .filter(|t| t.status == "done")
            .and_then(|t| t.completed_at)
            .or_else(|| Some(Utc::now()))
    } else {
        None
    };

    sqlx::query(
        "insert into document_tasks \
             (doc_id, workspace_id, status, priority, due_at, due_all_day, completed_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, now()) \
         on conflict (doc_id) do update set \
             status = excluded.status, priority = excluded.priority, \
             due_at = excluded.due_at, due_all_day = excluded.due_all_day, \
             completed_at = excluded.completed_at, updated_at = now()",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&status)
    .bind(&priority)
    .bind(due_at)
    .bind(due_all_day)
    .bind(completed_at)
    .execute(&state.pool)
    .await?;

    Ok(Json(load_task(&state, doc_id).await?))
}

/// `GET /documents/:id/task` — a document's task metadata (any member).
pub async fn get_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<Task>> {
    let ws: Option<(Uuid,)> = sqlx::query_as("select workspace_id from documents where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let workspace_id = ws.ok_or(AppError::NotFound)?.0;
    if member_role(&state, workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(Json(load_task(&state, doc_id).await?))
}

#[derive(Debug, Deserialize)]
pub struct UpdateTask {
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, with = "serde_with_due")]
    pub due_at: DueField,
    pub due_all_day: Option<bool>,
}

/// `PATCH /documents/:id/task` — update a task. Only present keys change; an
/// explicit `null` `due_at` clears the due date. `completed_at` is set/cleared as
/// `status` crosses to/from `done`.
pub async fn update_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<UpdateTask>,
) -> ApiResult<Json<Task>> {
    authorize_writer(&state, user.id, doc_id).await?;

    if let Some(s) = &body.status {
        if !valid_status(s) {
            return Err(AppError::BadRequest("invalid status".into()));
        }
    }
    if let Some(p) = &body.priority {
        if !valid_priority(p) {
            return Err(AppError::BadRequest("invalid priority".into()));
        }
    }

    let existing = load_task(&state, doc_id).await?;

    let status = body.status.clone().unwrap_or(existing.status.clone());
    let priority = body.priority.clone().unwrap_or(existing.priority.clone());
    let due_all_day = body.due_all_day.unwrap_or(existing.due_all_day);
    let due_at = match &body.due_at {
        DueField::Missing => existing.due_at,
        DueField::Null => None,
        DueField::Set(v) => Some(*v),
    };
    let completed_at: Option<DateTime<Utc>> = if status == "done" {
        if existing.status == "done" {
            existing.completed_at
        } else {
            Some(Utc::now())
        }
    } else {
        None
    };

    sqlx::query(
        "update document_tasks set \
             status = $2, priority = $3, due_at = $4, due_all_day = $5, \
             completed_at = $6, updated_at = now() \
         where doc_id = $1",
    )
    .bind(doc_id)
    .bind(&status)
    .bind(&priority)
    .bind(due_at)
    .bind(due_all_day)
    .bind(completed_at)
    .execute(&state.pool)
    .await?;

    Ok(Json(load_task(&state, doc_id).await?))
}

/// `DELETE /documents/:id/task` — demote (remove task metadata; the document is
/// untouched). Idempotent: `204` even if it was not a task.
pub async fn delete_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    authorize_writer(&state, user.id, doc_id).await?;
    sqlx::query("delete from document_tasks where doc_id = $1")
        .bind(doc_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ------------------------------------------------------------- list/agenda -- */

#[derive(Debug, Deserialize)]
pub struct ListTasksQuery {
    pub workspace_id: Uuid,
    pub status: Option<String>,
    pub due_before: Option<DateTime<Utc>>,
    pub due_after: Option<DateTime<Utc>>,
    pub include_undated: Option<bool>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ListTasksResponse {
    pub tasks: Vec<Task>,
}

/// `GET /tasks` — the agenda query for a workspace (any member).
pub async fn list_tasks(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListTasksQuery>,
) -> ApiResult<Json<ListTasksResponse>> {
    if member_role(&state, q.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }

    // Validate the status filter CSV up front.
    let statuses: Vec<String> = match &q.status {
        Some(s) => {
            let list: Vec<String> = s
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect();
            for v in &list {
                if !valid_status(v) {
                    return Err(AppError::BadRequest("invalid status filter".into()));
                }
            }
            list
        }
        None => Vec::new(),
    };

    let include_undated = q.include_undated.unwrap_or(true);
    let limit = match q.limit {
        Some(n) if !(1..=500).contains(&n) => {
            return Err(AppError::BadRequest("limit must be between 1 and 500".into()))
        }
        Some(n) => n,
        None => 200,
    };

    let order = match q.sort.as_deref().unwrap_or("due_at") {
        "due_at" => "t.due_at asc nulls last, t.created_at asc",
        // high→low; nulls (none) last via the mapped ordinal.
        "priority" => {
            "case t.priority when 'high' then 0 when 'medium' then 1 \
             when 'low' then 2 else 3 end asc, t.due_at asc nulls last"
        }
        "created_at" => "t.created_at asc",
        _ => return Err(AppError::BadRequest("invalid sort".into())),
    };

    // Build the WHERE clause with numbered binds. $1 is always workspace_id.
    let mut sql = format!("{TASK_SELECT} where t.workspace_id = $1");
    let mut next = 2;
    let (status_placeholder, due_before_idx, due_after_idx);
    if !statuses.is_empty() {
        status_placeholder = next;
        sql.push_str(&format!(" and t.status = any(${status_placeholder})"));
        next += 1;
    } else {
        status_placeholder = 0;
    }
    if q.due_before.is_some() {
        due_before_idx = next;
        // Undated tasks are governed by include_undated, not the due-window bounds.
        sql.push_str(&format!(
            " and (t.due_at <= ${due_before_idx}{})",
            if include_undated { " or t.due_at is null" } else { "" }
        ));
        next += 1;
    } else {
        due_before_idx = 0;
    }
    if q.due_after.is_some() {
        due_after_idx = next;
        sql.push_str(&format!(
            " and (t.due_at >= ${due_after_idx}{})",
            if include_undated { " or t.due_at is null" } else { "" }
        ));
        next += 1;
    } else {
        due_after_idx = 0;
    }
    if !include_undated {
        sql.push_str(" and t.due_at is not null");
    }
    let limit_idx = next;
    sql.push_str(&format!(" order by {order} limit ${limit_idx}"));

    let mut query = sqlx::query_as::<_, Task>(&sql).bind(q.workspace_id);
    if status_placeholder != 0 {
        query = query.bind(statuses);
    }
    if due_before_idx != 0 {
        query = query.bind(q.due_before);
    }
    if due_after_idx != 0 {
        query = query.bind(q.due_after);
    }
    query = query.bind(limit);

    let tasks = query.fetch_all(&state.pool).await?;
    Ok(Json(ListTasksResponse { tasks }))
}

/* ------------------------------------------------------------- feed tokens -- */

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn random_feed_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("cal_{}", hex::encode(bytes))
}

#[derive(Debug, Serialize)]
pub struct IssuedFeed {
    /// Plaintext feed token, shown exactly once.
    pub token: String,
    /// Relative ICS URL; the client prefixes `API_BASE`.
    pub url: String,
}

/// `POST /workspaces/:id/calendar-feed` — issue/rotate the caller's ICS feed token
/// for a workspace. Deletes any existing rows for this workspace+user and mints a
/// fresh one, invalidating the old URL.
pub async fn issue_feed(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<IssuedFeed>> {
    match member_role(&state, workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }

    let token = random_feed_token();
    let hash = sha256_hex(&token);

    let mut tx = state.pool.begin().await?;
    sqlx::query("delete from calendar_feed_tokens where workspace_id = $1 and user_id = $2")
        .bind(workspace_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "insert into calendar_feed_tokens (workspace_id, user_id, token_hash) \
         values ($1, $2, $3)",
    )
    .bind(workspace_id)
    .bind(user.id)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(IssuedFeed {
        url: format!("/calendar/{workspace_id}/{token}.ics"),
        token,
    }))
}

/// `DELETE /workspaces/:id/calendar-feed` — revoke all feed tokens for this
/// workspace+user. Idempotent `204`.
pub async fn revoke_feed(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    match member_role(&state, workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }
    sqlx::query("delete from calendar_feed_tokens where workspace_id = $1 and user_id = $2")
        .bind(workspace_id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /workspaces/:id/calendar-feed` — whether a feed exists (never returns the
/// plaintext token). The reported `url` uses the token *id* placeholder for display
/// only; the working URL is the one returned at issue time.
pub async fn get_feed(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    if member_role(&state, workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let row: Option<(Uuid, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select id, created_at, last_used_at from calendar_feed_tokens \
         where workspace_id = $1 and user_id = $2 order by created_at desc limit 1",
    )
    .bind(workspace_id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?;

    match row {
        Some((id, created_at, last_used_at)) => Ok(Json(json!({
            "enabled": true,
            "url": format!("/calendar/{workspace_id}/{id}.ics"),
            "created_at": created_at,
            "last_used_at": last_used_at,
        }))),
        None => Ok(Json(json!({ "enabled": false }))),
    }
}

/* -------------------------------------------------------------- public ICS -- */

/// A dated task plus its workspace name, projected for the ICS feed.
#[derive(Debug, FromRow)]
struct IcsTask {
    doc_id: Uuid,
    title: String,
    status: String,
    priority: String,
    due_at: DateTime<Utc>,
    due_all_day: bool,
    updated_at: DateTime<Utc>,
}

/// `GET /calendar/:workspace_id/:token.ics` — public ICS feed (token in the path;
/// no `Authorization` header). Every non-archived, dated task becomes a `VEVENT`.
/// Unknown/bad/revoked tokens return an indistinguishable `404`.
pub async fn ics_feed(
    State(state): State<AppState>,
    Path((workspace_id, token_file)): Path<(Uuid, String)>,
) -> ApiResult<Response> {
    // `:token.ics` — strip the extension to recover the plaintext token.
    let token = token_file.strip_suffix(".ics").unwrap_or(&token_file);
    let hash = sha256_hex(token);

    // Match the token to this workspace and stamp last-used. A non-match is an
    // opaque 404 (do not leak whether the workspace or the token was wrong).
    let matched: Option<(Uuid,)> = sqlx::query_as(
        "update calendar_feed_tokens set last_used_at = now() \
         where workspace_id = $1 and token_hash = $2 returning id",
    )
    .bind(workspace_id)
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    if matched.is_none() {
        return Err(AppError::NotFound);
    }

    let ws_name: (String,) = sqlx::query_as("select name from workspaces where id = $1")
        .bind(workspace_id)
        .fetch_one(&state.pool)
        .await?;

    let tasks: Vec<IcsTask> = sqlx::query_as(
        "select t.doc_id, d.title, t.status, t.priority, t.due_at, t.due_all_day, t.updated_at \
         from document_tasks t join documents d on d.id = t.doc_id \
         where t.workspace_id = $1 and not d.archived and t.due_at is not null \
         order by t.due_at",
    )
    .bind(workspace_id)
    .fetch_all(&state.pool)
    .await?;

    let body = render_ics(&ws_name.0, &tasks);

    let mut resp = Response::new(Body::from(body));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/calendar; charset=utf-8"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"selfnote.ics\""),
    );
    Ok(resp)
}

/// Escape a text value per RFC 5545 (backslash, comma, semicolon, newline).
fn ics_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

fn ics_datetime(dt: &DateTime<Utc>) -> String {
    dt.format("%Y%m%dT%H%M%SZ").to_string()
}

fn ics_date(dt: &DateTime<Utc>) -> String {
    dt.format("%Y%m%d").to_string()
}

/// Render the RFC 5545 iCalendar body. One `VEVENT` per dated task.
fn render_ics(workspace_name: &str, tasks: &[IcsTask]) -> String {
    let mut out = String::new();
    out.push_str("BEGIN:VCALENDAR\r\n");
    out.push_str("PRODID:-//Selfnote//Calendar//EN\r\n");
    out.push_str("VERSION:2.0\r\n");
    out.push_str("CALSCALE:GREGORIAN\r\n");
    out.push_str(&format!("X-WR-CALNAME:{}\r\n", ics_escape(workspace_name)));

    for t in tasks {
        out.push_str("BEGIN:VEVENT\r\n");
        out.push_str(&format!("UID:{}@selfnote\r\n", t.doc_id));

        let marker = if t.status == "done" { "✔ " } else { "" };
        out.push_str(&format!(
            "SUMMARY:{}{}\r\n",
            marker,
            ics_escape(&t.title)
        ));

        if t.due_all_day {
            out.push_str(&format!("DTSTART;VALUE=DATE:{}\r\n", ics_date(&t.due_at)));
        } else {
            out.push_str(&format!("DTSTART:{}\r\n", ics_datetime(&t.due_at)));
            let end = t.due_at + chrono::Duration::minutes(30);
            out.push_str(&format!("DTEND:{}\r\n", ics_datetime(&end)));
        }

        let status = if t.status == "done" {
            "CONFIRMED"
        } else {
            "NEEDS-ACTION"
        };
        out.push_str(&format!("STATUS:{status}\r\n"));

        let priority = match t.priority.as_str() {
            "high" => 1,
            "medium" => 5,
            "low" => 9,
            _ => 0,
        };
        out.push_str(&format!("PRIORITY:{priority}\r\n"));

        out.push_str(&format!("DTSTAMP:{}\r\n", ics_datetime(&t.updated_at)));
        out.push_str(&format!("LAST-MODIFIED:{}\r\n", ics_datetime(&t.updated_at)));
        out.push_str("END:VEVENT\r\n");
    }

    out.push_str("END:VCALENDAR\r\n");
    out
}

/// Three-way state for an optional-and-nullable `due_at` field: absent from the
/// JSON body, present as an explicit `null` (clear), or a concrete instant.
#[derive(Debug, Default)]
pub enum DueField {
    #[default]
    Missing,
    Null,
    Set(DateTime<Utc>),
}

/// serde adapter letting `#[serde(default, with = ...)]` distinguish a missing key
/// (`Missing`) from an explicit `null` (`Null`).
mod serde_with_due {
    use super::DueField;
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DueField, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt = Option::<DateTime<Utc>>::deserialize(deserializer)?;
        Ok(match opt {
            Some(v) => DueField::Set(v),
            None => DueField::Null,
        })
    }
}
