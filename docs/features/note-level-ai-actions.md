# Note-level AI actions

## 1. Problem & goal

Today AI in Selfnote lives only in the sidebar chat, so acting on a note means copy-pasting into a conversation and pasting the result back. This feature adds first-class inline note actions — **Summarize**, **Rewrite in my voice**, **Extract action items** — that run against the note (or a selection) and stream the result the user can insert or replace with one tap. Goal: one-click, structured transformations of the current note with strict web ⇄ mobile parity.

## 2. Data model & migration

The action itself is stateless (input is the note text the client already holds; output is transient AI text). But "Rewrite in my voice" needs a persisted per-user **voice profile**, and we want lightweight telemetry to know which actions are used. New migration: `server/migrations/0005_ai_actions.sql`.

```sql
-- 0005_ai_actions.sql

-- Per-user writing "voice" sample used to ground the "Rewrite in my voice" action.
create table ai_voice_profiles (
    user_id     uuid primary key references users(id) on delete cascade,
    sample      text        not null default '',
    updated_at  timestamptz not null default now()
);

-- Optional usage log so we can see which actions land. Never stores note content.
create table ai_action_events (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    doc_id      uuid references documents(id) on delete set null,
    action      text not null,            -- 'summarize' | 'rewrite' | 'action_items'
    scope       text not null,            -- 'note' | 'selection'
    created_at  timestamptz not null default now()
);

create index ai_action_events_user_idx on ai_action_events(user_id, created_at desc);
```

## 3. API contract

All endpoints live under `/ai` (added to the router in `server/api/src/main.rs`, handlers in `server/api/src/ai.rs`). **Auth: every endpoint requires the `AuthUser` extractor — either a JWT access token or an `snp_` PAT via `Authorization: Bearer <token>`. None are public.** If a `doc_id` is supplied, the caller must be a member of that document's workspace (reuse `authorize_doc`), else `403`. If no AI provider is configured, endpoints return `409 Conflict {"error":"no AI provider configured"}`.

`action` is one of `"summarize" | "rewrite" | "action_items"`. `scope` is `"note"` (default) or `"selection"`.

---

### 3.1 `POST /ai/action` — run an action, non-streaming (fallback)

Auth: JWT or PAT.

Request JSON:
```json
{
  "action": "summarize",
  "scope": "note",
  "doc_id": "3f2a...uuid or null",
  "text": "full note plain text (required)",
  "selection": "selected passage or null"
}
```
- `text` (required): the note's plain-text content, ground truth for the action.
- `selection` (optional): when `scope` is `"selection"`, the passage to operate on; the server operates on `selection` if present and `scope==="selection"`, otherwise on `text`.

Response JSON `200`:
```json
{ "text": "the generated result (markdown)" }
```
Errors: `400` invalid `action`/`scope` or empty input; `403` not a workspace member; `409` no provider.

---

### 3.2 `POST /ai/action/stream` — run an action, streamed (primary path)

Auth: JWT or PAT. Same request body as 3.1.

Response: `text/event-stream` (SSE), mirroring the existing `/ai/chat/stream` wire format exactly:
- Zero or more data events: `data: {"delta":"<chunk of text>"}`
- Terminal success: `event: done\ndata: {}`
- Terminal failure: `event: error\ndata: {"error":"<message>"}`

Pre-stream errors (auth/validation/provider) are returned as normal HTTP status codes (`400`/`401`/`403`/`409`) before the stream opens, identical to `/ai/chat/stream`.

---

### 3.3 `GET /ai/voice` — read the caller's voice profile

Auth: JWT or PAT. No body.

Response JSON `200`:
```json
{ "sample": "text the user pasted as their voice sample, may be \"\"", "updated_at": "2026-09-04T10:00:00Z or null" }
```
If no row exists, return `{ "sample": "", "updated_at": null }` (`200`, not `404`).

---

### 3.4 `PUT /ai/voice` — set/update the caller's voice profile

Auth: JWT or PAT.

Request JSON:
```json
{ "sample": "1-3 paragraphs of the user's own writing" }
```
- `sample`: capped server-side at 8000 chars (truncate silently). Empty string clears the profile (falls back to generic rewrite).

Response JSON `200`:
```json
{ "sample": "stored sample", "updated_at": "2026-09-04T10:00:00Z" }
```

---

**Server behavior notes (non-normative for clients):** each action maps to a fixed system prompt.
- `summarize` → "Summarize the note below into a tight TL;DR followed by 3-6 bullet key points. Markdown."
- `rewrite` → "Rewrite the text below preserving meaning and structure, matching the user's voice." If a voice profile `sample` exists it is injected as the style exemplar; otherwise rewrite for clarity/concision.
- `action_items` → "Extract every actionable to-do from the note as a Markdown checklist (`- [ ] ...`), owners/dates inline where stated. If none, reply exactly `_No action items found._`".

After a successful run (both 3.1 and 3.2) the server inserts one `ai_action_events` row (best-effort; failures are ignored, never block the response).

## 4. Web UX (apps/web)

**API client (`apps/web/src/api.ts`):** add `aiAction(body)` → `req<AiComplete>("/ai/action", …)`; `aiActionStream(body, handlers)` (reuse the existing `openChatStream` SSE reader, pointed at `/ai/action/stream`, same `{delta}/done/error` parsing); `getVoice()`/`setVoice(sample)`. Add `AiActionRequest` type mirroring 3.1. Gate visibility on `aiStatus().available`.

**Actions menu:** a new `NoteAiActions` component rendered in the editor toolbar / note header (next to the existing AI sidebar toggle) as an "AI actions" button opening a small popover with the three actions. When the user has a non-empty editor selection, actions default to `scope:"selection"` (label hints "Selected text"); otherwise `scope:"note"`. It reads the note's plain text from the BlockNote editor (same extraction already used to build `context` for chat).

**Result panel:** clicking an action opens a lightweight `AiActionResult` panel (reuse the sidebar's styling / streaming bubble) that streams the output via `aiActionStream`. Footer buttons:
- **Insert** — insert result at the cursor / end of note.
- **Replace** — replace the selection (selection scope) or the whole note (note scope), behind a confirm for whole-note replace.
- **Copy**, **Retry**, **Dismiss**.
Errors surface inline in the panel; a `409` shows "No AI provider configured" and the menu hides.

**Voice settings:** in the existing settings/preferences surface, add a "My writing voice" textarea backed by `getVoice`/`setVoice`, with a note that it powers "Rewrite in my voice".

## 5. Mobile UX (apps/mobile) — strict parity

Same three actions and the same voice profile, adapted to React Native (standalone app, its own `apps/mobile/src/api.ts`).

**API client:** add `aiAction`, `getVoice`, `setVoice`, and `aiActionStream` reusing the existing `XMLHttpRequest`-based streaming helper (RN `fetch` can't stream) pointed at `/ai/action/stream`, parsing the identical `{delta}/done/error` SSE events.

**Entry point:** the WebView BlockNote editor already bridges selection/plain-text to RN. Add an "AI actions" button in the note's header/action bar; on tap open a native bottom sheet listing the three actions. Selection detection uses the existing WebView bridge; when a selection exists default to `scope:"selection"`.

**Result:** a native modal/bottom sheet that streams the result into a scrollable text area, with the same footer actions — **Insert**, **Replace** (confirm for whole-note), **Copy** (`Clipboard`), **Retry**, **Dismiss**. Insert/Replace post the resulting text back into the editor over the WebView bridge (reuse the mechanism the chat "insert into note" already uses, or the editor's insert/replace bridge).

**Voice settings:** add a "My writing voice" multiline field in the mobile Settings screen backed by `getVoice`/`setVoice`.

Gate all of the above on `aiStatus().available`, matching web.

## 6. Desktop

None specific — desktop is Tauri 2 bundling `apps/web`, so implementing section 4 covers it. The SSE streaming path already works under Tauri's webview (same as chat streaming); no Tauri plugin or config change required.

## 7. Acceptance criteria + parity checklist

**Acceptance criteria**
- [ ] Migration `0005_ai_actions.sql` applies cleanly; `ai_voice_profiles` and `ai_action_events` exist.
- [ ] `POST /ai/action` returns `{text}` for each of the three actions on note and selection scope.
- [ ] `POST /ai/action/stream` emits `{delta}` events then `event: done`, and `event: error` on failure — byte-compatible with `/ai/chat/stream`.
- [ ] All action endpoints reject unauthenticated requests (`401`), reject non-members of `doc_id`'s workspace (`403`), and return `409` when no provider is configured.
- [ ] `GET /ai/voice` returns `{sample:"",updated_at:null}` when unset; `PUT /ai/voice` persists (capped 8000 chars) and is reflected on the next read.
- [ ] "Rewrite in my voice" visibly reflects a set voice sample vs. generic rewrite when unset.
- [ ] `action_items` returns a Markdown checklist, or exactly `_No action items found._` when there are none.
- [ ] Insert and Replace correctly mutate the note (Replace whole-note is confirmed).
- [ ] When `aiStatus().available` is false, the AI actions entry point is hidden on web and mobile.

**Parity checklist (web ⇄ mobile)**

| Capability | Web (apps/web) | Mobile (apps/mobile) |
|---|---|---|
| Summarize / Rewrite / Extract action items | ✅ popover | ✅ bottom sheet |
| Note vs. selection scope (auto from editor selection) | ✅ | ✅ (WebView bridge) |
| Streamed result via `/ai/action/stream` | ✅ `openChatStream` | ✅ `XMLHttpRequest` helper |
| Non-streaming fallback `/ai/action` | ✅ | ✅ |
| Insert / Replace (confirm whole-note) / Copy / Retry / Dismiss | ✅ | ✅ |
| Voice profile read/write (`GET`/`PUT /ai/voice`) settings UI | ✅ | ✅ |
| Hidden when no provider (`aiStatus`) | ✅ | ✅ |
