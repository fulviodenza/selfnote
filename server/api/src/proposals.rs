//! Staged AI edits ("diff-preview for AI edits").
//!
//! An AI-originated write — MCP `append_to_note`/`update_note`, or an in-app AI
//! insertion — is not applied to a note's CRDT log directly. Instead it lands here
//! as a `pending` proposal carrying a base64 Yjs diff, the base state vector it was
//! computed against, and a Markdown before/after for review. A human then accepts
//! it (the diff is appended to the note, exactly like `POST /documents/:id/content`)
//! or rejects it. Accept is JWT-only — a personal access token can *propose* a write
//! but cannot approve its own edit.
//!
//! The block-level diff (Markdown → BlockNote blocks → y-prosemirror update) can't
//! be produced in pure Rust, so — like `ai.rs` shelling out to the `claude` CLI —
//! we shell out to a small Node helper (`tools/mcp-server` → `dist/diff-cli.js`)
//! that reuses the exact `edit.ts` path the live editor and MCP server use.

use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{AuthKind, AuthUser};
use crate::documents;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

/* --------------------------------------------------------------- model --- */

/// The full stored proposal. Serialized as the API's proposal object; individual
/// endpoints omit fields (`diff_base64`/`base_sv`) via dedicated response structs.
#[derive(Debug, Serialize, FromRow)]
pub struct Proposal {
    pub id: Uuid,
    pub document_id: Uuid,
    pub workspace_id: Uuid,
    pub created_by: Uuid,
    pub origin: String,
    pub op: String,
    pub summary: String,
    pub before_md: String,
    pub after_md: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by: Option<Uuid>,
}

/// Columns common to every proposal response (3.1's object plus `resolved_*`).
const PROPOSAL_COLS: &str = "id, document_id, workspace_id, created_by, origin, op, summary, \
     before_md, after_md, status, created_at, resolved_at, resolved_by";

/* -------------------------------------------------------- node diff CLI --- */

/// The four fields the Node helper computes off the same reconstructed doc.
#[derive(Debug, Deserialize)]
struct Computed {
    before_md: String,
    after_md: String,
    diff_base64: String,
    base_sv: String,
}

/// A fresh diff re-derived from the intended final body against current content.
#[derive(Debug, Deserialize)]
struct Reapplied {
    diff_base64: String,
    base_sv: String,
}

/// Run the Node diff helper with a JSON job on stdin, parse its JSON stdout into
/// `T`. `SELFNOTE_EDIT_DIFF_CMD` overrides the command (default: `selfnote-edit-diff`,
/// the bin the MCP package installs); the helper is expected on PATH in the image.
async fn run_diff_cli<T: for<'de> Deserialize<'de>>(job: serde_json::Value) -> ApiResult<T> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let cmd = std::env::var("SELFNOTE_EDIT_DIFF_CMD")
        .unwrap_or_else(|_| "selfnote-edit-diff".to_string());
    let mut child = Command::new(&cmd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("spawn {cmd}: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(job.to_string().as_bytes())
            .await
            .map_err(|e| AppError::Other(anyhow::anyhow!("write stdin: {e}")))?;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Other(anyhow::anyhow!("diff cli wait: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // The helper reports edit failures as `{"error":"…"}` on stdout with a non-zero
    // exit — surface those as 409 (could not produce an edit), not a 500.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(AppError::Conflict(format!("could not produce edit: {err}")));
        }
    }
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Conflict(format!("could not produce edit: {err}")));
    }
    serde_json::from_str::<T>(&stdout)
        .map_err(|e| AppError::Other(anyhow::anyhow!("diff cli parse: {e}; body: {stdout}")))
}

/* --------------------------------------------------------------- create --- */

#[derive(Debug, Deserialize)]
pub struct CreateReq {
    pub document_id: Uuid,
    /// "append" | "replace".
    pub op: String,
    pub markdown: String,
    /// "mcp" | "app"; defaults to "mcp" for a PAT, "app" for a JWT.
    pub origin: Option<String>,
    pub summary: Option<String>,
}

/// `POST /ai/proposals` — stage an AI write as a `pending` proposal. Called by MCP
/// `update_note`/`append_to_note` and in-app AI insertions *instead of* writing the
/// content log. Never touches the note.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateReq>,
) -> ApiResult<(axum::http::StatusCode, Json<Proposal>)> {
    if req.op != "append" && req.op != "replace" {
        return Err(AppError::Conflict("invalid op".into()));
    }
    let doc = documents::get_document(&state, req.document_id).await?;
    // Must be a member with write access (viewers may not stage edits).
    match member_role(&state, doc.workspace_id, user.id).await? {
        Some(r) if r != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }

    let origin = match req.origin.as_deref() {
        Some(o) if !o.trim().is_empty() => o.trim().to_string(),
        _ => match user.kind {
            AuthKind::Pat => "mcp".to_string(),
            AuthKind::Jwt => "app".to_string(),
        },
    };
    let summary = req.summary.unwrap_or_default();

    let updates = documents::load_content_updates(&state, req.document_id).await?;
    let computed: Computed = run_diff_cli(serde_json::json!({
        "mode": "compute",
        "updates": updates,
        "op": req.op,
        "markdown": req.markdown,
    }))
    .await?;

    let proposal: Proposal = sqlx::query_as(&format!(
        "insert into ai_edit_proposals \
             (document_id, workspace_id, created_by, origin, op, summary, \
              diff_base64, base_sv, before_md, after_md) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         returning {PROPOSAL_COLS}"
    ))
    .bind(req.document_id)
    .bind(doc.workspace_id)
    .bind(user.id)
    .bind(&origin)
    .bind(&req.op)
    .bind(&summary)
    .bind(&computed.diff_base64)
    .bind(&computed.base_sv)
    .bind(&computed.before_md)
    .bind(&computed.after_md)
    .fetch_one(&state.pool)
    .await?;

    Ok((axum::http::StatusCode::CREATED, Json(proposal)))
}

/* ----------------------------------------------------------------- list --- */

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub document_id: Option<Uuid>,
    /// Defaults to "pending".
    pub status: Option<String>,
}

/// `GET /ai/proposals?document_id=&status=` — proposals the caller can see, newest
/// first. Scoped to workspaces the caller is a member of. `document_id` narrows to
/// one note (403 if the caller isn't a member of it); omitting it lists across all
/// the caller's workspaces.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Proposal>>> {
    let status = q.status.unwrap_or_else(|| "pending".to_string());

    let rows: Vec<Proposal> = if let Some(doc_id) = q.document_id {
        let doc = documents::get_document(&state, doc_id).await?;
        if member_role(&state, doc.workspace_id, user.id).await?.is_none() {
            return Err(AppError::Forbidden);
        }
        sqlx::query_as(&format!(
            "select {PROPOSAL_COLS} from ai_edit_proposals \
             where document_id = $1 and status = $2 order by created_at desc"
        ))
        .bind(doc_id)
        .bind(&status)
        .fetch_all(&state.pool)
        .await?
    } else {
        // All matching proposals in workspaces the caller belongs to.
        sqlx::query_as(&format!(
            "select {PROPOSAL_COLS} from ai_edit_proposals p \
             join workspace_members m on m.workspace_id = p.workspace_id and m.user_id = $1 \
             where p.status = $2 order by p.created_at desc"
        ))
        .bind(user.id)
        .bind(&status)
        .fetch_all(&state.pool)
        .await?
    };
    Ok(Json(rows))
}

/* ------------------------------------------------------------------ get --- */

/// The full proposal payload, including the raw diff fields (for debugging /
/// optimistic apply on the client).
#[derive(Debug, Serialize, FromRow)]
pub struct ProposalFull {
    pub id: Uuid,
    pub document_id: Uuid,
    pub workspace_id: Uuid,
    pub created_by: Uuid,
    pub origin: String,
    pub op: String,
    pub summary: String,
    pub before_md: String,
    pub after_md: String,
    pub diff_base64: String,
    pub base_sv: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by: Option<Uuid>,
}

/// `GET /ai/proposals/:id` — one proposal with the before/after and the raw diff.
/// `404` if not found or the caller isn't a member of its workspace.
pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProposalFull>> {
    let row: Option<ProposalFull> = sqlx::query_as(
        "select id, document_id, workspace_id, created_by, origin, op, summary, \
                before_md, after_md, diff_base64, base_sv, status, created_at, \
                resolved_at, resolved_by \
         from ai_edit_proposals where id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let proposal = row.ok_or(AppError::NotFound)?;
    // Not a member → behave as if it doesn't exist (no existence leak).
    if member_role(&state, proposal.workspace_id, user.id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(Json(proposal))
}

/* -------------------------------------------------------- accept/reject --- */

#[derive(Debug, Serialize)]
pub struct ResolveResp {
    pub id: Uuid,
    pub status: String,
    pub resolved_at: DateTime<Utc>,
    pub resolved_by: Uuid,
}

/// A pending proposal loaded for resolution, with the fields accept needs.
#[derive(Debug, FromRow)]
struct PendingRow {
    document_id: Uuid,
    workspace_id: Uuid,
    status: String,
    diff_base64: String,
    base_sv: String,
    after_md: String,
}

/// Load a proposal for accept/reject and enforce the human-gate + membership +
/// pending-status rules. Returns the row for the caller to act on.
async fn load_for_resolve(
    state: &AppState,
    user: &AuthUser,
    id: Uuid,
) -> ApiResult<PendingRow> {
    // Accept/reject are a human review gate — a PAT may propose but not approve.
    if user.kind != AuthKind::Jwt {
        return Err(AppError::Forbidden);
    }
    let row: Option<PendingRow> = sqlx::query_as(
        "select document_id, workspace_id, status, diff_base64, base_sv, after_md \
         from ai_edit_proposals where id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let row = row.ok_or(AppError::NotFound)?;
    if member_role(state, row.workspace_id, user.id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    if row.status != "pending" {
        return Err(AppError::Conflict(format!(
            "proposal is not pending (status: {})",
            row.status
        )));
    }
    Ok(row)
}

/// Mark a proposal resolved with the given terminal status, returning the response.
async fn mark_resolved(
    state: &AppState,
    id: Uuid,
    user_id: Uuid,
    status: &str,
) -> ApiResult<Json<ResolveResp>> {
    let row: (DateTime<Utc>,) = sqlx::query_as(
        "update ai_edit_proposals \
         set status = $2, resolved_at = now(), resolved_by = $3 \
         where id = $1 returning resolved_at",
    )
    .bind(id)
    .bind(status)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(ResolveResp {
        id,
        status: status.to_string(),
        resolved_at: row.0,
        resolved_by: user_id,
    }))
}

/// `POST /ai/proposals/:id/accept` — JWT only. Apply the staged diff to the note.
///
/// If the note hasn't moved since the proposal was made (its state vector still
/// matches `base_sv`), the stored `diff_base64` is appended verbatim. If the note
/// drifted, we re-derive a fresh replace diff from the intended final body
/// (`after_md`) against the note's *current* content and apply that, so a late
/// accept still lands the intended text. If even that can't be produced, the
/// proposal is marked `superseded` and we return `409`.
pub async fn accept(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ResolveResp>> {
    let row = load_for_resolve(&state, &user, id).await?;
    let updates = documents::load_content_updates(&state, row.document_id).await?;

    // One helper call re-derives a replace diff from the intended final body
    // (`after_md`) against current content *and* reports the note's current state
    // vector — so we can both detect drift and have a ready fallback diff.
    let re: Reapplied = run_diff_cli(serde_json::json!({
        "mode": "reapply",
        "updates": updates,
        "after_md": row.after_md,
    }))
    .await?;

    let unchanged = re.base_sv == row.base_sv;
    let to_apply = if unchanged { &row.diff_base64 } else { &re.diff_base64 };
    if to_apply.is_empty() {
        supersede(&state, id, user.id).await?;
        return Err(AppError::Conflict(
            "this note changed — the edit no longer applies".into(),
        ));
    }

    documents::append_update(&state, row.document_id, to_apply).await?;
    mark_resolved(&state, id, user.id, "applied").await
}

/// Mark a proposal `superseded` (the note drifted and the edit can't be reapplied).
async fn supersede(state: &AppState, id: Uuid, user_id: Uuid) -> ApiResult<()> {
    sqlx::query(
        "update ai_edit_proposals \
         set status = 'superseded', resolved_at = now(), resolved_by = $2 where id = $1",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// `POST /ai/proposals/:id/reject` — JWT only. Mark the proposal `rejected`.
/// Never touches the note.
pub async fn reject(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ResolveResp>> {
    load_for_resolve(&state, &user, id).await?;
    mark_resolved(&state, id, user.id, "rejected").await
}
