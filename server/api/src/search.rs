//! Categorized workspace search (`GET /search`), powering the Ctrl/Cmd+K modal:
//!
//!   - **pages**  — title matches (FTS plus a substring fallback so prefixes hit)
//!   - **labels** — label-name substring matches
//!   - **texts**  — full-text matches inside note bodies, with a highlighted
//!                  snippet (`ts_headline`)
//!
//! Note bodies are opaque Yjs CRDTs, so body search runs over the
//! `document_texts` cache (migration 0013). The cache refreshes lazily here:
//! each query re-renders up to [`MAX_REFRESH_PER_QUERY`] notes whose
//! `documents.updated_at` moved past the cached `rendered_at`, through the same
//! Node diff helper the proposal path uses. First searches on a large freshly
//! imported workspace warm up over a few queries rather than blocking one.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::labels::Label;
use crate::state::AppState;
use crate::workspaces::member_role;

/// Stale notes rendered per diff-cli invocation by the background warmer.
const WARM_BATCH: i64 = 40;
/// Cap on notes one warm pass will refresh before giving up its slot.
const WARM_MAX_PER_PASS: usize = 400;

#[derive(Debug, Deserialize)]
pub struct SearchReq {
    pub workspace_id: Uuid,
    pub q: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PageHit {
    pub id: Uuid,
    pub title: String,
    pub icon: Option<String>,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TextHit {
    pub id: Uuid,
    pub title: String,
    pub icon: Option<String>,
    pub parent_id: Option<Uuid>,
    /// `ts_headline` snippet with `<mark>…</mark>` around matches.
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResp {
    pub pages: Vec<PageHit>,
    pub labels: Vec<Label>,
    pub texts: Vec<TextHit>,
}

/// `GET /search?workspace_id=&q=` — categorized results for the search modal.
/// Any workspace member. Empty query returns empty categories.
pub async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(req): Query<SearchReq>,
) -> ApiResult<Json<SearchResp>> {
    if member_role(&state, req.workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }
    let q = req.q.trim();
    if q.is_empty() {
        return Ok(Json(SearchResp { pages: vec![], labels: vec![], texts: vec![] }));
    }

    // Warm the body-text cache in the BACKGROUND — the query itself must never
    // wait on note rendering (the first search on a big workspace used to
    // block for many seconds per keystroke). Body results simply improve as
    // the cache fills over the next moments.
    spawn_warm_texts(state.clone(), req.workspace_id);

    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));

    // Pages: FTS rank first, then substring matches FTS missed (prefix typing).
    let pages: Vec<PageHit> = sqlx::query_as(
        "select id, title, icon, parent_id from documents \
         where workspace_id = $1 and not archived and not trashed \
           and (to_tsvector('english', title) @@ websearch_to_tsquery('english', $2) \
                or title ilike $3) \
         order by ts_rank(to_tsvector('english', title), websearch_to_tsquery('english', $2)) desc, \
                  title asc \
         limit 10",
    )
    .bind(req.workspace_id)
    .bind(q)
    .bind(&like)
    .fetch_all(&state.pool)
    .await?;

    let labels: Vec<Label> = sqlx::query_as(
        "select id, workspace_id, name, color from labels \
         where workspace_id = $1 and name ilike $2 \
         order by lower(name) asc limit 10",
    )
    .bind(req.workspace_id)
    .bind(&like)
    .fetch_all(&state.pool)
    .await?;

    // Body text: FTS over the cache, snippet via ts_headline. Pages already
    // matched by title are excluded so the categories stay distinct.
    let page_ids: Vec<Uuid> = pages.iter().map(|p| p.id).collect();
    let texts: Vec<TextHit> = sqlx::query_as(
        "select d.id, d.title, d.icon, d.parent_id, \
                ts_headline('english', t.text, websearch_to_tsquery('english', $2), \
                            'StartSel=<mark>, StopSel=</mark>, MaxWords=18, MinWords=8') as snippet \
         from document_texts t \
         join documents d on d.id = t.document_id \
         where t.workspace_id = $1 and not d.archived and not d.trashed and d.id <> all($3) \
           and to_tsvector('english', t.text) @@ websearch_to_tsquery('english', $2) \
         order by ts_rank(to_tsvector('english', t.text), websearch_to_tsquery('english', $2)) desc \
         limit 10",
    )
    .bind(req.workspace_id)
    .bind(q)
    .bind(&page_ids)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(SearchResp { pages, labels, texts }))
}

/// Workspaces with a warm task currently running (one at a time each).
fn warming() -> &'static std::sync::Mutex<std::collections::HashSet<Uuid>> {
    static WARMING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<Uuid>>> =
        std::sync::OnceLock::new();
    WARMING.get_or_init(Default::default)
}

/// Kick off (at most one per workspace) a background task that re-renders
/// notes whose cached text is older than the document row, in batches through
/// the diff helper's `render_many` mode — one node process per WARM_BATCH
/// notes instead of one per note. Failures skip the note; a stale snippet
/// beats a failed search.
fn spawn_warm_texts(state: AppState, workspace_id: Uuid) {
    {
        let mut set = warming().lock().unwrap();
        if !set.insert(workspace_id) {
            return; // already warming this workspace
        }
    }
    tokio::spawn(async move {
        let result = warm_texts(&state, workspace_id).await;
        warming().lock().unwrap().remove(&workspace_id);
        if let Err(e) = result {
            tracing::warn!("search cache: warm of {workspace_id} failed: {e}");
        }
    });
}

async fn warm_texts(state: &AppState, workspace_id: Uuid) -> ApiResult<()> {
    #[derive(serde::Deserialize)]
    struct RenderedMany {
        markdowns: std::collections::HashMap<String, String>,
    }

    let mut refreshed = 0usize;
    loop {
        let stale: Vec<(Uuid,)> = sqlx::query_as(
            "select d.id from documents d \
             left join document_texts t on t.document_id = d.id \
             where d.workspace_id = $1 and not d.archived and not d.trashed \
               and (t.document_id is null or t.rendered_at < d.updated_at) \
             order by d.updated_at desc limit $2",
        )
        .bind(workspace_id)
        .bind(WARM_BATCH)
        .fetch_all(&state.pool)
        .await?;
        if stale.is_empty() {
            return Ok(());
        }

        // Collect each note's update log; empty notes render to empty text
        // without a CLI trip.
        let mut docs = Vec::new();
        let mut empty: Vec<Uuid> = Vec::new();
        for (doc_id,) in &stale {
            let updates = crate::documents::load_content_updates(state, *doc_id).await?;
            if updates.is_empty() {
                empty.push(*doc_id);
            } else {
                docs.push(serde_json::json!({ "id": doc_id.to_string(), "updates": updates }));
            }
        }

        let mut texts: Vec<(Uuid, String)> = empty.into_iter().map(|id| (id, String::new())).collect();
        if !docs.is_empty() {
            let r: RenderedMany = crate::proposals::run_diff_cli(serde_json::json!({
                "mode": "render_many",
                "docs": docs,
            }))
            .await?;
            for (id, md) in r.markdowns {
                if let Ok(id) = id.parse::<Uuid>() {
                    texts.push((id, md));
                }
            }
        }

        for (doc_id, text) in &texts {
            sqlx::query(
                "insert into document_texts (document_id, workspace_id, text, rendered_at) \
                 values ($1, $2, $3, now()) \
                 on conflict (document_id) \
                 do update set text = excluded.text, rendered_at = now()",
            )
            .bind(doc_id)
            .bind(workspace_id)
            .bind(text)
            .execute(&state.pool)
            .await?;
        }

        refreshed += texts.len();
        if refreshed >= WARM_MAX_PER_PASS {
            // Give up the slot; the next search re-arms the warmer.
            return Ok(());
        }
    }
}
