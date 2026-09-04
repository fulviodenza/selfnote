//! Backlinks & graph view.
//!
//! Note-to-note links live in the relational `document_links` table because the
//! document body is an opaque Yjs CRDT: the editor client extracts outgoing links
//! from the current content and reports the full set here (see `set_links`). Those
//! rows power the backlinks panel (`backlinks`), the outgoing-links list (`links`),
//! and the workspace graph (`graph`, which also overlays parent/child tree edges).

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::documents::get_document;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::workspaces::member_role;

/// A minimal document descriptor reused across link responses.
#[derive(Debug, Serialize, FromRow)]
pub struct DocumentRef {
    pub id: Uuid,
    pub title: String,
    pub icon: Option<String>,
    pub parent_id: Option<Uuid>,
}

/// Load a doc, `404` if missing, and assert the caller is a member (any role)
/// of its workspace (`403` otherwise). Returns the doc and the caller's role.
async fn authorize_doc(
    state: &AppState,
    user_id: Uuid,
    doc_id: Uuid,
) -> ApiResult<(crate::documents::Document, String)> {
    let doc = get_document(state, doc_id).await?;
    match member_role(state, doc.workspace_id, user_id).await? {
        Some(role) => Ok((doc, role)),
        None => Err(AppError::Forbidden),
    }
}

/* -------------------------------------------------- PUT /documents/:id/links */

#[derive(Debug, Deserialize)]
pub struct LinkInput {
    pub target_id: Uuid,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetLinks {
    #[serde(default)]
    pub links: Vec<LinkInput>,
}

#[derive(Debug, Serialize)]
pub struct SetLinksResp {
    pub source_id: Uuid,
    pub count: usize,
}

/// `PUT /documents/:id/links` — authoritative full replace of the outgoing link
/// set for `:id`. Deletes every existing edge with `source_id = :id` and inserts
/// the provided set in one transaction. `target_id`s that are not documents in
/// the same workspace, and self-links (`target_id == :id`), are silently dropped.
/// Duplicate `target_id`s collapse to one row (last `label` wins).
///
/// Caller must be `editor`/`admin`/`owner` on the workspace (`viewer` → `403`).
pub async fn set_links(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<SetLinks>,
) -> ApiResult<Json<SetLinksResp>> {
    let (src, role) = authorize_doc(&state, user.id, doc_id).await?;
    if role == "viewer" {
        return Err(AppError::Forbidden);
    }

    // Collapse duplicates (last label wins) and drop self-links, preserving the
    // first-seen order for the final insert.
    let mut order: Vec<Uuid> = Vec::new();
    let mut labels: std::collections::HashMap<Uuid, Option<String>> =
        std::collections::HashMap::new();
    for link in body.links {
        if link.target_id == doc_id {
            continue;
        }
        if !labels.contains_key(&link.target_id) {
            order.push(link.target_id);
        }
        labels.insert(link.target_id, link.label);
    }

    // Keep only targets that are real documents in the same workspace.
    let mut targets: Vec<Uuid> = Vec::new();
    if !order.is_empty() {
        let valid: Vec<(Uuid,)> = sqlx::query_as(
            "select id from documents where id = any($1) and workspace_id = $2",
        )
        .bind(&order)
        .bind(src.workspace_id)
        .fetch_all(&state.pool)
        .await?;
        let valid_set: std::collections::HashSet<Uuid> = valid.into_iter().map(|r| r.0).collect();
        for id in order {
            if valid_set.contains(&id) {
                targets.push(id);
            }
        }
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("delete from document_links where source_id = $1")
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;
    for &t in &targets {
        sqlx::query(
            "insert into document_links (source_id, target_id, workspace_id, label) \
             values ($1, $2, $3, $4)",
        )
        .bind(doc_id)
        .bind(t)
        .bind(src.workspace_id)
        .bind(labels.get(&t).and_then(|l| l.clone()))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(Json(SetLinksResp {
        source_id: doc_id,
        count: targets.len(),
    }))
}

/* -------------------------------------------------- GET /documents/:id/links */

#[derive(Debug, Serialize)]
pub struct OutgoingLink {
    pub target: DocumentRef,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OutgoingLinks {
    pub outgoing: Vec<OutgoingLink>,
}

#[derive(Debug, FromRow)]
struct LinkRow {
    id: Uuid,
    title: String,
    icon: Option<String>,
    parent_id: Option<Uuid>,
    label: Option<String>,
}

/// `GET /documents/:id/links` — the current outgoing links for `:id`. Archived
/// targets are excluded. Any workspace member (`viewer`+) may read.
pub async fn links(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<OutgoingLinks>> {
    authorize_doc(&state, user.id, doc_id).await?;

    let rows: Vec<LinkRow> = sqlx::query_as(
        "select d.id, d.title, d.icon, d.parent_id, l.label \
         from document_links l \
         join documents d on d.id = l.target_id \
         where l.source_id = $1 and not d.archived \
         order by d.title asc",
    )
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;

    let outgoing = rows
        .into_iter()
        .map(|r| OutgoingLink {
            target: DocumentRef {
                id: r.id,
                title: r.title,
                icon: r.icon,
                parent_id: r.parent_id,
            },
            label: r.label,
        })
        .collect();
    Ok(Json(OutgoingLinks { outgoing }))
}

/* ---------------------------------------------- GET /documents/:id/backlinks */

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub source: DocumentRef,
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Backlinks {
    pub backlinks: Vec<Backlink>,
}

/// `GET /documents/:id/backlinks` — notes that link *here*. Archived sources are
/// excluded, ordered by `source.title` ascending. Any workspace member reads.
pub async fn backlinks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(doc_id): Path<Uuid>,
) -> ApiResult<Json<Backlinks>> {
    authorize_doc(&state, user.id, doc_id).await?;

    let rows: Vec<LinkRow> = sqlx::query_as(
        "select d.id, d.title, d.icon, d.parent_id, l.label \
         from document_links l \
         join documents d on d.id = l.source_id \
         where l.target_id = $1 and not d.archived \
         order by d.title asc",
    )
    .bind(doc_id)
    .fetch_all(&state.pool)
    .await?;

    let backlinks = rows
        .into_iter()
        .map(|r| Backlink {
            source: DocumentRef {
                id: r.id,
                title: r.title,
                icon: r.icon,
                parent_id: r.parent_id,
            },
            label: r.label,
        })
        .collect();
    Ok(Json(Backlinks { backlinks }))
}

/* --------------------------------------------------- GET /workspaces/:id/graph */

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: Uuid,
    pub target: Uuid,
    /// `"link"` (from `document_links`) or `"tree"` (parent → child).
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<DocumentRef>,
    pub edges: Vec<GraphEdge>,
}

/// `GET /workspaces/:id/graph` — one node per non-archived document, link edges
/// from `document_links`, and tree edges from `documents.parent_id`. Edges that
/// reference an archived (or missing) node are omitted. Any workspace member reads.
pub async fn graph(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<Json<Graph>> {
    // Membership check; `404` if the workspace itself does not exist.
    let exists: Option<(Uuid,)> = sqlx::query_as("select id from workspaces where id = $1")
        .bind(workspace_id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    if member_role(&state, workspace_id, user.id).await?.is_none() {
        return Err(AppError::Forbidden);
    }

    #[derive(FromRow)]
    struct NodeRow {
        id: Uuid,
        title: String,
        icon: Option<String>,
        parent_id: Option<Uuid>,
    }
    let node_rows: Vec<NodeRow> = sqlx::query_as(
        "select id, title, icon, parent_id from documents \
         where workspace_id = $1 and not archived",
    )
    .bind(workspace_id)
    .fetch_all(&state.pool)
    .await?;

    let live: std::collections::HashSet<Uuid> = node_rows.iter().map(|n| n.id).collect();

    let mut edges: Vec<GraphEdge> = Vec::new();

    // Link edges. Filter to edges whose endpoints are both live nodes.
    let link_rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "select source_id, target_id from document_links where workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_all(&state.pool)
    .await?;
    for (source, target) in link_rows {
        if live.contains(&source) && live.contains(&target) {
            edges.push(GraphEdge {
                source,
                target,
                kind: "link",
            });
        }
    }

    // Tree edges: parent -> child, both endpoints live.
    for n in &node_rows {
        if let Some(parent) = n.parent_id {
            if live.contains(&parent) {
                edges.push(GraphEdge {
                    source: parent,
                    target: n.id,
                    kind: "tree",
                });
            }
        }
    }

    let nodes = node_rows
        .into_iter()
        .map(|n| DocumentRef {
            id: n.id,
            title: n.title,
            icon: n.icon,
            parent_id: n.parent_id,
        })
        .collect();

    Ok(Json(Graph { nodes, edges }))
}

/* ------------------------------------------------ GET /documents/link-search */

#[derive(Debug, Deserialize)]
pub struct LinkSearchQuery {
    pub workspace_id: Uuid,
    pub q: String,
    /// The doc being edited, kept out of results.
    pub exclude: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct LinkSearchResults {
    pub results: Vec<DocumentRef>,
}

/// `GET /documents/link-search?workspace_id=&q=&exclude=` — title FTS scoped to a
/// workspace, excluding archived docs and `exclude`. Limit 20, ordered by FTS
/// rank then title. Any workspace member (`viewer`+).
pub async fn link_search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<LinkSearchQuery>,
) -> ApiResult<Json<LinkSearchResults>> {
    if member_role(&state, q.workspace_id, user.id)
        .await?
        .is_none()
    {
        return Err(AppError::Forbidden);
    }

    let results: Vec<DocumentRef> = sqlx::query_as(
        "select id, title, icon, parent_id from documents \
         where workspace_id = $1 and not archived and ($3::uuid is null or id <> $3) \
           and to_tsvector('english', title) @@ websearch_to_tsquery('english', $2) \
         order by ts_rank(to_tsvector('english', title), websearch_to_tsquery('english', $2)) desc, \
                  title asc \
         limit 20",
    )
    .bind(q.workspace_id)
    .bind(&q.q)
    .bind(q.exclude)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(LinkSearchResults { results }))
}
