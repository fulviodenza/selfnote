# Editor Slash Commands

Status: proposed · Owner: product/API architect · Target apps: web, desktop, mobile

## 1. Problem & goal

Inserting structured blocks (tables, cross-note links) and invoking AI today
requires leaving the keyboard for a toolbar or the Assist panel, which breaks
writing flow. This feature adds an in-editor slash menu: typing `/` at the start
of an empty line (or after whitespace) opens a filterable command list so a user
can insert `/table`, run `/ai-summarize`, or embed a `/link-note` reference
without touching the mouse — with strict parity across web, desktop, and mobile.

## 2. Data model & migration

None. Tables are native BlockNote blocks (stored in the existing Yjs
`document-store` fragment). Note links reference `documents.id`, which already
exists. AI summarize reuses `POST /ai/complete`. No new tables or columns.

## 3. API contract

No new endpoints are introduced. The slash menu is a client feature that
composes three existing endpoints. This section pins the exact request/response
shapes the web and mobile agents must code against; they are the source of truth.

### 3.1 `/table` — insert a table

Pure client-side. Inserts a native BlockNote `table` block at the cursor. No
network call.

### 3.2 `/link-note` — pick a note to link

The picker is populated by the **existing** document endpoints; no new route.

**A. Query as the user types (>= 1 char):**

`GET /documents/search?workspace_id={uuid}&q={string}`
- Auth: JWT access token (`Authorization: Bearer <access>`), refresh-and-retry on 401.
- Request: query params only. `workspace_id` (uuid, required), `q` (string, required, non-empty). Caller must be a member of the workspace (else 403).
- Response `200`: `Document[]` (FTS over title, `not archived`, max 50), each:
  ```json
  {
    "id": "uuid",
    "workspace_id": "uuid",
    "parent_id": "uuid|null",
    "title": "string",
    "icon": "string|null",
    "archived": false,
    "created_at": "RFC3339",
    "updated_at": "RFC3339"
  }
  ```

**B. Empty query (initial open, show recents):** since FTS returns `[]` for an
empty `q`, the client instead calls the already-used list endpoint and shows the
most recently updated non-archived docs:

`GET /documents?workspace_id={uuid}`
- Auth: JWT access token; refresh-and-retry on 401.
- Response `200`: `Document[]` (same shape as above). Client sorts by
  `updated_at` desc and shows the top 10 as "recent".

On selection the client inserts an inline link into the current block whose text
is the note `title` and whose href is the app route to that document
(`#/doc/{id}` on web, an in-app navigation payload on mobile). No write to the
server beyond the normal Yjs sync of the edited block.

### 3.3 `/ai-summarize` — summarize the note

Only offered when `GET /ai/status` reports `available: true` and its `features`
array contains `"summarize"`; otherwise the item is hidden (no dead command).

`POST /ai/complete`
- Auth: JWT access token; refresh-and-retry on 401.
- Request JSON:
  ```json
  {
    "doc_id": "uuid",        // current document; server authorizes workspace membership
    "intent": "summarize",   // fixed for this command
    "context": "string"      // plain text of the current note (client-extracted)
  }
  ```
  (`prompt` and `selection` are omitted for this command.)
- Response `200`:
  ```json
  { "text": "string" }   // summary, typically a few bullet points
  ```
- Errors: `403` (not a member of the doc's workspace), `404` (doc_id unknown),
  `409` (`no AI provider configured`).

Client behavior: insert the returned `text` as a new block (parsed
markdown → blocks) immediately below the current block. If AI is unavailable the
command is not shown.

### 3.4 `GET /ai/status` (already consumed by clients)
- Auth: JWT access token. Response: `{ available, provider, model, features[] }`.
- Used only to decide whether `/ai-summarize` appears in the menu.

Summary: no new server routes — `/table` is local; `/link-note` reads
`GET /documents/search` (typing) and `GET /documents` (recents); `/ai-summarize`
POSTs `/ai/complete` with `intent:"summarize"`, gated on `GET /ai/status`.

## 4. Web UX (apps/web)

- **Where it hooks in:** `packages/editor/src/index.tsx` (`CollaborativeEditor`).
  BlockNote already renders a default `/` slash menu; we override its item list
  via `<BlockNoteView>`'s `slashMenu={false}` plus a `SuggestionMenuController`
  (from `@blocknote/react`) with a custom `getItems`.
- **Items** (`getDefaultReactSlashMenuItems(editor)` spread in, then our three):
  - `Table` — `title: "Table"`, aliases `["table","grid"]`, group "Blocks";
    `onItemClick` inserts a `table` block via `editor.insertBlocks`.
  - `AI summarize` — `title: "AI summarize"`, aliases `["ai","summary","summarize"]`,
    group "AI". Only pushed when `aiStatus.available && features.includes("summarize")`.
    On click: extract note text (`await editor.blocksToMarkdownLossy(editor.document)`),
    call `api.aiComplete({ doc_id, intent:"summarize", context })`, then
    `editor.tryParseMarkdownToBlocks(text)` and `editor.insertBlocks(blocks, currentBlock, "after")`.
    Show inline "Summarizing…" placeholder and a toast on `409`/error.
  - `Link note` — `title: "Link note"`, aliases `["link","note","mention"]`, group
    "Blocks". Opens a secondary picker (a `SuggestionMenuController` triggered on
    `@`, or a lightweight popover component `LinkNotePopover.tsx`) that debounces
    input (~200 ms) and calls `api.searchDocuments(workspaceId, q)`; empty query
    shows recents from `api.listDocuments`. Selecting inserts an inline link.
- **New/changed props:** `CollaborativeEditor` gains `workspaceId: string`,
  `docId: string`, `aiAvailable: boolean` (or an `aiFeatures: string[]`), and an
  `onNavigateToDoc?(id)` callback, all threaded from `App.tsx`.
- **API client (`apps/web/src/api.ts`):** add
  `searchDocuments(workspaceId, q) => req<Document[]>("/documents/search?workspace_id=…&q=…")`.
  `listDocuments` and `aiComplete`/`aiStatus` already exist.
- **Styling:** reuse "Ink & Paper" tokens in `apps/web/src/styles.css`; menu uses
  BlockNote/Mantine theming already wired via `BlockNoteView theme`.

## 5. Mobile UX (apps/mobile) — strict parity

The mobile editor is BlockNote inside a WebView (`apps/mobile/src/editor/`),
so the same three commands ship, adapted to RN + the bridge.

- **`editorHtml.ts` / `WebViewEditor.tsx`:** enable the same custom
  `SuggestionMenuController` inside the WebView bundle. `/table` runs entirely in
  the WebView (native BlockNote block) — no bridge needed.
- **Bridge messages** (WebView ⇄ RN, via `window.ReactNativeWebView.postMessage`
  and injected JS) mirror the web network calls, because network + auth live on
  the RN side (`apps/mobile/src/api.ts`):
  - `linkNoteQuery { requestId, q }` → RN calls `api.searchDocuments` (or
    `api.listDocuments` for empty `q`) → posts back `linkNoteResults { requestId, docs[] }`;
    WebView renders results in the picker and inserts the inline link on tap.
  - `aiSummarize { requestId, doc_id, context }` → RN calls
    `api.aiComplete({doc_id, intent:"summarize", context})` → posts back
    `aiSummarizeResult { requestId, text }` or `aiSummarizeError { requestId, message }`;
    WebView parses markdown → blocks and inserts after the current block.
  - `/ai-summarize` item is injected only when RN passes `aiAvailable`/`aiFeatures`
    (from `api.aiStatus`) into the WebView on init, matching web gating.
- **API client (`apps/mobile/src/api.ts`):** add the same `searchDocuments`
  method (mirrors web). `listDocuments`, `aiComplete`, `aiStatus` already exist.
- **Touch adaptation:** picker is a full-width list / bottom sheet
  (`src/ui/Sheet.tsx`) instead of a floating popover; slash menu items are
  larger tap targets. Behavior and command set are otherwise identical to web.

## 6. Desktop

Inherits the web build (Tauri 2 bundles `apps/web`). No Tauri-specific work: all
three commands are HTTP + local editor operations already available in the
WebView. None.

## 7. Acceptance criteria + parity checklist

Acceptance criteria:
1. Typing `/` in an empty block (or after whitespace) opens the slash menu;
   typing filters items by title/alias; `Esc` or deleting the `/` closes it.
2. `/table` inserts an editable BlockNote table at the cursor with no network call,
   and the table syncs to collaborators via Yjs.
3. `/link-note` opens a picker: empty input shows up to 10 recent notes; typing
   queries `GET /documents/search`; selecting inserts an inline link whose text is
   the note title and which navigates to that doc when activated.
4. `/ai-summarize` appears only when `/ai/status` reports `available` with feature
   `summarize`; running it inserts the summary as block(s) below the current block;
   a `409`/network error surfaces a toast and inserts nothing.
5. Menu items respect read-only mode (`editable=false` hides insert commands).
6. No new migrations; no new server routes; existing endpoints unchanged.

Parity checklist (web ⇄ mobile — every row must be true on both):

| Capability | Web | Mobile |
| --- | --- | --- |
| `/` opens filterable slash menu | ✅ | ✅ |
| `/table` inserts native table (no network) | ✅ | ✅ |
| `/link-note` recents on empty query (`GET /documents`) | ✅ | ✅ |
| `/link-note` search on typing (`GET /documents/search`) | ✅ | ✅ |
| Inline link inserts + navigates to doc | ✅ | ✅ |
| `/ai-summarize` gated on `GET /ai/status` feature `summarize` | ✅ | ✅ |
| `/ai-summarize` inserts summary via `POST /ai/complete` | ✅ | ✅ |
| Error/no-provider handled with user feedback | ✅ | ✅ |
| Commands hidden when editor is read-only | ✅ | ✅ |
