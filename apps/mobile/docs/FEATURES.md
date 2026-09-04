# Selfnote Mobile — Feature Requirements

> Requirements for a set of implementable features. Built against `DESIGN.md`
> (look & feel). Each feature lists **intent**, **scope**, and **acceptance
> criteria** (AC). Ordered by dependency: earlier features unblock later ones.
> Status legend: ☐ todo · ◐ in progress · ☑ done.

## F0 — Design foundation (enabler) ☑

**Intent.** Make "the buttons are the right size and the UI is consistent" true by
construction, not per-screen.

**Scope.** `src/theme.ts` (all tokens from DESIGN.md §3–4) + reusable primitives:
`Button`, `IconButton`, `Input`, `Row`, `Screen`, `StatusDot`, `Sheet`, `Toast`.

**AC.**
- No component hard-codes a hex color or a sizing magic number; all read `theme`.
- `Button` variants primary/secondary/ghost/destructive; heights 52/48/48; real
  press state (bg tint on `pressIn`, no opacity-only feedback); disabled state.
- Every interactive primitive has ≥48px hit area (via padding or `hitSlop`) and an
  `accessibilityRole`/`accessibilityLabel`.
- Type roles from DESIGN.md §3.2 exposed as `theme.type.{title,docTitle,body,...}`.
- A quick visual pass on an emulator confirms targets look substantial, not bulky.

## F1 — Refreshed core screens ☑

**Intent.** The "UI improved a lot generally" deliverable — apply F0 to every
screen so the app feels calm, tactile, and yours.

**Scope.** Auth, Document list/tree, Editor topbar, Settings, empty/error/loading
states, per DESIGN.md §5–6.

**AC.**
- Auth: serif "selfnote" wordmark hero; two inputs; one primary button; ghost
  register toggle; server URL as meta; gear → Settings. Keyboard-avoiding.
- Doc list: 56px serif rows; tree indentation with a 28px chevron that toggles
  collapse *without* opening; trailing `＋` (48px) adds a subpage; FAB floating
  with the one allowed shadow; `accentWash` + 3px edge bar on the open row.
- Editor topbar: 56px; ghost back; serif title; **labelled** sync status
  ("Live"/"Syncing…"/"Offline"), color from tokens.
- Settings: bottom sheet with grabber; labelled inputs; primary Save; defaults as
  meta.
- Empty doc list shows a serif line + one primary action, not a bare sentence.
- Errors are directive, in-voice, never a raw status code.

## F2 — Document management polish ☑

**Intent.** Make the notebook actually manageable from the phone.

**Scope.** Inline title rename; archive; tree collapse/expand persisted; pull-to-
refresh; document search.

**AC.**
- Long-press (or a row overflow icon, 48px) opens actions: Rename, Add subpage,
  Archive. Rename edits the title inline (or in a small sheet) and PATCHes.
- Archive calls `PATCH /documents/:id {archived:true}`, removes from the tree with
  a Toast + Undo (re-PATCH false) for 4s.
- Collapse state persists per-doc in AsyncStorage; chevron reflects it.
- Pull-to-refresh re-fetches the document list.
- Search: a field filters the tree by title client-side; if the server exposes
  `/documents/search`, use it for content search when the query is ≥3 chars.

## F3 — Sync & offline UX ☑

**Intent.** Make the CRDT/offline story legible and reassuring.

**Scope.** Labelled status; offline banner; manual reconnect; "saved offline"
affordance; room-token refresh before expiry.

**AC.**
- Status word + dot in the editor topbar reflects `ConnectionStatus`.
- When `disconnected`/`offline`, a thin inline banner offers "Reconnect"
  (`connection.goOnline()`), non-blocking; editing continues.
- Edits made offline surface a one-time Toast "Saved on this device — will sync".
- If the room token nears expiry (`expires_in`), silently fetch a new one and
  reconnect without losing edits.

## F4 — AI Assist ("Assist") ☑ (code; server deploy = user checkpoint) ★ headline feature

**Intent.** Bring an AI collaborator into the document — **detected on your own
server**, so it uses your compute/key and your data stays in your instance. The
app only surfaces Assist when the server actually has an AI backend, so a
plain instance shows no dead buttons. (Inspired by tools that detect a local
Claude/AI setup rather than hard-wiring a cloud vendor.)

### F4.1 Server: AI backend detection ☑

**Scope.** New endpoints on `selfnote-api` (Rust/axum). Detection is server-owned
and cheap.

- `GET /ai/status` (auth) → `{ available: bool, provider: string|null, model: string|null, features: string[] }`.
  Provider resolution order (first that works wins):
  1. **`claude-cli`** — a `claude` (or configured `SELFNOTE_AI_CMD`) binary is on
     `PATH` and returns from `--version`. Runs locally on the server; data never
     leaves the box.
  2. **`anthropic-api`** — `ANTHROPIC_API_KEY` is set → server calls the Claude
     API (model from `SELFNOTE_AI_MODEL`, default a current Claude model).
  3. **`ollama`** — `OLLAMA_HOST` reachable → local open-weights model.
  4. none → `{ available:false, provider:null }`.
- `features` advertises supported intents: `["continue","summarize","ideas","improve","ask"]`.

**AC.** Endpoint returns within ~300ms; never blocks on a model call; caches the
detected provider for the process lifetime; requires auth; documented env vars in
the Helm values.

### F4.2 Server: completion endpoint ☑

**Scope.** `POST /ai/complete` (auth) →
`{ doc_id, intent, prompt?, selection?, context }` → produces a suggestion.

- The server builds a prompt from `intent` + the provided `context` (the document
  text or selection the client sends) and dispatches to the detected provider
  (spawn the CLI with the prompt on stdin, or call the API/Ollama).
- v1 returns a whole suggestion as JSON `{ text }`. v2 streams tokens (SSE /
  chunked) so the panel types out live.
- Guardrails: max input/output tokens; per-user simple rate limit; the caller must
  be a member of the doc's workspace (reuse `member_role`).

**AC.** Returns a coherent suggestion for each intent against a small sample doc;
errors are structured (`{error, reason}`); a 30s timeout; unavailable provider →
`409` with a clear reason (client hides Assist on `available:false` anyway).

### F4.3 Mobile: Assist panel ☑

**Scope.** A **right-side slide-in panel** in the Editor (a right drawer on phone,
~86% width, `surface`, one soft shadow, swipe-right or ✕ to dismiss), opened by an
Assist icon button in the editor topbar. The icon appears **only** when
`GET /ai/status` reports `available:true`.

Panel contents (DESIGN.md sizing rules apply — 48px targets, 52px inputs):
- Header: "Assist" (serif), provider badge as meta (e.g. "claude · local"), ✕.
- **Intent chips** (48px pills, wrap): Continue · Summarize · Ideas · Improve.
- A 52px prompt input for free-form "Ask…", with a primary Send (52px).
- Result area: the suggestion streams/renders (Newsreader body). Below it,
  actions: **Insert** (at cursor/end), **Replace selection** (if a selection was
  captured), **Copy**, **Retry**.
- Context: the panel sends the current document's plain text (and selection, if
  any) to `/ai/complete`. Text is obtained from the WebView editor via the bridge
  (new `getText`/`getSelection` messages); Insert/Replace are new bridge messages
  back into BlockNote.
- Loading: inline typing indicator in the result area, never a full-screen spinner;
  Cancel stops the request.

**AC.**
- Assist button hidden entirely when AI unavailable; no errors on plain servers.
- Opening the panel does not disrupt the live sync connection or lose edits.
- Each intent returns a suggestion grounded in the current doc; Insert places it
  into the document and it **syncs to web** (proves the round-trip through Yjs).
- Provider + model are shown so the user knows what's answering.
- Panel respects safe areas and reduce-motion; drawer animation ≤220ms.

### F4.4 Bridge additions (editor) ☑

**Scope.** Extend the RN↔WebView protocol used by `WebViewEditor`/`editorHtml`:
`getText` → returns `editor.document` as markdown/plain text; `getSelection` →
current selection text; `insertText`/`replaceSelection` → mutate the BlockNote doc
(which flows through Yjs to the server). Reuse the single-shared-yjs setup.

**AC.** Round-trips text both ways; inserted content persists and syncs; no new
duplicate-module regressions.

## F5 — Delight & platform polish ☑ (haptics + share + full dark mode w/ System/Light/Dark toggle)

- Dark mode (token value swap per DESIGN.md §3.1).
- Haptic tick on primary/destructive press (`expo-haptics`).
- Share sheet: create a share link (`POST /documents/:id/shares`) and share via the
  OS sheet.
- Quick capture: from the doc list, a fast "new note + focus editor" path.

## Build & verification protocol (applies to every feature)

1. `npx tsc --noEmit` clean.
2. `./gradlew assembleRelease` succeeds; APK reinstalled on the Pixel_9 emulator.
3. Drive the changed screen on the emulator; capture a screenshot; confirm against
   the relevant DESIGN.md sizing/feel rules.
4. For sync-affecting changes, verify the web↔mobile round-trip
   (`selfnote.example.com`) still works.
5. Commit-sized, reversible changes; update this file's status markers.

## Sequencing

F0 → F1 (unblocks a consistent UI) → F2/F3 (independent, either order) →
F4 (AI, largest; server + mobile; do F4.1/F4.4 before F4.3) → F5 as time allows.

## Post-roadmap polish (loop, opportunistic)
- ☑ App-level ErrorBoundary: render crashes show a recoverable 'Something went wrong — Reload' screen instead of white.
- ☑ Editor load resilience: timeout + retry UI if the esm.sh editor assets fail (we hit a 503 once).
- ☐ Optional: local editor bundle to drop the CDN dependency (larger/riskier).
- ☐ Optional: AI streaming; AI 'improve selection' via getSelection bridge.
