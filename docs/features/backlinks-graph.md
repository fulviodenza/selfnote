# Backlinks & Graph View

## 1. Problem & goal

Selfnote notes are an isolated tree: there is no way to link one note to another, to
discover which notes reference the current page, or to see the workspace as a connected
web of ideas. This feature adds note-to-note links (inline references), a "notes that link
here" backlinks panel, and a graph view over the workspace, so users can navigate by
meaning rather than only by the page-tree hierarchy.

Because document *content* lives in the Yjs `document-store` CRDT (not in a queryable SQL
column), the client that owns the editor extracts outgoing links and reports them to the
server; the server stores them in a relational `document_links` table that powers the
backlinks panel and the graph. The graph also overlays parent/child tree edges, which are
already in SQL.

## 2. Data model & migration

New migration `server/migrations/0005_backlinks.sql`:

```sql
-- Note-to-note links extracted from document content (Yjs is opaque to SQL, so the
-- editor client reports the current set of outgoing links whenever content changes).
create table document_links (
    source_id    uuid not null references documents(id) on delete cascade,
    target_id    uuid not null references documents(id) on delete cascade,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    -- Optional human-readable anchor text of the link at authoring time (for previews).
    label        text,
    created_at   timestamptz not null default now(),
    primary key (source_id, target_id)
);

-- Backlinks lookup: "who links to target_id?"
create index document_links_target_idx on document_links (target_id);
-- Outgoing lookup + graph edges scoped to a workspace.
create index document_links_source_idx on document_links (source_id);
create index document_links_workspace_idx on document_links (workspace_id);
```

Notes:
- `(source_id, target_id)` is unique: a page linking to the same target multiple times is
  one edge. `label` holds the last-seen anchor text for that edge.
- Self-links (`source_id = target_id`) are rejected by the API, not the schema.
- Deleting either document cascades the edge away. Archiving does not delete edges; the
  API filters archived docs out of read responses.

## 3. API contract

All endpoints are under the existing axum app in `server/api/src/main.rs`. A new module
`server/api/src/links.rs` holds the handlers. Auth on every endpoint uses the existing
`AuthUser` extractor (JWT **or** `snp_` PAT — both accepted everywhere below), and every
endpoint checks workspace membership via `member_role`; a non-member gets `403`. All
document ids must belong to the caller's workspace or the endpoint returns `403`/`404`.

Shared JSON shapes:

```jsonc
// DocumentRef — a minimal document descriptor reused in responses
{ "id": "uuid", "title": "string", "icon": "string|null", "parent_id": "uuid|null" }
```

### 3.1 Replace outgoing links for a document

Called by the editor client whenever a document's link set changes (debounced). It is the
authoritative full set of outgoing links for `:id`; the server replaces all existing rows
where `source_id = :id`.

- **PUT** `/documents/:id/links`
- Auth: JWT or PAT. Caller must be `editor`/`admin`/`owner` on the doc's workspace
  (`viewer` → `403`).
- Request JSON:
```jsonc
{
  "links": [
    { "target_id": "uuid", "label": "string|null" }
  ]
}
```
- Behavior: transactionally deletes all `document_links` for `source_id = :id` and inserts
  the provided set. `target_id` values that are not documents in the same workspace, and
  any entry where `target_id == :id` (self-link), are silently dropped. Duplicate
  `target_id`s collapse to one (last `label` wins).
- Response `200`:
```jsonc
{ "source_id": "uuid", "count": 3 }   // count = edges stored after dedupe/filtering
```
- Errors: `403` (not a member / viewer), `404` (source doc not found), `400` (malformed
  body).

### 3.2 List outgoing links for a document

- **GET** `/documents/:id/links`
- Auth: JWT or PAT. Any workspace member (`viewer`+).
- Request: none.
- Response `200`:
```jsonc
{
  "outgoing": [
    { "target": { "id": "uuid", "title": "string", "icon": "string|null", "parent_id": "uuid|null" },
      "label": "string|null" }
  ]
}
```
- Archived targets are excluded. Errors: `403`, `404`.

### 3.3 Backlinks — notes that link *here*

- **GET** `/documents/:id/backlinks`
- Auth: JWT or PAT. Any workspace member (`viewer`+).
- Request: none.
- Response `200`:
```jsonc
{
  "backlinks": [
    { "source": { "id": "uuid", "title": "string", "icon": "string|null", "parent_id": "uuid|null" },
      "label": "string|null" }
  ]
}
```
- Ordered by `source.title` ascending. Archived sources are excluded. Errors: `403`, `404`.

### 3.4 Workspace graph

Returns the full node/edge set for the graph view: one node per non-archived document, link
edges from `document_links`, and tree edges from `documents.parent_id`.

- **GET** `/workspaces/:id/graph`
- Auth: JWT or PAT. Any workspace member (`viewer`+).
- Request: none.
- Response `200`:
```jsonc
{
  "nodes": [
    { "id": "uuid", "title": "string", "icon": "string|null", "parent_id": "uuid|null" }
  ],
  "edges": [
    { "source": "uuid", "target": "uuid", "kind": "link" },   // from document_links
    { "source": "uuid", "target": "uuid", "kind": "tree" }     // parent -> child
  ]
}
```
- `kind` is `"link"` or `"tree"`. Edges referencing archived nodes are omitted. Errors:
  `403` (not a member), `404` (workspace not found).

### 3.5 Resolve link targets by title (autocomplete)

Backs the "@ / [[" link picker in the editor. Thin wrapper over the existing title FTS,
scoped to a workspace and excluding archived + the current doc.

- **GET** `/documents/link-search?workspace_id=:wid&q=:query&exclude=:docId`
- Auth: JWT or PAT. Any workspace member (`viewer`+).
- `exclude` is optional (the doc being edited, to keep it out of results).
- Response `200`:
```jsonc
{ "results": [ { "id": "uuid", "title": "string", "icon": "string|null", "parent_id": "uuid|null" } ] }
```
- Limit 20, ordered by FTS rank then title. Errors: `403`.

## 4. Web UX (apps/web)

Link extraction. Note references are authored in `@selfnote/editor` (BlockNote) as an
inline link whose href uses a `selfnote:<docId>` scheme (e.g. `selfnote:UUID`). Add a `[[`
/ `@` trigger in the editor that opens a picker backed by `GET /documents/link-search`;
selecting a result inserts an inline link with `href = "selfnote:<id>"` and the target
title as anchor text. Clicking such a link inside the editor navigates to that doc instead
of opening the browser.

Sync. In `apps/web/src/api.ts` add `api.getDocLinks`, `api.putDocLinks`,
`api.getBacklinks`, `api.getGraph`, `api.linkSearch`. In `App.tsx`, the editor's existing
`onChange`/save path scans the current BlockNote document for inline links with the
`selfnote:` scheme, collects `{ target_id, label }`, and calls `PUT /documents/:id/links`
(debounced ~1s, same cadence as content persistence). Empty set is sent when the last link
is removed.

Backlinks panel. New component `apps/web/src/BacklinksPanel.tsx`, rendered inside the
document view in `App.tsx` (below/adjacent to the editor, collapsible, styled per
"Ink & Paper" `styles.css`). On `activeId` change it calls `GET
/documents/:id/backlinks`; shows a "Linked references" list of source pages (icon + title,
optional label snippet). Empty state: "No notes link here yet." Clicking an item sets
`activeId` to that source. Optionally show an "Outgoing links" subsection from `GET
/documents/:id/links`.

Graph view. New component `apps/web/src/GraphView.tsx`, opened from a "Graph" entry in the
`Sidebar` (a new top-level view alongside the page tree). Fetches `GET
/workspaces/:id/graph` and renders a force-directed graph (nodes = docs labeled by
title/icon; `link` edges solid, `tree` edges dashed/lighter). Clicking a node opens that
doc (sets `activeId`, closes graph). Node currently open is highlighted. Use a lightweight
canvas/SVG force layout (e.g. `d3-force`); no server-side layout.

## 5. Mobile UX (apps/mobile)

Strict parity with web, adapted to React Native / Expo. The BlockNote editor runs in the
existing WebView (`apps/mobile/src/editor`), so the `[[`/`@` link picker and inline
`selfnote:<id>` links are implemented in the WebView editor bridge exactly as on web, and
link extraction runs in the WebView, posting the extracted `{ target_id, label }[]` out to
React Native which calls `PUT /documents/:id/links`.

- API client: add the same five methods to `apps/mobile/src/api.ts`
  (`getDocLinks`, `putDocLinks`, `getBacklinks`, `getGraph`, `linkSearch`).
- Backlinks: a native RN `BacklinksPanel` component under the document screen — a
  `SectionList`/`FlatList` of "Linked references" (and optional "Outgoing links"). Tapping a
  row navigates to that document. Same empty-state copy.
- Link picker: rendered inside the WebView editor (native modal fallback acceptable); queries
  `GET /documents/link-search`.
- Graph: a native `GraphView` screen reachable from the mobile navigation/drawer (parity
  with the sidebar "Graph" entry). Render with an RN-compatible force graph (e.g.
  `react-native-svg` + a JS `d3-force` layout, or a WebView-hosted graph if simpler);
  pan/zoom via gestures; tapping a node opens the document. Same node/edge styling semantics
  (link solid, tree dashed).
- Offline: backlinks/graph require the network; when offline show the standard offline
  placeholder. Link extraction still runs locally and is flushed to
  `PUT /documents/:id/links` on reconnect (piggybacking existing sync/persistence).

## 6. Desktop

Desktop (Tauri 2) bundles `apps/web`, so implementing the web UX above covers desktop with
no extra work. Tauri specifics: the editor must intercept `selfnote:<id>` link clicks and
route them in-app (do **not** hand them to the OS/Tauri shell opener, which would try to
launch an external handler). If web already prevents default navigation on `selfnote:`
links, no Tauri-specific code is needed. Otherwise: none.

## 7. Acceptance criteria + parity checklist

Acceptance criteria:
1. Migration `0005_backlinks.sql` creates `document_links` with the three indexes and the
   composite PK; applies cleanly.
2. Authoring a `[[`/`@` link in the editor inserts an inline `selfnote:<id>` link, and
   within ~1s a `PUT /documents/:id/links` stores the edge (verified in `document_links`).
3. `GET /documents/:id/backlinks` returns every non-archived source that links to `:id`,
   excludes archived sources, and reflects link removals after the next `PUT`.
4. `GET /documents/:id/links` returns the current outgoing set, excluding archived targets.
5. `GET /workspaces/:id/graph` returns all non-archived nodes plus `link` and `tree` edges;
   edges touching archived nodes are omitted.
6. Deleting a document removes all its edges (cascade); self-links and cross-workspace
   targets are dropped by `PUT`, never stored.
7. Every endpoint accepts both a JWT and a `snp_` PAT; non-members get `403`; `viewer`s can
   read but cannot `PUT` links.
8. Clicking a backlink, an outgoing link, or a graph node opens the correct document on web,
   desktop, and mobile.
9. `link-search` returns matching non-archived docs in the workspace, excluding `exclude`.

Parity checklist (web ⇄ mobile):

| Capability | Web (apps/web) | Mobile (apps/mobile) |
| --- | --- | --- |
| `[[`/`@` link picker (link-search) | ✅ WebView-less editor | ✅ WebView editor |
| Insert inline `selfnote:<id>` link | ✅ | ✅ |
| Extract links → `PUT /documents/:id/links` (debounced) | ✅ | ✅ |
| In-app navigation on link click | ✅ | ✅ |
| Backlinks panel ("Linked references") | ✅ | ✅ |
| Outgoing links subsection | ✅ | ✅ |
| Graph view (link + tree edges) | ✅ | ✅ |
| Node/backlink tap opens document | ✅ | ✅ |
| Empty-state copy identical | ✅ | ✅ |
| JWT + PAT auth against same endpoints | ✅ | ✅ |
