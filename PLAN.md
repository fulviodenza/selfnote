# Selfnote — Implementation Plan

Companion to `ARCHITECTURE.md` (the *what/why*). This is the *how*: concrete stack pins,
protocols, schemas, and per-phase acceptance criteria. Phases are ordered by risk: the CRDT
sync loop is proven first; everything downstream is conventional engineering.

---

## Phase 1 — Sync spike (retire the core risk)

**Goal:** two browser tabs live-edit one page; one goes offline, keeps editing, reconnects,
and merges cleanly. No auth, no Postgres — in-memory rooms + IndexedDB on the client.

### 1.1 Monorepo scaffold

```
selfnote/
├─ package.json / pnpm-workspace.yaml / turbo.json
├─ Cargo.toml                    # [workspace] members = ["server/sync"]
├─ apps/web/                     # React 18 + Vite + TS strict
├─ packages/core/                # @selfnote/core
├─ packages/editor/              # @selfnote/editor
└─ server/sync/                  # selfnote-sync (Rust bin)
```

### 1.2 Sync server (`server/sync`) — Rust

Crates: `yrs` (CRDT), `axum` (HTTP+WS upgrade), `tokio`, `dashmap` (room registry),
`tracing` + `tracing-subscriber`, `serde`/`serde_json` (config), `anyhow`.

Design:
- `GET /ws/:doc_id` → WebSocket upgrade → join room.
- **Room** = `{ doc: yrs::Doc, conns: broadcast set, awareness state }`, keyed in a
  `DashMap<DocId, Arc<Room>>`. Created on first join; dropped after last leave + idle TTL
  (keep the doc bytes in memory for the spike; Phase 2 persists).
- **Wire protocol = Yjs binary sync protocol v1** (`y-protocols/sync` + `y-protocols/awareness`
  framing: msg type varint 0=Sync{Step1,Step2,Update}, 1=Awareness). `yrs` speaks this via
  `yrs::sync` / update encode-decode — the JS `y-websocket` provider connects **unmodified**.
  Do not invent a custom protocol; wire-compat with stock Yjs providers is the whole point.
- On join: server sends SyncStep1 (its state vector); client replies SyncStep2 (diff);
  thereafter updates broadcast to all other room members.
- `GET /healthz`. Config via env (`SYNC_ADDR`, `SYNC_IDLE_TTL_SECS`).

### 1.3 Client packages

- **`@selfnote/core`**: `createDocConnection(docId, opts)` wrapping `Y.Doc` +
  `y-websocket` provider + `y-indexeddb` persistence + connection-status store. Pure TS,
  zero React deps (reusable from RN later). Exports typed block helpers (Phase 2 grows these).
- **`@selfnote/editor`**: **BlockNote** (`@blocknote/core` + `@blocknote/react`) — a
  Notion-style block editor built on ProseMirror/TipTap with first-class Yjs collab
  (`collaboration: { provider, fragment }`). Chosen over raw TipTap because it ships the
  Notion UX (slash menu, drag handles, block types) we'd otherwise rebuild.
  *Fallback if BlockNote fights us:* TipTap + `y-prosemirror` directly.
- **`apps/web`**: single page — doc picker (localStorage list), editor bound to
  `createDocConnection`, connection badge (online/offline/syncing), remote cursors
  (awareness), a "simulate offline" toggle (kill the provider) for demoing merge.

### 1.4 Acceptance criteria (all must pass)

1. Two tabs, same doc: keystrokes appear in the other tab < ~100 ms; remote cursor visible.
2. Tab A offline → both sides keep editing same paragraph → reconnect → both converge,
   no lost characters, no duplicated blocks.
3. Kill the server, restart it: clients reconnect and re-sync from their local state
   (server was memory-only — clients rehydrate it; proves client-side source-of-truth).
4. Full page reload while offline: doc loads from IndexedDB.
5. `cargo clippy -- -D warnings`, `cargo test` (protocol round-trip unit tests),
   `pnpm -r typecheck` clean.

---

## Phase 2 — API server, persistence, auth

**Goal:** multi-user, multi-workspace, durable storage. The spike becomes a real backend.

- **`server/api`** (Rust, `axum`, `sqlx` w/ compile-checked queries, `argon2`,
  `jsonwebtoken`, `utoipa` for OpenAPI). Shares a `server/common` crate with sync.
- **Postgres schema** (as in ARCHITECTURE §3): `users`, `workspaces`, `workspace_members`,
  `documents` (page tree via `parent_id`), `permissions`, `shares`, `doc_updates`
  (append-only BYTEA log), `doc_snapshots`, `files`. Migrations via `sqlx migrate`.
- **Auth:** email+password (argon2id) first; OIDC (any provider; test against Authentik)
  behind a feature flag. Session = httpOnly refresh cookie + short-lived access JWT.
- **Room tokens:** API issues 60 s single-use JWT `{doc_id, user_id, mode: rw|ro}`; sync
  server verifies signature (shared HS256 secret or RS256 pubkey via env) before admitting
  the WS. Sync stays auth-dumb.
- **Sync persistence:** on update → append to `doc_updates`; compaction task folds log into
  `doc_snapshots` every N=500 updates or T=5 min, prunes folded updates; snapshot also
  written to object storage (S3 API — MinIO in prod, local dir in dev). Room load =
  latest snapshot + tail of log.
- **Types to TS:** annotate API DTOs with `ts-rs` → generated `packages/core/src/api-types.ts`
  checked in CI (fail if drift).
- **Accept:** register/login; create workspace + nested pages; invite member (editor/viewer);
  viewer gets read-only room; server restart loses nothing; API has OpenAPI docs;
  `docker-compose.dev.yml` (postgres+minio) for local dev.

## Phase 3 — Desktop (Tauri)

- `apps/desktop`: Tauri 2.x shell loading the web bundle; deep-link `selfnote://`;
  tray + autostart optional. Local persistence stays IndexedDB (webview) — SQLite only if
  IndexedDB in webview proves flaky. Auto-updater wired to GitHub releases.
- **Accept:** macOS `.dmg` (+ Linux AppImage) builds in CI; full offline edit/merge parity
  with web; binary < 20 MB.

## Phase 4 — Mobile (React Native / Expo)

- `apps/mobile`: Expo + RN. Reuse `@selfnote/core` (WS + Yjs are pure JS). Persistence:
  `y-indexeddb` swapped for a SQLite adapter (`op-sqlite`) behind core's storage interface.
- **Editor = WebView** (`react-native-webview`) hosting the same BlockNote bundle; the Yjs
  doc lives RN-side, bridged to the webview via a `postMessage` update channel (both sides
  apply binary updates — CRDT makes the bridge trivial and lossless). Navigation, page tree,
  search, settings = native RN screens.
- **Accept:** iOS + Android dev builds; edit offline on the subway, merge on reconnect;
  cold-start-to-editable < 2 s on a page cached locally.

## Phase 5 — Deploy: Helm chart + backups

- `deploy/helm/selfnote`: templates for sync (Deployment+HPA), api, web (static, nginx),
  Ingress + cert-manager TLS; **dependencies:** CloudNativePG `Cluster` (WAL archiving →
  MinIO, PITR) and MinIO tenant; migration pre-upgrade hook Job.
- Off-site: CronJob replicating MinIO bucket → external S3 (optional values).
- **Accept:** clean install on a k3s/kind cluster from `helm install` + values.yaml only;
  documented **restore drill executed once** (PITR to a timestamp, snapshot restore) — a
  backup that hasn't been restored doesn't count.

## Phase 6 — Operator (Go, kubebuilder)

- `operator/`: CRD `Selfnote` v1alpha1 — spec: `version`, `host`, `replicas{sync,api}`,
  `storage{dbSize,objectSize}`, `backup{schedule,offsite{...}}`, `auth{oidc{...},smtp{...}}`.
- Reconcile = own the Deployments/Services/Ingress + **create/patch** CloudNativePG and
  MinIO CRs (compose operators, don't reimplement); status conditions
  (`Ready`, `DBReady`, `BackupHealthy`, `MigrationPending`); upgrades gated:
  migrate-Job → verify → rollout; e2e via `envtest` + kind.
- **Accept:** `kubectl apply` one CR on a bare cluster (with the three upstream operators
  installed) → working instance; version bump in CR → zero-manual upgrade; deleting the CR
  keeps PVCs/backups (finalizer policy `retain`).

## Phase 7 — Product polish

- **Search:** Postgres FTS over text extracted from snapshots at compaction time
  (`doc_search(doc_id, tsvector)`); upgrade path to Meilisearch if needed.
- **Databases/tables** (Notion databases): schema in doc metadata, rows = child docs;
  table/board views. **Sharing:** public read-only links (`shares`). **Presence polish**,
  page history (snapshots already give us time-travel), import/export (Markdown).

---

## Cross-cutting

- **CI (GitHub Actions):** rust fmt/clippy/test · pnpm typecheck/lint/test · web build ·
  docker images (sync, api, web) on tag · Tauri bundles · helm lint.
- **Testing spine:** protocol round-trip tests (yrs ↔ yjs fixtures), sync integration test
  (2 headless clients vs real server, tokio), Playwright e2e for the offline-merge flow.
- **Licensing note:** MinIO is AGPL; fine for self-hosting. Alternative: SeaweedFS/Garage
  if that ever matters.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| yrs ↔ y-websocket wire incompat edge cases | Phase 1 acceptance test #1–3 hit it immediately; pin yjs & yrs versions; fixture tests |
| BlockNote Yjs integration limits (custom blocks) | Fallback: TipTap + y-prosemirror (same underlying stack) |
| Update-log growth / room-load latency | Compaction from day one (Phase 2), snapshot-first loads |
| WebView editor UX on mobile | Contained: bridge is binary Yjs updates, so swapping to a native editor later changes UI only, not sync |
| Operator scope creep | Helm chart is the deployable unit through Phase 5; operator only wraps proven manifests |

## Open items (decide when reached, defaults noted)

- Room-token signing: HS256 shared secret (default) vs RS256 — revisit at Phase 2.
- Desktop SQLite vs IndexedDB — measure in Phase 3, default IndexedDB.
- Meilisearch — only if Postgres FTS disappoints in Phase 7.
