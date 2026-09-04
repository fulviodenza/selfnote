# Calendar & Task Sync

## 1. Problem & goal

Selfnote users keep to-dos and deadlines scattered inside free-form pages, with no way to see what is due or export it to their existing calendar. This feature lets any document be promoted to a **task** with a due date, status, and priority, surfaces those tasks in an agenda/task view (list + upcoming), and publishes a per-workspace read-only **iCal (ICS) feed** so tasks appear in Google/Apple/Outlook calendars. It reuses the existing document tree (a task *is* a document) rather than introducing a parallel entity.

## 2. Data model & migration

Highest existing migration is `0004_api_tokens.sql`, so this is **`server/migrations/0005_tasks.sql`**. Task metadata hangs off `documents` in a sidecar table (1:1) so non-task documents are unaffected and task promotion is reversible. The ICS feed is authenticated by an opaque per-workspace token (no login in calendar clients), stored hashed like PATs.

```sql
-- server/migrations/0005_tasks.sql
-- Task metadata for documents promoted to tasks (1:1 with documents).
-- A document is a "task" iff a row exists here; deleting the row demotes it.
create table document_tasks (
    doc_id       uuid primary key references documents(id) on delete cascade,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    status       text not null default 'todo'
                     check (status in ('todo', 'in_progress', 'done')),
    priority     text not null default 'none'
                     check (priority in ('none', 'low', 'medium', 'high')),
    -- Due instant. When due_all_day is true only the date part is meaningful
    -- (rendered as an all-day event in ICS); the time component is ignored.
    due_at       timestamptz,
    due_all_day  boolean not null default false,
    completed_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index document_tasks_workspace_due_idx
    on document_tasks (workspace_id, due_at);
create index document_tasks_workspace_status_idx
    on document_tasks (workspace_id, status);

-- Opaque bearer token that lets an external calendar client pull a workspace's
-- ICS feed without a login. Only the SHA-256 hash is stored; the plaintext
-- ("cal_…") is embedded in the returned feed URL and shown once. Rotating =
-- delete + re-create (invalidates the old URL).
create table calendar_feed_tokens (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    token_hash   text not null unique,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz
);
create index calendar_feed_tokens_workspace_idx
    on calendar_feed_tokens (workspace_id);
```

Notes for backend agent:
- `workspace_id` is denormalized onto `document_tasks` (copied from the parent document at insert) so list/feed queries index by workspace without joining `documents`.
- `completed_at` is set server-side to `now()` when `status` transitions to `done`, and cleared to `null` when it transitions away from `done`.

## 3. API contract

All JSON bodies are `application/json`. All timestamps are RFC 3339 / ISO 8601 UTC strings (e.g. `2026-09-10T17:00:00Z`). `due_at` is nullable everywhere. A **Task** object is:

```json
{
  "doc_id": "uuid",
  "workspace_id": "uuid",
  "title": "string",          // mirrored from documents.title (read-only here)
  "icon": "string|null",      // mirrored from documents.icon (read-only here)
  "status": "todo|in_progress|done",
  "priority": "none|low|medium|high",
  "due_at": "2026-09-10T17:00:00Z|null",
  "due_all_day": false,
  "completed_at": "2026-09-10T18:03:00Z|null",
  "created_at": "2026-09-01T09:00:00Z",
  "updated_at": "2026-09-04T11:00:00Z"
}
```

Auth column legend: **JWT** = `Authorization: Bearer <jwt>`; **PAT** = `Authorization: Bearer snp_…`; both are accepted anywhere the existing `AuthUser` extractor is used (write endpoints below require the caller be a workspace member with role != `viewer`, read endpoints require any membership). **Public** = no auth header; identity comes from a path/query token.

---

### 3.1 Promote a document to a task (create/upsert task metadata)

`POST /documents/:id/task` — **JWT | PAT** (member, role != viewer)

Request:
```json
{
  "status": "todo",              // optional, default "todo"
  "priority": "medium",          // optional, default "none"
  "due_at": "2026-09-10T17:00:00Z", // optional, nullable
  "due_all_day": false           // optional, default false
}
```
Response `200 OK`: the **Task** object. Idempotent upsert: if the document is already a task, provided fields are updated and omitted fields are left unchanged.
Errors: `404` if document not found; `403` if not a member or viewer.

---

### 3.2 Get a document's task metadata

`GET /documents/:id/task` — **JWT | PAT** (any member)

Response `200 OK`: the **Task** object.
Errors: `404` if the document is not a task or not found; `403` if not a member.

---

### 3.3 Update a task

`PATCH /documents/:id/task` — **JWT | PAT** (member, role != viewer)

Request (all fields optional; only present keys change). Explicit `null` for `due_at` clears the due date:
```json
{
  "status": "done",
  "priority": "high",
  "due_at": null,
  "due_all_day": true
}
```
Response `200 OK`: the updated **Task** object. Server sets/clears `completed_at` when `status` crosses to/from `done`.
Errors: `404` if not a task; `403` if not a member or viewer; `400` on invalid enum value.

---

### 3.4 Demote (remove task metadata; document is untouched)

`DELETE /documents/:id/task` — **JWT | PAT** (member, role != viewer)

Response `204 No Content`. Idempotent (`204` even if it was not a task).
Errors: `403` if not a member or viewer.

---

### 3.5 List / agenda query

`GET /tasks` — **JWT | PAT** (any member of `workspace_id`)

Query params:
| param | type | default | meaning |
|-------|------|---------|---------|
| `workspace_id` | uuid (required) | — | scope |
| `status` | csv of `todo,in_progress,done` | all | filter |
| `due_before` | RFC3339 | — | `due_at <= due_before` |
| `due_after` | RFC3339 | — | `due_at >= due_after` |
| `include_undated` | bool | `true` | include tasks with `due_at = null` |
| `sort` | `due_at` \| `priority` \| `created_at` | `due_at` | order; nulls last |
| `limit` | int (1–500) | `200` | page size |

Response `200 OK`:
```json
{ "tasks": [ /* Task objects */ ] }
```
Errors: `403` if not a member; `400` on bad param.

---

### 3.6 Issue / rotate an ICS feed token

`POST /workspaces/:id/calendar-feed` — **JWT | PAT** (member, role != viewer)

Request: empty body `{}`. Rotates: deletes any existing token rows for this workspace+user and mints a fresh one.
Response `200 OK`:
```json
{
  "token": "cal_9f2c…",                       // plaintext, shown once
  "url": "/calendar/<workspace_id>/<token>.ics" // relative; client prefixes API_BASE
}
```
Errors: `403` if not a member or viewer.

`DELETE /workspaces/:id/calendar-feed` — **JWT | PAT** (member, role != viewer). Revokes all feed tokens for this workspace+user. Response `204 No Content`.

`GET /workspaces/:id/calendar-feed` — **JWT | PAT** (any member). Reports whether a feed exists (never returns the plaintext token):
```json
{ "enabled": true, "url": "/calendar/<workspace_id>/<token_id>.ics", "created_at": "…", "last_used_at": "…|null" }
```
When no feed exists: `{ "enabled": false }`. Note the `GET` URL uses the token **id** placeholder for display only; the working URL is the one returned at issue time. (If simpler, backend may return `{ "enabled": true }` with no `url` here and require re-issue to see the URL — web/mobile must handle the missing `url`.)

---

### 3.7 Public ICS feed

`GET /calendar/:workspace_id/:token.ics` — **Public** (token in path; no `Authorization` header)

`:token` is the `cal_…` plaintext. Server SHA-256-hashes it, matches `calendar_feed_tokens` for that `workspace_id`, updates `last_used_at`, and streams the feed. Every non-archived task in the workspace becomes a `VEVENT`.

Response `200 OK`, `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="selfnote.ics"`, body is RFC 5545 iCalendar:
- Calendar: `PRODID:-//Selfnote//Calendar//EN`, `VERSION:2.0`, `CALSCALE:GREGORIAN`, `X-WR-CALNAME:<workspace name>`.
- One `VEVENT` per task **with a non-null `due_at`** (undated tasks are skipped):
  - `UID:<doc_id>@selfnote` (stable across edits so clients update, not duplicate).
  - `SUMMARY:<title>` (prefix with a status marker, e.g. `✔` when done); escape `,;\` and newlines per RFC 5545.
  - `DTSTART`/`DTEND`: for `due_all_day=true` → `DTSTART;VALUE=DATE:YYYYMMDD` (no `DTEND`); otherwise `DTSTART:YYYYMMDDTHHMMSSZ` with a default 30-minute `DTEND`.
  - `STATUS:` `CONFIRMED` (done) / `NEEDS-ACTION` else; `PRIORITY:` mapped `high→1, medium→5, low→9, none→0`.
  - `DTSTAMP` = `updated_at`; `LAST-MODIFIED` = `updated_at`.

Errors: `404` (opaque — same body for unknown workspace, bad token, or revoked token; do not leak which). No caching of auth; respond within the normal request path.

## 4. Web UX (apps/web)

- **API client** (`apps/web/src/api.ts`): add to the `api` object — `getTask(docId)`, `setTask(docId, body)` (POST), `updateTask(docId, patch)` (PATCH), `deleteTask(docId)`, `listTasks(params)` (GET `/tasks`), `getCalendarFeed(workspaceId)`, `issueCalendarFeed(workspaceId)`, `revokeCalendarFeed(workspaceId)`. All reuse the existing authed `fetch` wrapper (JWT with one refresh-on-401). The ICS URL is `` `${API_BASE}${url}` ``.
- **Task panel on the page header** (`apps/web/src/components/DocumentView` or the editor toolbar): a "Task" affordance next to the title. When the doc is not a task, a "Make task" button calls `setTask`. When it is, show inline controls: a status pill (todo / in progress / done cycle), a priority selector, and a due-date picker (date, plus optional time when `due_all_day` is off). Editing any control fires `updateTask`. A "Remove task" item (in the page `…` menu) calls `deleteTask`. Follow the "Ink & Paper" styling in `apps/web/src/styles.css` (reuse existing pill/menu classes).
- **Agenda / Task view** (new route `#/tasks` or a sidebar entry "Tasks", new component `apps/web/src/components/TaskView.tsx`): calls `listTasks({ workspace_id })`. Renders grouped sections — **Overdue**, **Today**, **Upcoming (next 7 days)**, **Later**, **No date**, and a collapsed **Done**. Each row shows icon, title, priority dot, relative due label; clicking a row opens the document. Filter chips for status; the group boundaries are computed client-side from `due_at`. Checkbox on a row toggles status→`done` via `updateTask`.
- **Calendar subscription** (in workspace/settings surface, e.g. `apps/web/src/components/Settings` or the workspace menu): a "Calendar feed" card. If disabled, an "Enable calendar feed" button calls `issueCalendarFeed`, then shows the full ICS URL with a copy button and a "webcal://" convenience link, plus a warning it is shown once. "Rotate" re-issues; "Disable" calls `revokeCalendarFeed`. Mirrors the existing PAT-token UI in the tokens settings screen.

## 5. Mobile UX (apps/mobile)

Strict parity with web; React Native + Expo, standalone package. API client `apps/mobile/src/api.ts` gains the same methods as §4 (same paths, same auth header handling as the existing client).

- **Task controls on the note screen**: below the title in the note detail screen, a "Make task" `Pressable` when not a task; when a task, a row of native controls — a status segmented control (todo / in progress / done), a priority picker (`ActionSheet`/menu), and a due-date picker using the platform `DateTimePicker` (date + optional time toggle for `due_all_day`). Changes call `updateTask`. "Remove task" lives in the note's overflow menu → `deleteTask`.
- **Agenda / Task screen**: a new tab/stack screen "Tasks" (`apps/mobile/src/screens/TasksScreen.tsx`) using a `SectionList` with the same groups as web (Overdue / Today / Upcoming / Later / No date / Done). Pull-to-refresh re-runs `listTasks`. Row tap opens the note; a leading checkbox toggles `done`. Status filter via a horizontal chip row.
- **Calendar subscription**: in the workspace settings screen, a "Calendar feed" section mirroring web. Enable → `issueCalendarFeed`; show the URL with a "Copy" button (`Clipboard`) and a "Add to calendar" button that opens the `webcal://` URL via `Linking.openURL` (iOS Calendar / Android handle the subscription). Rotate and Disable buttons as on web.
- The BlockNote WebView editor is unchanged; task metadata is separate from CRDT content, so no editor bridge work is needed.

## 6. Desktop

Inherits the web build via Tauri 2 (bundles `apps/web`), so §4 covers it. **Tauri specifics:** the `webcal://` and `.ics` links must open in the OS calendar app, not the embedded webview — use the Tauri shell `open` (opener plugin) for the "Add to calendar"/copy-URL actions so the OS handles the scheme. Copy-to-clipboard uses the existing web clipboard path (already permitted in the app's Tauri allowlist). Otherwise none.

## 7. Acceptance criteria + parity checklist

Acceptance criteria:
- [ ] Migration `0005_tasks.sql` applies cleanly; `document_tasks` and `calendar_feed_tokens` exist with the stated checks/indexes.
- [ ] Promoting a document (`POST /documents/:id/task`) makes it a task; `GET` returns it; demote (`DELETE`) leaves the document intact and removes it from `/tasks`.
- [ ] `PATCH` sets `completed_at` when status→`done` and clears it when moving away; invalid enums return `400`.
- [ ] `GET /tasks` honors `workspace_id`, `status`, `due_before/after`, `include_undated`, and `sort` (nulls last), and enforces membership (`403` otherwise).
- [ ] Issuing a feed returns a one-time `cal_…` token + URL; hitting `GET /calendar/:ws/:token.ics` (no auth) returns valid RFC 5545 with one `VEVENT` per dated, non-archived task, stable `UID`, correct all-day vs timed events, and updates `last_used_at`.
- [ ] Revoking the feed makes the ICS URL return `404`; unknown/rotated tokens return an indistinguishable `404`.
- [ ] A real calendar client (Google/Apple) subscribed to the URL shows tasks and updates them in place on edit (no duplicates).
- [ ] Viewers cannot create/update/delete tasks or issue feeds (`403`); non-members get `403` on `/tasks` and per-task reads.

Parity checklist (web ⇄ mobile — both must ship):
- [ ] Make task / remove task from a note — web ✅ / mobile ✅
- [ ] Set & edit status, priority, due date (with all-day toggle) — web ✅ / mobile ✅
- [ ] Agenda view with Overdue/Today/Upcoming/Later/No date/Done groups + status filter — web ✅ / mobile ✅
- [ ] Toggle task done from the agenda row — web ✅ / mobile ✅
- [ ] Open the underlying note from an agenda row — web ✅ / mobile ✅
- [ ] Enable / rotate / disable calendar feed; copy URL; one-time-token warning — web ✅ / mobile ✅
- [ ] "Add to calendar" opens the OS calendar via `webcal://` — web ✅ / mobile ✅ / desktop via Tauri opener ✅
