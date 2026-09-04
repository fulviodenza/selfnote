# Diff-preview for AI edits

## 1. Problem & goal

Today an AI edit (`update_note`/`append_to_note` via MCP, or an in-app AI insertion) is written straight into a note's CRDT log with no chance to review it — a remote MCP client can silently rewrite a whole document. The goal is a **staged edit**: any AI-originated write produces a *proposal* (with a human-readable diff) that is persisted but not applied, and only becomes a real Yjs update when a human explicitly **accepts** it in the web/mobile app. Users get a clear before/after view and an approve-or-reject gate, especially for remote writes.

## 2. Data model & migration

Next migration number is **0005** (highest existing is `0004_api_tokens.sql`).

New table `ai_edit_proposals`. It stores the staged Yjs diff (base64), the base state vector the diff was computed against (so we can detect drift), and a Markdown before/after for rendering. Status flows `pending → applied | rejected | superseded`.

```sql
-- server/migrations/0005_ai_edit_proposals.sql
--
-- Staged AI edits. An AI write (MCP update_note/append_to_note, or an in-app AI
-- insertion) is recorded here as a base64 Yjs diff instead of being applied to
-- the note's content log. A human reviews the before/after in the app and either
-- accepts it (the diff is appended to doc content) or rejects it. `base_sv` is the
-- state vector the diff was computed against; if the note has moved on we mark the
-- proposal `superseded` on accept rather than corrupting the doc.
create table ai_edit_proposals (
    id            uuid primary key default gen_random_uuid(),
    document_id   uuid not null references documents(id) on delete cascade,
    workspace_id  uuid not null references workspaces(id) on delete cascade,
    -- Who/what created it. `created_by` is the user the credential belongs to.
    created_by    uuid not null references users(id) on delete cascade,
    -- 'mcp' (remote PAT), 'app' (in-app AI insertion). Free-form for future sources.
    origin        text not null,
    -- 'append' | 'replace'. Mirrors the two mutating MCP tools.
    op            text not null,
    -- Human-readable label, e.g. "Append 2 paragraphs" or the AI intent.
    summary       text not null default '',
    -- The staged change.
    diff_base64   text not null,              -- incremental Yjs update to apply on accept
    base_sv       text not null,              -- base64 state vector diff was computed from
    before_md     text not null default '',   -- note body before the edit (Markdown)
    after_md      text not null default '',   -- note body after the edit (Markdown)
    -- Lifecycle.
    status        text not null default 'pending', -- pending|applied|rejected|superseded
    created_at    timestamptz not null default now(),
    resolved_at   timestamptz,
    resolved_by   uuid references users(id) on delete set null
);

create index ai_edit_proposals_doc_idx    on ai_edit_proposals (document_id, status);
create index ai_edit_proposals_ws_pending on ai_edit_proposals (workspace_id) where status = 'pending';
```

No changes to existing tables.

## 3. API contract

All routes are workspace-scoped: the caller must be a member of the proposal's / document's workspace (`workspaces::member_role`), exactly like `/ai/complete`. Auth column below is what a route accepts. `snp_` PATs and JWTs are both `AuthUser`; "PAT (typical)" just flags the expected caller.

Base path is the API root (mounted under `/api` by the web/mobile clients).

### 3.1 Create a proposal (the staged write)
`POST /ai/proposals` — **JWT or PAT**. This is what MCP `update_note`/`append_to_note` and in-app AI insertions call **instead of** `POST /documents/:id/content`.

Request:
```json
{
  "document_id": "uuid",
  "op": "append",              // "append" | "replace"
  "markdown": "…new content…", // for append: text to add; for replace: full new body
  "origin": "mcp",             // "mcp" | "app"; optional, defaults to "mcp" for PAT, "app" for JWT
  "summary": "Append meeting notes"  // optional human label
}
```
Server behavior: loads the note's current updates, computes `before_md`, the incremental `diff_base64` and `after_md` (same y-prosemirror path as `tools/mcp-server/src/edit.ts`), records `base_sv`, and inserts a `pending` row. It does **not** touch the content log.

Response `201`:
```json
{
  "id": "uuid",
  "document_id": "uuid",
  "workspace_id": "uuid",
  "op": "append",
  "origin": "mcp",
  "summary": "Append meeting notes",
  "status": "pending",
  "before_md": "…",
  "after_md": "…",
  "created_by": "uuid",
  "created_at": "2026-09-04T12:00:00Z"
}
```
Errors: `404` unknown document, `403` not a workspace member, `409` no AI/edit could be produced or invalid `op`.

### 3.2 List proposals
`GET /ai/proposals?document_id=<uuid>&status=pending` — **JWT or PAT**. `document_id` optional (omit to list all pending in the caller's workspaces); `status` optional (defaults to `pending`). Returns newest first.

Response `200`: array of the proposal object from 3.1, **plus** `resolved_at`, `resolved_by` (nullable).

### 3.3 Get one proposal (full diff payload)
`GET /ai/proposals/:id` — **JWT or PAT**. Same object as 3.1 plus `before_md`, `after_md`, and `diff_base64`, `base_sv` (clients render `before_md`/`after_md`; `diff_base64` is exposed for debugging/optimistic apply).

Response `200`: proposal object. `404` if not found or caller not a member.

### 3.4 Accept a proposal (apply the diff)
`POST /ai/proposals/:id/accept` — **JWT only** (a human gate; PATs are rejected with `403`).

Request: `{}` (empty body).

Server behavior: if `status != "pending"` → `409`. Re-derive the note's current state; if it still matches `base_sv`, append `diff_base64` to the content log (the same effect as `POST /documents/:id/content`), set `status = "applied"`, `resolved_at`, `resolved_by`. If the note drifted, recompute a fresh diff from `after_md` against current content and apply that (so a late accept still lands the intended text); if it cannot be safely reapplied, set `status = "superseded"` and return `409`.

Response `200`:
```json
{ "id": "uuid", "status": "applied", "resolved_at": "…", "resolved_by": "uuid" }
```

### 3.5 Reject a proposal
`POST /ai/proposals/:id/reject` — **JWT only**. Request `{}`. If not `pending` → `409`. Sets `status = "rejected"`, `resolved_at`, `resolved_by`.

Response `200`: `{ "id": "uuid", "status": "rejected", "resolved_at": "…", "resolved_by": "uuid" }`.

### 3.6 MCP + in-app wiring (not new HTTP)
- `tools/mcp-server`: `append_to_note`/`update_note` change from calling `setContent` to `POST /ai/proposals` (`op: "append"|"replace"`, `origin: "mcp"`). Their tool text/return value states the edit is **staged pending review** and returns the proposal id + note deep link. `create_note` (new empty note) may stay direct or also stage — spec: stays direct, since there is nothing to overwrite.
- In-app AI insertions (web/mobile "insert into note" from the assistant) call `POST /ai/proposals` with `origin: "app"` rather than writing the CRDT directly.

## 4. Web UX (apps/web)

- **API client** (`apps/web/src/api.ts`): add `createAiProposal`, `listAiProposals`, `getAiProposal`, `acceptAiProposal`, `rejectAiProposal`.
- **`AiProposalBanner`** (new component): when the open document has ≥1 `pending` proposal, show a dismissible banner at the top of the editor: "N pending AI edit(s) — Review". Poll `listAiProposals?document_id` on doc open and after the assistant streams a reply (reuse the existing AI sidebar's lifecycle). Optionally subscribe via the existing sync channel; polling is the baseline requirement.
- **`AiDiffPreview`** (new modal/drawer): renders a two-column (or unified) Markdown diff of `before_md` vs `after_md` using the "Ink & Paper" styles (`apps/web/src/styles.css`): additions in a soft green, removals in a soft red/strikethrough. Shows `origin` ("Remote via MCP" vs "In-app"), `summary`, `created_at`. Footer: **Accept** and **Reject** buttons calling 3.4/3.5. On accept, close and let the normal sync path re-render the note; on reject, close and drop it from the list.
- **In-app assistant insertion**: the AI sidebar's "insert into note" action creates a proposal (`origin:"app"`) and immediately opens `AiDiffPreview` so the same accept/reject gate applies to local AI edits.
- Empty/expired: if a proposal returns `409 superseded` on accept, show an inline toast "This note changed — the edit no longer applies" and refresh the list.

## 5. Mobile UX (apps/mobile) — strict parity

Same capabilities, React Native adaptation (standalone app, `apps/mobile/src/api.ts`):
- **API client** (`apps/mobile/src/api.ts`): add the same five methods as web.
- **Pending banner**: a `Pressable` bar above the WebView editor showing "N pending AI edit(s) — Review", populated by the same `listAiProposals?document_id` call on doc open and after assistant replies.
- **Diff screen**: a full-screen modal (React Navigation modal or RN `Modal`) rendering the unified Markdown diff of `before_md`/`after_md` with the same green-add / red-remove treatment, `origin` label, and `summary`. Footer buttons **Accept** / **Reject** call 3.4/3.5.
- **In-app assistant insertion**: mobile assistant "insert into note" stages a proposal (`origin:"app"`) and opens the diff screen — identical gate to web.
- Superseded handling: same toast/alert + list refresh.
- The BlockNote WebView renders `before_md`/`after_md` as Markdown; no native diff engine needed (server supplies both sides).

## 6. Desktop

Inherits the web build via Tauri 2 (bundles `apps/web`), so `AiProposalBanner` + `AiDiffPreview` work unchanged. **Tauri specific: none** — no native diff, no extra permissions; all state is server-side over the existing API client.

## 7. Acceptance criteria + parity checklist

Acceptance:
1. Migration `0005_ai_edit_proposals.sql` applies cleanly; table + indexes exist.
2. MCP `append_to_note`/`update_note` create a `pending` proposal and do **not** modify the note; the note is unchanged until a human accepts.
3. `GET /ai/proposals?document_id=…` returns pending proposals with `before_md`/`after_md`; non-members get `403`; unknown doc `404`.
4. Accept (JWT) applies the diff so the note reflects `after_md` and status becomes `applied`; a PAT calling accept gets `403`.
5. Reject sets `rejected` and never mutates the note.
6. Accepting an already-resolved proposal → `409`; accepting after the note drifted either reapplies safely or returns `409 superseded` (never corrupts the doc).
7. In-app AI insertions go through the same proposal → accept/reject gate.
8. Web and mobile both surface the pending banner and the before/after diff and can accept/reject.

Parity checklist (web ⇄ mobile):

| Capability | Web (apps/web) | Mobile (apps/mobile) |
|---|---|---|
| Pending-proposals banner on open doc | ✅ `AiProposalBanner` | ✅ Pressable bar |
| Before/after Markdown diff (add=green, remove=red) | ✅ `AiDiffPreview` | ✅ full-screen modal |
| Origin label (MCP remote vs in-app) | ✅ | ✅ |
| Accept (JWT) applies edit | ✅ | ✅ |
| Reject discards | ✅ | ✅ |
| In-app AI insertion staged as proposal | ✅ | ✅ |
| Superseded/drift toast + refresh | ✅ | ✅ |
| API client methods (create/list/get/accept/reject) | ✅ `src/api.ts` | ✅ `src/api.ts` |
