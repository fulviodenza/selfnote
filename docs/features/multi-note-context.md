# Multi-note context

## 1. Problem & goal

Today the AI chat sidebar is grounded only in the single note the user is currently editing (the client passes `context` as the current note's Markdown). Users frequently reason across several related notes — a note that links to others, or notes they just visited — and the assistant is blind to all of them. Goal: let the chat pull in a small, explicit set of *additional* notes (linked and/or recently-viewed) as extra grounding context, chosen client-side and authorized + rendered server-side, with strict web ⇄ mobile parity.

## 2. Data model & migration

Two needs: (a) an explicit **note→note link** graph so "linked notes" is a server fact, not a client guess; (b) a **recently-viewed** log so any client (including a fresh device) can offer the same suggestions. Both are additive; content still lives in Yjs.

Next migration number is **0005** (highest existing is `0004_api_tokens.sql`).

`server/migrations/0005_multi_note_context.sql`:

```sql
-- Multi-note context: explicit note-to-note links + a per-user recently-viewed log.

-- Directed link from one document to another (e.g. an @-mention / inline ref in
-- the editor). The editor upserts these; the AI chat reads them to offer "linked
-- notes" as extra context. Self-links are disallowed.
create table document_links (
    src_doc_id uuid not null references documents(id) on delete cascade,
    dst_doc_id uuid not null references documents(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (src_doc_id, dst_doc_id),
    check (src_doc_id <> dst_doc_id)
);
create index document_links_src_idx on document_links (src_doc_id);
create index document_links_dst_idx on document_links (dst_doc_id);

-- Per-user recently-viewed notes, one row per (user, document). Upserted on open;
-- `viewed_at` bumped each visit. Trimmed to a bounded window by the API on write.
create table recent_documents (
    user_id   uuid not null references users(id) on delete cascade,
    doc_id    uuid not null references documents(id) on delete cascade,
    viewed_at timestamptz not null default now(),
    primary key (user_id, doc_id)
);
create index recent_documents_user_idx on recent_documents (user_id, viewed_at desc);
```

Notes:
- No plaintext of note bodies is stored; content is reconstructed by the client from Yjs and passed as Markdown (matching the existing `context` flow). The server never needs to render CRDT to text for this feature.
- `document_links` is workspace-agnostic in the schema; the API enforces that both endpoints are in a workspace the caller can access.

## 3. API contract

All endpoints accept **either** a JWT access token (`Authorization: Bearer <jwt>`) **or** a `snp_` personal access token — i.e. the standard `AuthUser` extractor. No public/anonymous access. All bodies are `application/json`; all timestamps are RFC 3339 strings. `doc_id`s are UUID strings. Errors use the existing envelope: `404` not found, `403` forbidden (caller not a member of the doc's workspace), `409` when no AI provider is configured.

Authorization rule applied everywhere a `doc_id` appears: the caller must be a member (any role) of that document's workspace, or the request fails `403` (or `404` if the doc does not exist). This is enforced per doc for every id in a list.

---

### 3.1 `POST /documents/:id/viewed` — record a view

Idempotent upsert into `recent_documents` for the authenticated user; bumps `viewed_at` to now and trims the user's log to the most recent 50 rows.

- Auth: JWT or PAT.
- Path: `:id` = document UUID.
- Request JSON: none (empty body `{}` accepted).
- Response `200`:
```json
{ "ok": true }
```
- Errors: `404` doc missing, `403` not a workspace member.

---

### 3.2 `GET /documents/recent?limit=N` — recently-viewed notes

Returns the caller's recently-viewed, non-archived documents, newest first.

- Auth: JWT or PAT.
- Query: `limit` optional integer, default `10`, clamped to `1..=50`.
- Response `200`:
```json
{
  "documents": [
    {
      "id": "0e6b…",
      "workspace_id": "a1f2…",
      "title": "Roadmap Q3",
      "icon": "📌",
      "viewed_at": "2026-09-04T10:12:03Z"
    }
  ]
}
```
- `archived` documents are excluded. Only documents whose workspace the caller can still access are returned (stale rows for lost-access docs are silently filtered).

---

### 3.3 `GET /documents/:id/links` — linked notes

Returns documents linked **from** `:id` (outgoing edges), and optionally back-links.

- Auth: JWT or PAT.
- Path: `:id` = source document UUID.
- Query: `direction` optional, one of `out` (default) | `in` | `both`.
- Response `200`:
```json
{
  "documents": [
    {
      "id": "9c3d…",
      "workspace_id": "a1f2…",
      "title": "Design principles",
      "icon": null,
      "direction": "out"
    }
  ]
}
```
- `direction` per item is `"out"` (`:id`→item) or `"in"` (item→`:id`). Archived and inaccessible docs are excluded.
- Errors: `404` if `:id` missing, `403` if caller can't access `:id`.

---

### 3.4 `PUT /documents/:id/links` — replace outgoing links

The editor calls this to declare the set of notes `:id` links to (full replace of outgoing edges for `:id`). Used to keep `document_links` in sync with inline references.

- Auth: JWT or PAT.
- Path: `:id` = source document UUID.
- Request JSON:
```json
{ "targets": ["9c3d…", "2b7e…"] }
```
- Semantics: deletes all existing rows with `src_doc_id = :id` and inserts one row per target. Self-references and duplicates are ignored. Every target must be a document the caller can access **and** be in the same workspace as `:id`; otherwise `403`. Missing target → `404`.
- Response `200`:
```json
{ "count": 2 }
```
- `count` is the number of link rows persisted.

---

### 3.5 `POST /ai/chat` and `POST /ai/chat/stream` — extended with `extra_docs`

Both existing endpoints gain **one optional field**, `extra_docs`: an ordered list of additional notes to fold into the system prompt as grounding context, alongside the existing single-note `context`/`selection`. The response shape and SSE framing are unchanged (`/ai/chat` → `{ "text": … }`; `/ai/chat/stream` → `data: {"delta":…}` events, then `event: done`, or `event: error`).

- Auth: JWT or PAT.
- Request JSON (additions in **bold**, everything else unchanged):
```json
{
  "doc_id": "0e6b…",
  "messages": [{ "role": "user", "content": "How does this relate to my roadmap?" }],
  "context": "# Current note markdown…",
  "selection": null,
  "extra_docs": [
    {
      "doc_id": "a12f…",
      "title": "Roadmap Q3",
      "text": "# Roadmap Q3\n- ship sync…",
      "source": "linked"
    }
  ]
}
```
- `extra_docs[]` fields:
  - `doc_id` (string, required): used for authorization — the caller must be a member of that doc's workspace or the whole request fails `403` (`404` if missing).
  - `title` (string, optional): human label injected into the prompt.
  - `text` (string, required): the note body as Markdown, produced client-side from Yjs exactly like `context`.
  - `source` (string, optional): `"linked"` | `"recent"` | `"manual"` — advisory only, surfaced back in no response; used for prompt labeling.
- Server behavior:
  - Authorizes `doc_id` and every `extra_docs[].doc_id` (existing `authorize_doc` logic, applied per id).
  - Injects each extra doc into the system prompt under a clearly delimited "Related notes" section, in order, labeled by `title`. A combined budget caps total injected context (current + related) at **`MAX_CONTEXT_CHARS` (24 000) per note**, and at most **6** `extra_docs` are honored (excess ignored, earliest kept).
  - `extra_docs` omitted or `[]` ⇒ behavior identical to today.
- Response: unchanged from current `/ai/chat` and `/ai/chat/stream`.

> Design note: bodies are sent by the client (not fetched server-side) because note content lives in Yjs and only the client cheaply renders it to Markdown — consistent with the existing `context` field. The `doc_id`s make the server the authority on *access*, closing the "AI as a read-around" hole.

## 4. Web UX (apps/web)

Hook point: `apps/web/src/AssistPanel.tsx` (the chat sidebar) and `apps/web/src/api.ts`.

- **api.ts**: extend `ChatRequest` with `extra_docs?: ExtraDoc[]`; add `ExtraDoc { doc_id: string; title?: string; text: string; source?: "linked" | "recent" | "manual" }`. Add client methods: `markViewed(docId)` → `POST /documents/:id/viewed`; `recentDocuments(limit?)` → `GET /documents/recent`; `documentLinks(docId, direction?)` → `GET /documents/:id/links`; `setDocumentLinks(docId, targets)` → `PUT /documents/:id/links`.
- **View tracking**: when a document is opened in the editor (App.tsx doc-load effect), call `markViewed(docId)` fire-and-forget.
- **Context chips row** (new component `ContextPicker.tsx`, rendered in `AssistPanel` above the composer): a horizontal row of dismissible chips representing notes that will be sent as `extra_docs`. Each chip shows the note icon + title and a source tag (Linked / Recent). An "+ Add note" affordance opens a small popover listing:
  - **Linked** notes from `documentLinks(currentDocId)`,
  - **Recent** notes from `recentDocuments()`, minus the current note and already-selected ones,
  - a search box that reuses `GET /documents/search` for the "manual" case.
- **Sending**: on submit, `AssistPanel` builds `extra_docs` by resolving each selected note's Markdown via the editor/CRDT (reuse the same `blocksToMarkdownLossy` path already used for `context`; for notes not currently open, load their content via existing content API + a headless Yjs→Markdown render, or fetch a lightweight render helper). Attach to the `aiChatStream` body.
- **Defaults & controls**: no notes are auto-attached; the user opts in. A "Pull in linked notes" one-tap button pre-fills chips from `documentLinks`. Chips persist for the session per doc; clearing the conversation clears chips. Respect the existing budget (client may truncate long bodies before sending; server also enforces).
- **Empty/disabled states**: if `/ai/status` reports no provider, the whole picker is hidden (consistent with existing Assist gating). If a note has no links and no recents, the popover shows a search-only state.

## 5. Mobile UX (apps/mobile)

Strict parity with web, adapted to React Native. Hook points: `apps/mobile/src/api.ts` and the chat screen/sheet that calls `aiChatStream`.

- **api.ts**: mirror the web additions — extend `ChatRequest` with `extra_docs`, add the same `ExtraDoc` type, and add `markViewed`, `recentDocuments`, `documentLinks`, `setDocumentLinks` using the app's `getSettings().apiUrl` + bearer/PAT auth and the same 401-refresh pattern already used by `aiChatStream`.
- **View tracking**: call `markViewed(docId)` when a note opens in the WebView editor screen.
- **Context picker**: a horizontally scrolling row of chips above the chat composer (same information: icon, title, source tag, dismiss). "+ Add note" opens a bottom sheet (`ContextPickerSheet`) with three sections — Linked / Recent / Search — identical data sources to web (`documentLinks`, `recentDocuments`, `documents/search`).
- **Sending**: resolve each selected note's Markdown from the WebView BlockNote bridge / expo-sqlite cache (the same mechanism that yields the current note's `context`), assemble `extra_docs`, and pass to `aiChatStream`. Apply the same per-note truncation before send.
- **Defaults & controls**: opt-in only; "Pull in linked notes" chip-fill button; chips scoped to the session per doc; picker hidden when `/ai/status` reports no provider.
- Same budget (≤6 notes, ≤24 000 chars each) and same empty/search-only states as web.

## 6. Desktop

Inherits the web build via Tauri 2 (bundles `apps/web`), so the feature ships automatically once web is done. No Tauri-specific work: all new endpoints are same-origin HTTP calls already used by the web client, no native plugins, filesystem, or IPC involved. **Tauri specifics: none.**

## 7. Acceptance criteria + parity checklist

Acceptance criteria:
- Migration `0005_multi_note_context.sql` applies cleanly; `document_links` and `recent_documents` exist with the specified keys/indexes/checks.
- `POST /documents/:id/viewed` upserts and trims the caller's log to 50; `GET /documents/recent` returns newest-first, non-archived, access-filtered notes honoring `limit` (default 10, clamp 1–50).
- `GET /documents/:id/links` returns access-filtered, non-archived linked docs with correct `direction` for `out`/`in`/`both`; `PUT /documents/:id/links` full-replaces outgoing edges, rejects cross-workspace/inaccessible targets with `403`, ignores self/dupes, returns `count`.
- `/ai/chat` and `/ai/chat/stream` accept `extra_docs`, authorize every `doc_id` (per-id `403`/`404`), inject related notes into the system prompt under a delimited section, cap at ≤6 notes and ≤24 000 chars/note, and are byte-for-byte backward compatible when `extra_docs` is absent.
- An unauthorized `extra_docs[].doc_id` fails the whole chat request `403` (no partial leak).
- Web: opening a note records a view; chips can be added from Linked/Recent/Search and dismissed; selected notes reach the model (verifiable via the prompt/response referencing them); picker hidden when no provider.
- Mobile: all of the above via the RN chat sheet and bottom-sheet picker.

Parity checklist (web ⇄ mobile — every row must be present on both):

| Capability | Web (apps/web) | Mobile (apps/mobile) |
|---|---|---|
| Record view on note open (`markViewed`) | ☐ | ☐ |
| Recently-viewed source (`recentDocuments`) | ☐ | ☐ |
| Linked-notes source (`documentLinks`) | ☐ | ☐ |
| Manual add via `documents/search` | ☐ | ☐ |
| Context chips: add / dismiss / source tag | ☐ | ☐ |
| "Pull in linked notes" one-tap fill | ☐ | ☐ |
| Resolve note body → Markdown for `extra_docs` | ☐ | ☐ |
| Per-note truncation before send | ☐ | ☐ |
| Send `extra_docs` on chat + stream | ☐ | ☐ |
| Picker hidden when `/ai/status` has no provider | ☐ | ☐ |
| Chips scoped per-doc for the session | ☐ | ☐ |
