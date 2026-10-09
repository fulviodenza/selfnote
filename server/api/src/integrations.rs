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
    pub color: Option<String>,
    /// When the reader made the highlight. Used only for ordering, so a batch
    /// lands in the order it was read rather than the order it was sent. Parsed
    /// leniently for the same reason: a timestamp format we do not recognise
    /// should degrade to send order, not 422 the whole batch for a field that
    /// only sorts it.
    #[serde(default, deserialize_with = "lenient_timestamp")]
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub locator: Option<serde_json::Value>,
}

fn lenient_timestamp<'de, D>(
    d: D,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(v.and_then(|v| match v {
        serde_json::Value::String(s) => DateTime::parse_from_rfc3339(&s)
            .map(|t| t.with_timezone(&Utc))
            .ok()
            .or_else(|| {
                // Offset-less timestamps (Kobo exports, some JS Date formats)
                // are taken as UTC rather than rejected.
                NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
                    .ok()
                    .map(|n| Utc.from_utc_datetime(&n))
            }),
        serde_json::Value::Number(n) => n.as_f64().and_then(|raw| {
            // Date.now() sends milliseconds; smaller values are taken as seconds.
            let secs = if raw > 1e12 { raw / 1000.0 } else { raw };
            Utc.timestamp_opt(secs as i64, 0).single()
        }),
        _ => None,
    }))
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
    Json(mut body): Json<IngestRequest>,
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

    // Trim before anything keys off these. Validation already trims, so storing
    // the raw value meant "9780143120 \n" and "9780143120" were two different
    // books: a second page, a split ledger, and every highlight appended again.
    body.book.key = body.book.key.trim().to_string();
    for h in &mut body.highlights {
        h.id = h.id.trim().to_string();
    }

    if body.highlights.len() > 500 {
        return Err(AppError::BadRequest(
            "send at most 500 highlights per request and split the rest across calls".into(),
        ));
    }

    // Resolve the target page and any existing book identity WITHOUT writing
    // anything. Every write in this request shares the one transaction at the
    // bottom, so a failure after this point leaves no re-pointed book, no
    // orphan page and no half-landed batch behind it.
    let existing: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
        "select b.id, b.document_id, d.trashed from ingested_books b \
         join documents d on d.id = b.document_id \
         where b.workspace_id = $1 and b.source_key = $2",
    )
    .bind(workspace_id)
    .bind(&body.book.key)
    .fetch_optional(&state.pool)
    .await?;

    let target_doc: Option<Uuid> = match (body.document_id, &existing) {
        (Some(chosen), _) => {
            // The page must be in the caller's workspace, or a token could
            // append to any page anywhere by passing its id.
            let owner: Option<(Uuid, bool)> =
                sqlx::query_as("select workspace_id, trashed from documents where id = $1")
                    .bind(chosen)
                    .fetch_optional(&state.pool)
                    .await?;
            match owner {
                Some((ws, false)) if ws == workspace_id => Some(chosen),
                Some((ws, true)) if ws == workspace_id => {
                    return Err(AppError::BadRequest(
                        "that page is in the trash; restore it or choose another".into(),
                    ))
                }
                Some(_) => return Err(AppError::Forbidden),
                None => return Err(AppError::BadRequest("that page does not exist".into())),
            }
        }
        (None, Some((_, doc, trashed))) => {
            // Appending into the trash and reporting success made a trashed
            // page a silent sink: invisible in the tree and in search, with
            // the ledger insisting everything landed.
            if *trashed {
                return Err(AppError::Conflict(
                    "the page for this book is in the trash; restore it or pick a page".into(),
                ));
            }
            Some(*doc)
        }
        (None, None) => None, // the page is created inside the final transaction
    };

    // Drop anything the ledger has already seen, and collapse duplicate ids
    // inside this batch so a client sending the same id twice cannot write it
    // twice.
    let known = match &existing {
        Some((book_id, ..)) => known_client_ids(&state, *book_id).await?,
        None => std::collections::HashSet::new(),
    };
    let mut seen = std::collections::HashSet::new();
    let mut fresh: Vec<&IncomingHighlight> = body
        .highlights
        .iter()
        .filter(|h| !known.contains(&h.id) && seen.insert(h.id.clone()))
        .collect();
    let skipped = body.highlights.len() - fresh.len();
    // Timestamped highlights land in reading order; untimestamped ones keep
    // send order AT THE END. A bare sort on Option puts None first, which
    // hoisted untimestamped highlights above text they were read after.
    fresh.sort_by_key(|h| (h.created_at.is_none(), h.created_at));

    if fresh.is_empty() {
        let Some((book_id, document_id, _)) = existing else {
            // No existing book and nothing fresh means the batch collapsed to
            // nothing before any identity existed to report.
            return Err(AppError::BadRequest("nothing to apply".into()));
        };
        return Ok(Json(IngestResponse { document_id, book_id, applied: 0, skipped }));
    }

    // The text goes to the Node helper as data, never as Markdown. The previous
    // path rendered Markdown and escaped what it guessed the parser would
    // reinterpret; the guesses were wrong in both directions and quotes with
    // dollar signs, ampersands or list markers were being rewritten on their
    // way to the only copy of the text.
    let updates = match target_doc {
        Some(d) => crate::documents::load_content_updates(&state, d).await?,
        None => Vec::new(),
    };
    let computed: Computed = run_diff_cli(serde_json::json!({
        "mode": "append_highlights",
        "updates": updates,
        "highlights": fresh
            .iter()
            .map(|h| serde_json::json!({ "text": h.text, "note": h.note }))
            .collect::<Vec<_>>(),
    }))
    .await?;
    if computed.diff_base64.is_empty() {
        return Err(AppError::Conflict("could not produce an edit for this batch".into()));
    }
    let diff = base64_decode(&computed.diff_base64)?;

    let title =
        if body.book.title.trim().is_empty() { "Untitled book" } else { body.book.title.trim() };

    let mut tx = state.pool.begin().await?;

    let document_id = match target_doc {
        Some(d) => d,
        None => {
            let (id,): (Uuid,) = sqlx::query_as(
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
            id
        }
    };

    let book_id: Uuid = match (body.document_id, &existing) {
        // The caller chose a page: create or re-point the binding, atomically
        // with the content so a failed request cannot leave the book pointing
        // at a page that never received anything.
        (Some(_), _) => {
            let (id,): (Uuid,) = sqlx::query_as(
                "insert into ingested_books (workspace_id, document_id, source_key, title, author) \
                 values ($1, $2, $3, $4, $5) \
                 on conflict (workspace_id, source_key) \
                 do update set document_id = excluded.document_id \
                 returning id",
            )
            .bind(workspace_id)
            .bind(document_id)
            .bind(&body.book.key)
            .bind(title)
            .bind(&body.book.author)
            .fetch_one(&mut *tx)
            .await?;
            id
        }
        (None, Some((id, ..))) => *id,
        (None, None) => {
            let row: Option<(Uuid,)> = sqlx::query_as(
                "insert into ingested_books (workspace_id, document_id, source_key, title, author) \
                 values ($1, $2, $3, $4, $5) \
                 on conflict (workspace_id, source_key) do nothing \
                 returning id",
            )
            .bind(workspace_id)
            .bind(document_id)
            .bind(&body.book.key)
            .bind(title)
            .bind(&body.book.author)
            .fetch_optional(&mut *tx)
            .await?;
            match row {
                Some((id,)) => id,
                // Lost the first-sight race; rolling back also discards the
                // page created above, so nothing is orphaned.
                None => {
                    return Err(AppError::Conflict(
                        "this book is being synced from somewhere else; try again".into(),
                    ))
                }
            }
        }
    };

    // Ledger first, content last. A duplicate id must abort before anything is
    // on the page, and the content row's id should spend as little time as
    // possible allocated-but-uncommitted beneath the sync server's compaction
    // watermark. `on conflict do nothing` with a rows_affected check gives the
    // same abort as letting the violation fire, without discarding the whole
    // request's work building the error.
    for h in &fresh {
        let written = sqlx::query(
            "insert into ingested_highlights (book_id, client_id, locator, color) \
             values ($1, $2, $3, $4) on conflict (book_id, client_id) do nothing",
        )
        .bind(book_id)
        .bind(&h.id)
        .bind(&h.locator)
        .bind(&h.color)
        .execute(&mut *tx)
        .await?;
        if written.rows_affected() == 0 {
            return Err(AppError::Conflict(
                "these highlights are being synced from somewhere else; try again".into(),
            ));
        }
    }
    crate::documents::append_update_tx(&mut tx, document_id, &diff).await?;
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

/// so highlights already sent are not re-sent to the new page.
/// is never highlighted leaves no empty page behind.
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
