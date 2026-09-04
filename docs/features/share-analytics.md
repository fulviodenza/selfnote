# Share link analytics

## 1. Problem & goal

Owners create public share links (`shares` table, resolved anonymously via `GET /shares/:id`) but have no visibility into whether a link is being used. This feature records a view every time a share link is resolved and surfaces per-share **total view count** and **last-viewed timestamp** to workspace editors, so they can gauge reach and revoke stale links with confidence.

## 2. Data model & migration

New migration `server/migrations/0005_share_analytics.sql`. We add denormalized counters to `shares` (cheap reads for the analytics list) and an append-only `share_views` log (future per-day breakdowns; keeps the counter authoritative even if we recompute).

```sql
-- 0005_share_analytics.sql

-- Denormalized counters on the share for O(1) reads.
alter table shares add column view_count   bigint      not null default 0;
alter table shares add column last_viewed_at timestamptz;

-- Append-only view log. One row per successful resolve.
create table share_views (
    id         bigserial   primary key,
    share_id   uuid        not null references shares(id) on delete cascade,
    viewed_at  timestamptz not null default now()
);
create index share_views_share_idx on share_views (share_id, viewed_at);
```

Recording on resolve (inside the existing `resolve` handler, after the expiry check passes) is a single transaction:

```sql
insert into share_views (share_id) values ($1);
update shares set view_count = view_count + 1, last_viewed_at = now() where id = $1;
```

## 3. API contract

All timestamps are RFC 3339 / ISO 8601 UTC strings (or `null`). `share_id` / `doc_id` are UUID strings.

### 3.1 `GET /shares/:id` (existing — behavior change only)

- **Auth:** public (no `Authorization` header).
- **Request:** none.
- **Behavior change:** on a successful resolve (share exists and is not expired) the server records exactly one view (insert into `share_views` + increment `shares.view_count` + set `last_viewed_at = now()`) before responding. Expired/not-found requests (which return `404`) record **no** view.
- **Response `200`** (unchanged shape):
```json
{ "doc_id": "uuid", "mode": "ro", "token": "…", "expires_in": 3600 }
```
- **Response `404`:** share not found or expired (no view recorded).

### 3.2 `GET /documents/:doc_id/shares` (new — list shares with analytics)

Lists every share link for a document with its analytics. This is the analytics source of truth for web/mobile/desktop.

- **Auth:** JWT **or** PAT (`snp_…`) via `AuthUser`. Caller must be a workspace member with role `owner` or `editor` (i.e. `member_role != "viewer"`), matching the permission check already enforced in `shares::create`. Otherwise `403`.
- **Request:** none.
- **Response `200`:**
```json
{
  "shares": [
    {
      "id": "uuid",
      "doc_id": "uuid",
      "mode": "ro",
      "url": "/shared/uuid",
      "view_count": 42,
      "last_viewed_at": "2026-09-04T10:15:00Z",
      "expires_at": "2026-10-04T10:15:00Z",
      "created_at": "2026-09-01T09:00:00Z"
    }
  ]
}
```
  - `last_viewed_at` is `null` if never viewed. `expires_at` is `null` if the link never expires.
  - Sorted by `created_at` descending.
- **Errors:** `401` (missing/invalid token), `403` (viewer or non-member), `404` (document does not exist).

### 3.3 `GET /shares/:id/analytics` (new — single-share analytics)

Convenience endpoint for a detail view / after creating a link.

- **Auth:** JWT or PAT via `AuthUser`. Caller must be `owner`/`editor` of the workspace owning the share's document (resolve `share -> doc -> workspace`, then `member_role != "viewer"`). Otherwise `403`.
- **Request:** none.
- **Response `200`:**
```json
{
  "id": "uuid",
  "doc_id": "uuid",
  "mode": "rw",
  "url": "/shared/uuid",
  "view_count": 42,
  "last_viewed_at": "2026-09-04T10:15:00Z",
  "expires_at": null,
  "created_at": "2026-09-01T09:00:00Z"
}
```
- **Errors:** `401`, `403`, `404` (share not found).

Route wiring (`server/api/src/main.rs`):
```rust
.route("/documents/:id/shares", get(shares::list).post(shares::create))
.route("/shares/:id", get(shares::resolve))
.route("/shares/:id/analytics", get(shares::analytics))
```

## 4. Web UX (apps/web)

- **API client (`apps/web/src/api.ts`):** extend `ShareInfo` with `view_count: number` and `last_viewed_at: string | null` (and reuse for the list). Add:
  - `listShares(docId): Promise<{ shares: ShareAnalytics[] }>` → `GET /documents/${docId}/shares`.
  - `shareAnalytics(shareId): Promise<ShareAnalytics>` → `GET /shares/${shareId}/analytics`.
  Define `ShareAnalytics` = `ShareInfo & { view_count; last_viewed_at; expires_at; created_at }`.
- **Component:** new `ShareAnalyticsPanel` in `App.tsx` (co-located with the existing share bar around the `AppRoot` editor toolbar, lines ~613–660). The existing **Share** button opens/reveals a small panel that:
  - Calls `listShares(doc.id)` on open.
  - Renders each link: the `/shared/:id` URL (copyable, reusing the existing copy handler), mode badge (`ro`/`rw`), **view count**, and **last viewed** (relative time, e.g. "2 hours ago"; "Never" when `last_viewed_at` is null).
  - After `createShare` succeeds, prepend the new link (0 views, last viewed "Never") and copy its URL as today.
- **Behavior:** counts refresh when the panel is (re)opened; no live polling. Owners/editors only — the button is already gated to non-viewers.
- **Styling:** reuse `.share-bar` / `.share-label` tokens in `styles.css`; add a `.share-stats` row (Ink & Paper spacing).

## 5. Mobile UX (apps/mobile)

Strict parity with web, adapted to React Native.

- **API client (`apps/mobile/src/api.ts`):** mirror the web additions — extend `ShareInfo` with `view_count` and `last_viewed_at`, add `listShares(docId)` and `shareAnalytics(shareId)` hitting the identical endpoints, and export the same `ShareAnalytics` type.
- **Component:** a `ShareAnalyticsSheet` (React Native `Modal`/bottom sheet) opened from the document's Share action. It renders a `FlatList` of the document's share links, each row showing: the share URL with a **Copy** button (`expo-clipboard` / `Clipboard.setStringAsync`), a mode badge, **view count**, and **last viewed** relative time ("Never" when null).
- **Behavior:** fetch on sheet open; pull-to-refresh (`RefreshControl`) re-runs `listShares`. Creating a share prepends the new row and copies its URL, matching web.
- **Gating:** same owner/editor rule; the Share entry point is hidden for viewers.

## 6. Desktop

Inherits the web build via Tauri 2 (bundles `apps/web`) — no separate implementation. **Tauri specifics:** none. Copy-to-clipboard already uses `navigator.clipboard`, which works in the Tauri webview; no native clipboard plugin required.

## 7. Acceptance criteria + parity checklist

**Acceptance criteria**
- Resolving a valid, non-expired share via `GET /shares/:id` increments its `view_count` by exactly 1 and sets `last_viewed_at` to the resolve time; an expired or non-existent share records no view and returns `404`.
- `GET /documents/:doc_id/shares` returns all shares for the document with correct `view_count`, `last_viewed_at`, `expires_at`, `created_at`, sorted newest-first, and returns `403` for viewers / non-members and `401` for unauthenticated callers.
- `GET /shares/:id/analytics` returns the same fields for one share with identical auth rules.
- A brand-new share reports `view_count = 0` and `last_viewed_at = null`.
- Web and mobile both display view count and last-viewed (relative time; "Never" when null) for every share link of a document, and refresh those numbers on open.
- Migration `0005_share_analytics.sql` applies cleanly and backfills existing shares with `view_count = 0`, `last_viewed_at = null`.

**Parity checklist (web ⇄ mobile)**

| Capability | Web (apps/web) | Mobile (apps/mobile) |
| --- | --- | --- |
| List a document's share links | ✅ ShareAnalyticsPanel | ✅ ShareAnalyticsSheet |
| Show per-link view count | ✅ | ✅ |
| Show per-link last-viewed (relative, "Never") | ✅ | ✅ |
| Copy share URL | ✅ navigator.clipboard | ✅ expo-clipboard |
| Refresh analytics | ✅ on open | ✅ on open + pull-to-refresh |
| Create link then see it in list | ✅ | ✅ |
| Owner/editor gating (hidden for viewers) | ✅ | ✅ |
| Uses same endpoints/types | ✅ | ✅ |
