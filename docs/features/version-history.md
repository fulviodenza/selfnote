# Version history / time-travel

## 1. Problem & goal

A note's content lives only as an append-only Yjs CRDT log (`doc_updates`) compacted into `doc_snapshots`, so there is no way for a user to see how a page looked in the past or undo a bad edit beyond client-side undo. This feature exposes that history: users can browse named restore points along a timeline, preview any past state read-only, and restore one as a new edit (never destroying history). Restore is implemented as a forward CRDT update (a diff that turns the current state back into the chosen past state), keeping all collaborators and the sync log consistent.

## 2. Data model & migration

The raw `doc_updates` log is too fine-grained and gets pruned on compaction, so it cannot back a durable timeline on its own. We add an explicit **checkpoints** table: a snapshot of the full doc state captured at a point in time, plus a `label`, `kind`, and author. Checkpoints are created automatically (periodically / on room drop) and manually ("Save version"), and are the unit users browse and restore. They are immutable once written.

Next migration number is `0005`.

```sql
-- server/migrations/0005_version_history.sql
-- Immutable point-in-time snapshots of a document's CRDT state, powering the
-- version-history / time-travel UI. Independent of doc_snapshots (which is a
-- single mutable compaction row) so history survives log pruning.
create table doc_checkpoints (
    id           uuid primary key default gen_random_uuid(),
    doc_id       uuid not null references documents(id) on delete cascade,
    -- Full document state as a single merged v1 Yjs update (bytea).
    snapshot     bytea not null,
    -- Size of the snapshot in bytes (denormalized for cheap listing).
    size_bytes   bigint not null,
    -- 'manual' = user pressed "Save version"; 'auto' = periodic/on-drop capture;
    -- 'restore' = checkpoint captured immediately before a restore was applied.
    kind         text not null check (kind in ('manual', 'auto', 'restore')),
    -- Optional user-supplied name; null for auto checkpoints.
    label        text,
    -- Author of the change/checkpoint; null for system-generated auto captures.
    created_by   uuid references users(id) on delete set null,
    created_at   timestamptz not null default now()
);
-- List newest-first per document.
create index doc_checkpoints_doc_idx on doc_checkpoints (doc_id, created_at desc);
```

No columns are added to existing tables. `documents.updated_at` is already present and is touched on restore.

## 3. API contract

All endpoints are under the Rust api (`server/api`), registered in `server/api/src/main.rs`, handled in a new `server/api/src/history.rs`. All require auth via the `AuthUser` extractor (`Authorization: Bearer <JWT|snp_…>` — JWT access token or `snp_` PAT; both accepted identically). Authorization is by workspace membership on the document's `workspace_id`:
- **Read** (list, get state, diff): any member role including `viewer`.
- **Write** (create checkpoint, restore): member role must not be `viewer` (i.e. `owner`/`admin`/`editor`), else `403 Forbidden`.

Errors follow the existing `AppError` shape: `401 Unauthorized` (bad/missing token), `403 Forbidden` (not a member / viewer on write), `404 Not Found` (doc or checkpoint missing / not in an accessible workspace), `400 Bad Request` (validation). All bodies are JSON; all CRDT byte payloads are base64-encoded standard (same convention as `GET /documents/:id/content`).

Timestamps are RFC 3339 / ISO 8601 UTC strings.

### 3.1 List checkpoints

`GET /documents/:id/history`

- Auth: any member (JWT or PAT).
- Query params (all optional): `limit` (default `50`, max `200`), `before` (RFC3339 timestamp — return checkpoints strictly older than this, for pagination), `kind` (one of `manual|auto|restore` to filter).
- Request body: none.
- Response `200`:

```json
{
  "checkpoints": [
    {
      "id": "b2c1…",
      "doc_id": "a1f0…",
      "kind": "manual",
      "label": "Before rewrite",
      "size_bytes": 20418,
      "created_by": "u123…",
      "created_by_name": "Fulvio",
      "created_at": "2026-09-04T10:12:00Z"
    }
  ],
  "next_before": "2026-09-04T10:12:00Z"
}
```

`created_by` and `created_by_name` are `null` for `auto` checkpoints. `next_before` is the `created_at` of the last returned row, or `null` when fewer than `limit` rows were returned (no more pages). Ordered newest-first.

### 3.2 Get a checkpoint's full state

`GET /documents/:id/history/:checkpoint_id`

- Auth: any member.
- Request body: none.
- Response `200`:

```json
{
  "id": "b2c1…",
  "doc_id": "a1f0…",
  "kind": "manual",
  "label": "Before rewrite",
  "size_bytes": 20418,
  "created_by": "u123…",
  "created_by_name": "Fulvio",
  "created_at": "2026-09-04T10:12:00Z",
  "updates": ["<base64 v1 Yjs update>"]
}
```

`updates` is an ordered list of base64 v1 Yjs updates (identical shape to `GET /documents/:id/content`); for a checkpoint it is always exactly one element — the full merged snapshot. Clients apply it into a fresh `Y.Doc` and render the `document-store` fragment read-only to preview the past state. `404` if `checkpoint_id` does not belong to `:id`.

### 3.3 Create a checkpoint (manual "Save version")

`POST /documents/:id/history`

- Auth: member, non-viewer.
- Request body:

```json
{ "label": "Before rewrite" }
```

`label` optional (max 200 chars; trimmed; empty → stored as `null`). No `snapshot` is sent by the client — the server computes the doc's **current** merged state (snapshot + tail of `doc_updates`, exactly as `get_content` does) and stores it. `kind` is always `manual` for this endpoint; `created_by` = caller.
- Response `201`: the checkpoint metadata object (same fields as a list item, without `updates`).
- `400` if `label` exceeds 200 chars.

### 3.4 Restore a checkpoint

`POST /documents/:id/history/:checkpoint_id/restore`

- Auth: member, non-viewer.
- Request body (optional):

```json
{ "label": "Restored: Before rewrite" }
```

- Behavior (all server-side, transactional):
  1. Capture the current merged state as a new checkpoint with `kind = 'restore'`, `created_by` = caller, `label` = optional body `label` or a default (`"Before restore"`), so the pre-restore state is never lost.
  2. Compute a single v1 Yjs update that transforms the **current** doc state into the **target checkpoint** state (build a `Y.Doc` at current state, then `apply_update(target)` and diff against the current state vector — i.e. `encode_state_as_update_v1(current_state_vector)` of the target-applied doc; equivalently a merge that yields the target as the resulting visible state). Because CRDT updates are additive, restore replays the target's content forward — it does not delete history.
  3. Append that update to `doc_updates` for `:id` (same path as `set_content`) so all live sync clients converge to the restored state, and touch `documents.updated_at = now()`.
- Response `200`:

```json
{
  "restored_from": "b2c1…",
  "pre_restore_checkpoint": "d4e5…",
  "update": "<base64 v1 Yjs update applied to the log>"
}
```

`update` lets a client that is currently editing apply the restore immediately without a round-trip; other clients receive it over the sync socket. `404` if the checkpoint is missing / mismatched.

### 3.5 Delete a checkpoint (optional, ships with parity)

`DELETE /documents/:id/history/:checkpoint_id`

- Auth: member, non-viewer.
- Request body: none.
- Deletes a checkpoint row (history-management only; does not touch document content). `restore`-kind and `auto`-kind rows are deletable too.
- Response `204 No Content`. `404` if not found.

## 4. Web UX (apps/web)

- **Entry point:** a "Version history" item in the document header/overflow menu (near where share/AI live), plus a keyboard shortcut. Opens a right-side panel/drawer (reusing the AI sidebar layout patterns and "Ink & Paper" styles in `apps/web/src/styles.css`).
- **Components** (new, under `apps/web/src/components/history/`):
  - `HistoryPanel.tsx` — drawer container; on open calls `GET /documents/:id/history`, renders a reverse-chronological timeline list with infinite scroll via `next_before`. Filter chips for `manual` / `auto` / `restore`. A "Save version" button (prompts for optional label → `POST /documents/:id/history`).
  - `HistoryEntry.tsx` — one row: relative time ("2h ago"), author name, `kind` badge, optional label, size. Click selects it.
  - `HistoryPreview.tsx` — on select, `GET /documents/:id/history/:checkpoint_id`, applies the returned base64 update into a throwaway `Y.Doc` (via `packages/core`) and renders a **read-only** BlockNote editor (`packages/editor`) bound to the `document-store` fragment. A banner marks it read-only/preview with the checkpoint timestamp.
  - Actions in preview: **Restore** (confirm dialog → `POST …/restore`; on success, apply returned `update` to the live editor doc and close the panel), **Delete** (confirm → `DELETE`).
- **API client:** add `listHistory`, `getCheckpoint`, `createCheckpoint`, `restoreCheckpoint`, `deleteCheckpoint` to `apps/web/src/api.ts` (Bearer auth via existing token handling).
- **Behavior:** live editing continues underneath; preview never mutates the live doc until Restore is pressed. Viewers see the panel and can preview but the Save/Restore/Delete actions are hidden/disabled (role-gated client-side; server enforces).

## 5. Mobile UX (apps/mobile)

Strict feature parity with web, adapted to React Native (standalone Expo app; API client `apps/mobile/src/api.ts`, WebView BlockNote editor + expo-sqlite).

- **Entry point:** "Version history" action in the document screen's header menu / action sheet.
- **Screens/components** (new, under `apps/mobile/src/screens/` and `components/history/`):
  - `HistoryScreen` — a full-screen modal (RN `Modal` / stack screen) with a `FlatList` timeline fed by `GET /documents/:id/history`, `onEndReached` pagination via `next_before`, and filter chips. "Save version" button in the header (prompts label via `Alert.prompt`/modal input → `POST`).
  - Tapping an entry opens `HistoryPreviewScreen`: fetches the checkpoint, posts the base64 update into the existing BlockNote WebView in a **read-only** mode (message the WebView to load a throwaway doc + disable editing), with a read-only banner and timestamp.
  - Actions: **Restore** (confirm via `Alert` → `POST …/restore`; on success send the returned `update` into the live WebView doc and dismiss), **Delete** (confirm → `DELETE`).
- **API client:** add the same five methods to `apps/mobile/src/api.ts`, mirroring web signatures and Bearer auth.
- **Offline:** listing/preview/restore require connectivity (history lives server-side); when offline, show a disabled state with a "reconnect to view history" message. No expo-sqlite caching of checkpoints in v1.
- **Role gating:** viewers can browse/preview; Save/Restore/Delete hidden. Server enforces.

## 6. Desktop

Desktop (Tauri 2) bundles `apps/web`, so implementing section 4 covers it. No Tauri-specific work required — history is fetched over HTTP the same way as web, and the read-only preview uses the same BlockNote path. **Tauri specifics: none.**

## 7. Acceptance criteria + parity checklist

**Acceptance criteria**

1. `0005_version_history.sql` applies cleanly and creates `doc_checkpoints` with the index; migration is idempotent under the existing runner.
2. `POST /documents/:id/history` stores a checkpoint equal to the doc's current merged state; the value returned by a subsequent `GET …/:checkpoint_id` (`updates[0]`) reconstructs to byte-equivalent visible content as `GET /documents/:id/content` at capture time.
3. `GET /documents/:id/history` returns newest-first, respects `limit`/`before`/`kind`, and paginates correctly via `next_before` (null on last page).
4. Restore applies a forward update to `doc_updates`, all connected sync clients converge to the target state, `updated_at` is bumped, and a `kind='restore'` pre-restore checkpoint exists afterward — with **no rows deleted** from `doc_updates`/`doc_snapshots`.
5. Restoring, then restoring the auto-created pre-restore checkpoint, returns the document to its original state (round-trip safe).
6. A `viewer` gets `403` on create/restore/delete but `200` on list/get. A non-member gets `404`/`403`. Missing/invalid token gets `401`. PAT (`snp_…`) and JWT both authenticate.
7. Requesting a `checkpoint_id` that belongs to another document returns `404`.
8. Web and mobile both render a read-only preview that never mutates the live doc until Restore is confirmed.

**Parity checklist (web ⇄ mobile)**

| Capability | Web | Mobile |
|---|---|---|
| Open version-history view from doc menu | ✅ | ✅ |
| Timeline list, newest-first, paginated | ✅ | ✅ |
| Filter by kind (manual/auto/restore) | ✅ | ✅ |
| Show author, relative time, label, size, kind badge | ✅ | ✅ |
| "Save version" with optional label | ✅ | ✅ |
| Read-only preview of a past state (BlockNote) | ✅ | ✅ |
| Restore (with confirm) applied live | ✅ | ✅ |
| Delete a checkpoint (with confirm) | ✅ | ✅ |
| Viewer role: browse/preview only, actions hidden | ✅ | ✅ |
| Auth via Bearer JWT/PAT | ✅ | ✅ |
