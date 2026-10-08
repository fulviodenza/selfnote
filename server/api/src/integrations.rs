//! Highlight ingest for external clients.
//!
//! A page body is a Yjs update log, so writing to one means producing a valid Yjs
//! update, which needs BlockNote and Yjs and therefore Node. That is reasonable to
//! ask of the editor and unreasonable to ask of an e-reader, a Kobo script or a
//! share extension, each of which only wants to send a sentence and a locator.
//!
//! So the structured form comes in here and the conversion happens server-side,
//! through the same Node helper `proposals` already shells out to. Deliberately not
//! the proposal path: that stages edits for human review, which is right for an
//! agent writing prose and wrong for a deterministic sync of something the user
//! underlined by hand.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::proposals::run_diff_cli;
use crate::state::AppState;
use crate::workspaces::member_role;

/// Identity and metadata for the book a batch belongs to.
#[derive(Debug, Deserialize)]
pub struct BookRef {
    /// Stable client-chosen key: an ISBN, or a hash of the file.
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IncomingHighlight {
    /// Stable for the life of the highlight. This is the idempotency key.
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub locator: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct IngestRequest {
    /// Defaults to the caller's first workspace, which is what a single-workspace
    /// user has and should not have to discover to sync a book.
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
    /// The page to append to, when the client has let the user choose one. The
    /// eReader does exactly that: you pick "X notes" for the book you are reading,
    /// and highlights belong there rather than on a page the server named. Without
    /// it, the book's own page is found or created as before, which is what a
    /// headless importer with no UI needs.
    #[serde(default)]
    pub document_id: Option<Uuid>,
    pub book: BookRef,
    pub highlights: Vec<IncomingHighlight>,
}

#[derive(Debug, Serialize)]
pub struct IngestResponse {
    pub document_id: Uuid,
    pub book_id: Uuid,
    /// Written on this call. Zero is the ordinary result for a client re-syncing
    /// an unchanged book, and is a success rather than a failure to report.
    pub applied: usize,
    /// Already in the ledger, so skipped.
    pub skipped: usize,
}

/// What the Node helper returns for a `compute` job. Only the diff is needed here;
/// the before/after Markdown exists for the human-review path, which this is not.
#[derive(Debug, Deserialize)]
struct Computed {
    diff_base64: String,
}

/// `POST /integrations/highlights`.
pub async fn ingest_highlights(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<IngestRequest>,
) -> ApiResult<Json<IngestResponse>> {
    // Reject the whole batch rather than applying part of it. A client that cannot
    // tell which half landed has no way to recover without duplicating.
    if body.book.key.trim().is_empty() {
        return Err(AppError::BadRequest("book.key must not be empty".into()));
    }
    if body.highlights.is_empty() {
        return Err(AppError::BadRequest("highlights must not be empty".into()));
    }
    for h in &body.highlights {
        if h.id.trim().is_empty() {
            return Err(AppError::BadRequest("every highlight needs a stable id".into()));
        }
        if h.text.trim().is_empty() {
            return Err(AppError::BadRequest(format!("highlight {} has no text", h.id)));
        }
    }

    let workspace_id = match body.workspace_id {
        Some(id) => id,
        None => default_workspace(&state, user.id).await?,
    };
    match member_role(&state, workspace_id, user.id).await? {
        Some(role) if role != "viewer" => {}
        _ => return Err(AppError::Forbidden),
    }

    let (book_id, document_id) = match body.document_id {
        Some(chosen) => bind_to_page(&state, workspace_id, &body.book, chosen).await?,
        None => find_or_create_book(&state, workspace_id, &body.book).await?,
    };

    // Drop anything the ledger has already seen, and collapse duplicate ids inside
    // this batch so a client sending the same id twice cannot write it twice.
    let known = known_client_ids(&state, book_id).await?;
    let mut seen = std::collections::HashSet::new();
    let fresh: Vec<&IncomingHighlight> = body
        .highlights
        .iter()
        .filter(|h| !known.contains(&h.id) && seen.insert(h.id.clone()))
        .collect();
    let skipped = body.highlights.len() - fresh.len();

    if fresh.is_empty() {
        return Ok(Json(IngestResponse { document_id, book_id, applied: 0, skipped }));
    }

    // Append through the load-and-diff path. A fresh-document update posted into an
    // existing page's log merges two unrelated fragments and garbles the page.
    let updates = crate::documents::load_content_updates(&state, document_id).await?;
    let computed: Computed = run_diff_cli(serde_json::json!({
        "mode": "compute",
        "op": "append",
        "updates": updates,
        "markdown": render_markdown(&fresh),
    }))
    .await?;

    if computed.diff_base64.is_empty() {
        return Err(AppError::Conflict("could not produce an edit for this batch".into()));
    }

    // The content append and the ledger rows go together. Appending outside the
    // transaction would leave highlights on the page with no ledger row, which the
    // next sync would faithfully append all over again.
    let diff = base64_decode(&computed.diff_base64)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("insert into doc_updates (doc_id, update) values ($1, $2)")
        .bind(document_id)
        .bind(&diff)
        .execute(&mut *tx)
        .await?;
    for h in &fresh {
        sqlx::query(
            "insert into ingested_highlights (book_id, client_id, locator) \
             values ($1, $2, $3) on conflict (book_id, client_id) do nothing",
        )
        .bind(book_id)
        .bind(&h.id)
        .bind(&h.locator)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(Json(IngestResponse { document_id, book_id, applied: fresh.len(), skipped }))
}

fn base64_decode(s: &str) -> ApiResult<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|_| AppError::Other(anyhow::anyhow!("diff helper returned invalid base64")))
}

/// The caller's first workspace by creation, matching what `workspaces::list`
/// returns first and what the MCP server already treats as the default.
async fn default_workspace(state: &AppState, user_id: Uuid) -> ApiResult<Uuid> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "select w.id from workspaces w \
         join workspace_members m on m.workspace_id = w.id \
         where m.user_id = $1 order by w.created_at limit 1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    row.map(|r| r.0)
        .ok_or_else(|| AppError::BadRequest("this account has no workspace".into()))
}

/// Bind a book to a page the user picked, and return its ledger row.
///
/// The page must be in the same workspace: without that check a token could
/// append to any page in any workspace it is not a member of, by passing its id.
/// Re-pointing an existing book at a different page is allowed and expected, since
/// that is what changing the target in the app does; the ledger follows the book,
/// so highlights already sent are not re-sent to the new page.
async fn bind_to_page(
    state: &AppState,
    workspace_id: Uuid,
    book: &BookRef,
    document_id: Uuid,
) -> ApiResult<(Uuid, Uuid)> {
    let owner: Option<(Uuid,)> =
        sqlx::query_as("select workspace_id from documents where id = $1 and not trashed")
            .bind(document_id)
            .fetch_optional(&state.pool)
            .await?;
    match owner {
        Some((ws,)) if ws == workspace_id => {}
        Some(_) => return Err(AppError::Forbidden),
        None => return Err(AppError::BadRequest("that page does not exist".into())),
    }

    let title = if book.title.trim().is_empty() { "Untitled book" } else { book.title.trim() };
    let row: (Uuid, Uuid) = sqlx::query_as(
        "insert into ingested_books (workspace_id, document_id, source_key, title, author) \
         values ($1, $2, $3, $4, $5) \
         on conflict (workspace_id, source_key) do update set document_id = excluded.document_id \
         returning id, document_id",
    )
    .bind(workspace_id)
    .bind(document_id)
    .bind(&book.key)
    .bind(title)
    .bind(&book.author)
    .fetch_one(&state.pool)
    .await?;
    Ok(row)
}

/// The book's row and page, created on first sight. Created lazily so a book that
/// is never highlighted leaves no empty page behind.
async fn find_or_create_book(
    state: &AppState,
    workspace_id: Uuid,
    book: &BookRef,
) -> ApiResult<(Uuid, Uuid)> {
    let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
        "select id, document_id from ingested_books where workspace_id = $1 and source_key = $2",
    )
    .bind(workspace_id)
    .bind(&book.key)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(found) = existing {
        return Ok(found);
    }

    let title = if book.title.trim().is_empty() { "Untitled book" } else { book.title.trim() };

    let mut tx = state.pool.begin().await?;
    let (document_id,): (Uuid,) = sqlx::query_as(
        "insert into documents (workspace_id, parent_id, title, position) \
         values ($1, null, $2, coalesce(( \
             select max(position) + 1 from documents \
             where workspace_id = $1 and parent_id is null \
         ), 0)) returning id",
    )
    .bind(workspace_id)
    .bind(title)
    .fetch_one(&mut *tx)
    .await?;

    // Two clients syncing the same book at once both reach here; the unique index
    // on (workspace_id, source_key) decides, and the loser reuses the winner's page
    // rather than creating a second one.
    let inserted: Option<(Uuid, Uuid)> = sqlx::query_as(
        "insert into ingested_books (workspace_id, document_id, source_key, title, author) \
         values ($1, $2, $3, $4, $5) on conflict (workspace_id, source_key) do nothing \
         returning id, document_id",
    )
    .bind(workspace_id)
    .bind(document_id)
    .bind(&book.key)
    .bind(title)
    .bind(&book.author)
    .fetch_optional(&mut *tx)
    .await?;

    match inserted {
        Some(row) => {
            tx.commit().await?;
            Ok(row)
        }
        None => {
            // Lost the race: drop our page so it does not linger unreferenced.
            tx.rollback().await?;
            let row: (Uuid, Uuid) = sqlx::query_as(
                "select id, document_id from ingested_books \
                 where workspace_id = $1 and source_key = $2",
            )
            .bind(workspace_id)
            .bind(&book.key)
            .fetch_one(&state.pool)
            .await?;
            Ok(row)
        }
    }
}

async fn known_client_ids(
    state: &AppState,
    book_id: Uuid,
) -> ApiResult<std::collections::HashSet<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("select client_id from ingested_highlights where book_id = $1")
            .bind(book_id)
            .fetch_all(&state.pool)
            .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Highlights as Markdown: the passage as a blockquote, the reader's own note as a
/// paragraph under it. Deliberately plain, because once this lands it is an ordinary
/// page the user can restructure however they like.
fn render_markdown(highlights: &[&IncomingHighlight]) -> String {
    let mut out = String::new();
    for h in highlights {
        for line in h.text.trim().lines() {
            out.push_str("> ");
            out.push_str(line.trim());
            out.push('\n');
        }
        out.push('\n');
        if let Some(note) = h.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            out.push_str(note);
            out.push_str("\n\n");
        }
    }
    out.trim_end().to_string()
}
