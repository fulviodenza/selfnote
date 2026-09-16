//! Calendar and task sync.
//!
//! A task is a row in `tasks` with a status, priority and due date, and every
//! task has a provenance:
//!
//!   * a **page task** (`block_id is null`) is a whole document promoted to a
//!     task, which is what this module modelled exclusively before;
//!   * an **inline task** is anchored to one block inside a page, so a note can
//!     hold many.
//!
//! The anchor itself lives in the note's CRDT as a prop on a `taskItem` block,
//! not here: `block_id` is for lookup and uniqueness. That direction matters.
//! Task state lives only in this table, so changing a status never requires the
//! server to write into a document, which it deliberately does not do outside
//! the proposals path. The converse is that only a client can tell whether an
//! anchoring block still exists, which is why `detached` is reported inward
//! rather than discovered here.
//!
//! Tasks are surfaced by an agenda query (`GET /tasks`, which also drives the
//! board and its page and label filters) and published as a per-workspace
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

/// A task, joined with the page it came from.
///
/// `block_id` carries the provenance: `None` means the page itself is the task
/// (what `document_tasks` used to model), `Some` means the task is anchored to
/// one block inside the page and the page may hold others.
#[derive(Debug, Serialize, FromRow)]
pub struct Task {
    pub id: Uuid,
    pub doc_id: Uuid,
    /// The anchoring block, or `None` for a page task.
    pub block_id: Option<String>,
    pub workspace_id: Uuid,
    /// The page title for a page task, the anchored block's text for an inline
    /// one. The latter is a cache the editing client refreshes, so the board can
    /// list tasks without opening any document.
    pub title: String,
    /// The containing page's title. Equal to `title` for a page task; for an
    /// inline task this is the provenance shown on its board card.
    pub doc_title: String,
    /// Mirrored from `documents.icon` (read-only here).
    pub icon: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_at: Option<DateTime<Utc>>,
    pub due_all_day: bool,
    pub completed_at: Option<DateTime<Utc>>,
    /// The anchoring block is gone from the page. Only a client can observe
    /// this, since the server never parses CRDT content.
    pub detached: bool,
    /// The containing page's labels. Labels are page-scoped, so an inline task
    /// inherits them; there are no per-task labels.
    pub label_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const TASK_SELECT: &str = "select t.id, t.doc_id, t.block_id, t.workspace_id, \
     case when t.block_id is null then d.title else t.title end as title, \
     d.title as doc_title, d.icon, \
     t.status, t.priority, t.due_at, t.due_all_day, t.completed_at, \
     (t.detached_at is not null) as detached, \
     coalesce(( \
         select array_agg(dl.label_id) from document_labels dl \
         where dl.document_id = t.doc_id \
     ), '{}') as label_ids, \
     t.created_at, t.updated_at \
     from tasks t join documents d on d.id = t.doc_id";

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

/// The page task for a document, if it has one.
///
/// Strictly `block_id is null`. `/documents/:id/task` is the old page-task API
/// and must never reach an inline task through it: a client built before inline
/// tasks existed would otherwise toggle an arbitrary one.
async fn load_task(state: &AppState, doc_id: Uuid) -> ApiResult<Task> {
    let task: Option<Task> = sqlx::query_as(&format!(
        "{TASK_SELECT} where t.doc_id = $1 and t.block_id is null"
    ))
    .bind(doc_id)
    .fetch_optional(&state.pool)
    .await?;
    task.ok_or(AppError::NotFound)
}

/// One task by id, with the caller's read access checked.
async fn load_task_by_id(state: &AppState, user_id: Uuid, id: Uuid) -> ApiResult<Task> {
    let task: Option<Task> = sqlx::query_as(&format!("{TASK_SELECT} where t.id = $1"))
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let task = task.ok_or(AppError::NotFound)?;
    if member_role(state, task.workspace_id, user_id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    Ok(task)
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

    let existing: Option<Task> = sqlx::query_as(&format!(
        "{TASK_SELECT} where t.doc_id = $1 and t.block_id is null"
    ))
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

    // The conflict target names the partial index, which is what preserves the
    // one-page-task-per-document invariant without constraining inline tasks.
    sqlx::query(
        "insert into tasks \
             (doc_id, workspace_id, block_id, status, priority, due_at, due_all_day, \
              completed_at, updated_at) \
         values ($1, $2, null, $3, $4, $5, $6, $7, now()) \
         on conflict (doc_id) where block_id is null do update set \
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
        "update tasks set \
             status = $2, priority = $3, due_at = $4, due_all_day = $5, \
             completed_at = $6, updated_at = now() \
         where doc_id = $1 and block_id is null",
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
    sqlx::query("delete from tasks where doc_id = $1 and block_id is null")
        .bind(doc_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ------------------------------------------------------------ inline tasks -- */

/// `GET /documents/:id/tasks` - every task on a page, the page task included.
///
/// The editor calls this on open to hydrate its `taskItem` blocks, and to
/// reconcile: any task whose block is no longer in the document is detached.
pub async fn list_doc_tasks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<ListTasksResponse>> {
    let ws: Option<(Uuid,)> = sqlx::query_as("select workspace_id from documents where id = $1")
        .bind(doc_id)
        .fetch_optional(&state.pool)
        .await?;
    let workspace_id = ws.ok_or(AppError::NotFound)?.0;
    if member_role(&state, workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let tasks: Vec<Task> = sqlx::query_as(&format!(
        "{TASK_SELECT} where t.doc_id = $1 order by t.block_id nulls first, t.created_at"
    ))
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListTasksResponse { tasks }))
}

#[derive(Debug, Deserialize)]
pub struct CreateInlineTask {
    /// The BlockNote block id this task is anchored to.
    pub block_id: String,
    /// The block's text, cached so the board need not open the document.
    pub title: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, with = "serde_with_due")]
    pub due_at: DueField,
    pub due_all_day: Option<bool>,
}

/// `POST /documents/:id/tasks` - make a task out of a block inside the page.
pub async fn create_inline_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<CreateInlineTask>,
) -> ApiResult<Json<Task>> {
    let workspace_id = authorize_writer(&state, user.id, doc_id).await?;
    if body.block_id.trim().is_empty() {
        return Err(AppError::BadRequest("block_id is required".into()));
    }
    let status = body.status.clone().unwrap_or_else(|| "todo".to_string());
    let priority = body.priority.clone().unwrap_or_else(|| "none".to_string());
    if !valid_status(&status) {
        return Err(AppError::BadRequest("invalid status".into()));
    }
    if !valid_priority(&priority) {
        return Err(AppError::BadRequest("invalid priority".into()));
    }
    let due_at = match &body.due_at {
        DueField::Missing | DueField::Null => None,
        DueField::Set(v) => Some(*v),
    };
    let completed_at = if status == "done" { Some(Utc::now()) } else { None };

    /*
     * Idempotent on the block, which is what makes create-on-convert safe to
     * retry. `do nothing` was not: a first request that succeeds but whose
     * response is lost leaves the retry with a conflict and no id, so the block
     * never learns which task it anchors and no client can recover it. Returning
     * the existing row instead means a retry converges.
     *
     * Only the title is refreshed on conflict. Status, priority and due date
     * belong to whoever has been editing the task since, and a retried create
     * must not reset them.
     */
    let created: Option<(Uuid,)> = sqlx::query_as(
        "insert into tasks \
             (doc_id, workspace_id, block_id, title, status, priority, due_at, \
              due_all_day, completed_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         on conflict (doc_id, block_id) where block_id is not null do update set \
             title = excluded.title, updated_at = now() \
         returning id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(body.block_id.trim())
    .bind(body.title.clone().unwrap_or_default())
    .bind(&status)
    .bind(&priority)
    .bind(due_at)
    .bind(body.due_all_day.unwrap_or(false))
    .bind(completed_at)
    .fetch_optional(&state.pool)
    .await?;

    let id = created
        .ok_or_else(|| AppError::Conflict("that block is already a task".into()))?
        .0;
    Ok(Json(load_task_by_id(&state, user.id, id).await?))
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskById {
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, with = "serde_with_due")]
    pub due_at: DueField,
    pub due_all_day: Option<bool>,
    pub title: Option<String>,
    /// Marks the anchoring block as gone, or back. Clients report this; the
    /// server cannot see it.
    pub detached: Option<bool>,
    /// Re-anchor, for a block cut from one page and pasted into another. Both
    /// are sent together, and the new page must be in the same workspace.
    pub doc_id: Option<Uuid>,
    pub block_id: Option<String>,
}

/// `PATCH /tasks/:id` - update any task by id, page or inline.
pub async fn update_task_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateTaskById>,
) -> ApiResult<Json<Task>> {
    let existing = load_task_by_id(&state, user.id, id).await?;
    // Read access got us here; writing needs more.
    authorize_writer(&state, user.id, existing.doc_id).await?;

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

    /*
     * A page task has no anchoring block, so it can never be detached.
     *
     * Refusing this is not pedantry. `list_doc_tasks` deliberately returns the
     * page task alongside the inline ones, so a client running the documented
     * reconcile ("anything with no matching block is detached") finds no block
     * for it and would mark it detached. That hides it from the board and drops
     * it out of the subscribed calendar, and neither promote nor the page-task
     * PATCH clears `detached_at`, so there is no way back.
     */
    if body.detached.is_some() && existing.block_id.is_none() {
        return Err(AppError::BadRequest(
            "a page task has no block to detach from".into(),
        ));
    }
    /*
     * A page task's title mirrors its document, so accepting one here would
     * silently discard it: the caller would get a 200 and the old title back.
     * Rename the page instead.
     */
    if body.title.is_some() && existing.block_id.is_none() {
        return Err(AppError::BadRequest(
            "a page task's title follows its page; rename the page".into(),
        ));
    }

    // Re-anchoring is only meaningful for an inline task, and only within the
    // workspace: a task must never follow a block into someone else's pages.
    let (doc_id, block_id) = match (body.doc_id, &body.block_id) {
        (Some(new_doc), Some(new_block)) => {
            if existing.block_id.is_none() {
                return Err(AppError::BadRequest(
                    "a page task cannot be re-anchored".into(),
                ));
            }
            let trimmed = new_block.trim();
            // Same check the create path makes: a task anchored to an empty
            // block id is still "inline" and can never be matched to a block
            // again, which is a task nothing can ever reach.
            if trimmed.is_empty() {
                return Err(AppError::BadRequest("block_id is required".into()));
            }
            let ws = authorize_writer(&state, user.id, new_doc).await?;
            if ws != existing.workspace_id {
                return Err(AppError::BadRequest(
                    "cannot move a task to another workspace".into(),
                ));
            }
            (new_doc, Some(trimmed.to_string()))
        }
        (None, None) => (existing.doc_id, existing.block_id.clone()),
        _ => {
            return Err(AppError::BadRequest(
                "doc_id and block_id must be sent together".into(),
            ))
        }
    };

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
    // Page tasks were refused a title above, so this only ever runs for inline
    // ones; a page task's stored title stays empty and its document supplies it.
    let title = body.title.clone().unwrap_or(existing.title.clone());
    // The struct exposes only the boolean, but preserving the instant needs the
    // instant, so read it alongside.
    let (existing_detached_at,): (Option<DateTime<Utc>>,) =
        sqlx::query_as("select detached_at from tasks where id = $1")
            .bind(id)
            .fetch_one(&state.pool)
            .await?;
    /*
     * `detached_at` records when the block actually went missing, so it must
     * survive every later write: a task re-reported as detached on each editor
     * open, or simply dragged between board columns, would otherwise keep
     * resetting to now and lose the only timestamp that means anything.
     */
    let detached_at: Option<DateTime<Utc>> = match body.detached {
        Some(true) => existing_detached_at.or_else(|| Some(Utc::now())),
        Some(false) => None,
        // Re-anchoring found the block again.
        None if body.block_id.is_some() => None,
        None => existing_detached_at,
    };

    /*
     * A re-anchor can land on a block that already has a task: the same
     * `taskItem` copied rather than cut, or two clients racing the reconcile
     * after one cut and paste. That is the unique index doing its job, and it
     * deserves a 409 rather than surfacing as an internal error.
     */
    let written = sqlx::query(
        "update tasks set \
             doc_id = $2, block_id = $3, title = $4, status = $5, priority = $6, \
             due_at = $7, due_all_day = $8, completed_at = $9, detached_at = $10, \
             updated_at = now() \
         where id = $1",
    )
    .bind(id)
    .bind(doc_id)
    .bind(block_id)
    .bind(&title)
    .bind(&status)
    .bind(&priority)
    .bind(due_at)
    .bind(due_all_day)
    .bind(completed_at)
    .bind(detached_at)
    .execute(&state.pool)
    .await;
    if let Err(sqlx::Error::Database(db)) = &written {
        if db.constraint() == Some("tasks_block_unique") {
            return Err(AppError::Conflict("that block is already a task".into()));
        }
    }
    written?;

    Ok(Json(load_task_by_id(&state, user.id, id).await?))
}

/// `DELETE /tasks/:id` - remove a task. The anchoring block, if still in the
/// page, degrades to a plain checkbox the next time a client opens it.
pub async fn delete_task_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let existing = load_task_by_id(&state, user.id, id).await?;
    authorize_writer(&state, user.id, existing.doc_id).await?;
    sqlx::query("delete from tasks where id = $1")
        .bind(id)
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
    /// Restrict to a page **and its subtree**, which is what makes "filter by
    /// project" work: a project is a page, and its tasks are everything under it.
    pub doc_id: Option<Uuid>,
    /// Restrict to pages carrying any of these labels (CSV of uuids).
    pub label_id: Option<String>,
    /// Tasks whose anchoring block is gone. Hidden unless asked for.
    pub include_detached: Option<bool>,
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

    // Label filter CSV, validated up front like the status filter.
    let labels: Vec<Uuid> = match &q.label_id {
        Some(s) => {
            let mut out = Vec::new();
            for raw in s.split(',').map(str::trim).filter(|v| !v.is_empty()) {
                out.push(
                    Uuid::parse_str(raw)
                        .map_err(|_| AppError::BadRequest("invalid label_id".into()))?,
                );
            }
            out
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
    /*
     * Shelved pages are not on the agenda.
     *
     * This gap predates inline tasks, but they make it bite: a trashed meeting
     * note used to contribute one phantom card, and now contributes one per
     * task inside it. The ICS feed already filtered this way, so the board was
     * the surface disagreeing with the calendar.
     */
    let mut sql = format!(
        "{TASK_SELECT} where t.workspace_id = $1 and not d.archived and not d.trashed"
    );
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
    let doc_idx;
    if q.doc_id.is_some() {
        doc_idx = next;
        // The same recursive shape the shelf cascade uses: a page's tasks are
        // its own plus every descendant's, so filtering by a project page picks
        // up the whole project.
        // The depth cap is not optional. A parent cycle is reachable (see the
        // TOCTOU note in documents.rs), and without the cap this CTE never
        // returns: it pins one of ten pool connections and grows temp memory
        // until the API is unreachable. Every other recursive walk over the
        // tree carries the same bound.
        sql.push_str(&format!(
            " and t.doc_id in ( \
                 with recursive sub as ( \
                     select id, 1 as depth from documents where id = ${doc_idx} \
                     union all \
                     select d.id, s.depth + 1 from documents d join sub s on d.parent_id = s.id \
                     where s.depth < 100 \
                 ) select id from sub)"
        ));
        next += 1;
    } else {
        doc_idx = 0;
    }
    let label_idx;
    if !labels.is_empty() {
        label_idx = next;
        sql.push_str(&format!(
            " and exists (select 1 from document_labels dl \
                 where dl.document_id = t.doc_id and dl.label_id = any(${label_idx}))"
        ));
        next += 1;
    } else {
        label_idx = 0;
    }
    if !q.include_detached.unwrap_or(false) {
        sql.push_str(" and t.detached_at is null");
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
    if doc_idx != 0 {
        query = query.bind(q.doc_id);
    }
    if label_idx != 0 {
        query = query.bind(labels);
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
    /// The event's stable identity.
    ///
    /// A page task keeps using its `doc_id`, which is what the feed emitted
    /// before tasks had ids of their own: a calendar that already subscribed
    /// then updates its existing events instead of duplicating every one. An
    /// inline task, which never had an event before, uses its task id.
    uid: Uuid,
    title: String,
    /// The page an inline task came from, shown after the title so a bare
    /// "Call the landlord" in a calendar still says where it lives. Empty for a
    /// page task, whose title already is the page.
    doc_title: String,
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
        "select \
             case when t.block_id is null then t.doc_id else t.id end as uid, \
             case when t.block_id is null then d.title else t.title end as title, \
             case when t.block_id is null then '' else d.title end as doc_title, \
             t.status, t.priority, t.due_at, t.due_all_day, t.updated_at \
         from tasks t join documents d on d.id = t.doc_id \
         where t.workspace_id = $1 and not d.archived and not d.trashed \
           and t.due_at is not null and t.detached_at is null \
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
        out.push_str(&format!("UID:{}@selfnote\r\n", t.uid));

        let marker = if t.status == "done" { "✔ " } else { "" };
        // An inline task's title is a line out of a note, so the page it came
        // from is appended: "Call the landlord (Flat move)".
        let provenance = if t.doc_title.is_empty() {
            String::new()
        } else {
            format!(" ({})", t.doc_title)
        };
        out.push_str(&format!(
            "SUMMARY:{}{}{}\r\n",
            marker,
            ics_escape(&t.title),
            ics_escape(&provenance)
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
