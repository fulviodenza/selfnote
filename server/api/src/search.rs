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

/// Cap on stale notes re-rendered per search request.
const MAX_REFRESH_PER_QUERY: i64 = 25;

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

    refresh_stale_texts(&state, req.workspace_id).await;

    let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));

    // Pages: FTS rank first, then substring matches FTS missed (prefix typing).
    let pages: Vec<PageHit> = sqlx::query_as(
        "select id, title, icon, parent_id from documents \
         where workspace_id = $1 and not archived \
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
         where t.workspace_id = $1 and not d.archived and d.id <> all($3) \
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

/// Re-render up to [`MAX_REFRESH_PER_QUERY`] notes whose cached text is older
/// than the document row (or missing). Failures are logged and skipped — a
/// stale snippet beats a failed search.
async fn refresh_stale_texts(state: &AppState, workspace_id: Uuid) {
    #[derive(serde::Deserialize)]
    struct Rendered {
        markdown: String,
    }

    let stale: Vec<(Uuid,)> = match sqlx::query_as(
        "select d.id from documents d \
         left join document_texts t on t.document_id = d.id \
         where d.workspace_id = $1 and not d.archived \
           and (t.document_id is null or t.rendered_at < d.updated_at) \
         order by d.updated_at desc limit $2",
    )
    .bind(workspace_id)
    .bind(MAX_REFRESH_PER_QUERY)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("search cache: stale query failed: {e}");
            return;
        }
    };

    for (doc_id,) in stale {
        let res: ApiResult<()> = async {
            let updates = crate::documents::load_content_updates(state, doc_id).await?;
            let text = if updates.is_empty() {
                String::new()
            } else {
                let r: Rendered = crate::proposals::run_diff_cli(serde_json::json!({
                    "mode": "render",
                    "updates": updates,
                }))
                .await?;
                r.markdown
            };
            sqlx::query(
                "insert into document_texts (document_id, workspace_id, text, rendered_at) \
                 values ($1, $2, $3, now()) \
                 on conflict (document_id) \
                 do update set text = excluded.text, rendered_at = now()",
            )
            .bind(doc_id)
            .bind(workspace_id)
            .bind(&text)
            .execute(&state.pool)
            .await?;
            Ok(())
        }
        .await;
        if let Err(e) = res {
            tracing::warn!("search cache: refresh of {doc_id} failed: {e}");
        }
    }
}
