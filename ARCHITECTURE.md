# Selfnote — Architecture Design

A self-hosted, Notion-like workspace: **real-time multiplayer**, **offline-first**,
deployable on Kubernetes via a custom **operator**, with **web, desktop, and mobile** clients.

Status: initial design (v0). Backend language finalized in §5.

---

## 1. The one decision that shapes everything: local-first + CRDT

Requirements chosen:

- **Full real-time multiplayer** — two people can edit the same block simultaneously.
- **Offline-first (must-have)** — clients work fully offline and sync later.

These two together mean the server *cannot* be the sole source of truth resolving edits
by timestamp. Two clients can diverge (one offline for a day) and must merge without losing
data or requiring manual conflict resolution. The industry answer is a **CRDT**
(Conflict-free Replicated Data Type).

**We use Yjs as the CRDT.** It is the most mature, battle-tested option, has native rich-text
support (`Y.XmlFragment` / `Y.Text`), editor bindings (ProseMirror/TipTap/BlockNote), and a
Rust port (`yrs`) that is **wire-compatible** — so JS clients and a Rust server speak the same
protocol. This lets us put the CRDT logic in JS on every client and a fast `yrs` engine on the
server without reimplementing anything.

Consequence: **the document is not rows in a table. Each document is a Yjs doc.** Postgres
stores *metadata and the update log*, not the block tree itself. This is the mental shift from
a classic CRUD app.

---

## 2. High-level architecture

```
                          ┌──────────────────────────────────────────┐
   CLIENTS (local-first)  │                 SERVER (k8s)               │
                          │                                            │
 ┌──────────────┐  WS/CRDT│   ┌───────────────┐    ┌────────────────┐ │
 │ Web (React)  │◄────────┼──►│  Sync Server  │◄──►│   Postgres     │ │
 │ + Yjs + IDB  │         │   │  (yrs, Rust)  │    │ (CloudNativePG)│ │
 └──────────────┘         │   │  rooms/awareness│   │ meta + updates │ │
 ┌──────────────┐  WS     │   └──────┬────────┘    └────────────────┘ │
 │ Desktop      │◄────────┼──►       │                                 │
 │ (Tauri)+Yjs  │         │          │ snapshots     ┌───────────────┐ │
 │ + SQLite     │         │          └──────────────►│  MinIO (S3)   │ │
 └──────────────┘         │   ┌───────────────┐      │ blobs+backups │ │
 ┌──────────────┐  HTTP   │   │  API Server   │◄────►└───────────────┘ │
 │ Mobile (RN)  │◄────────┼──►│ auth, perms,  │                        │
 │ + Yjs+SQLite │         │   │ search, files │      ┌───────────────┐ │
 └──────────────┘         │   └───────────────┘      │  Operator     │ │
                          │                          │ (reconciles ▲)│ │
                          │                          └───────────────┘ │
                          └──────────────────────────────────────────┘
```

Two server services, one clear split:

- **Sync Server** (the hot path): holds live Yjs "rooms", relays CRDT updates between
  connected clients over WebSocket, tracks awareness (cursors/presence), and persists the
  update stream. This is `yrs`. Must be fast and low-memory — hundreds of rooms in RAM.
- **API Server** (the control plane): auth, workspace/permission checks, document metadata,
  full-text search, file upload URLs, sharing. Stateless, horizontally scalable. Gates *who*
  may open which room; the Sync Server enforces the token it issues.

---

## 3. Data model

**Metadata (Postgres — normal relational):**

- `users`, `workspaces`, `workspace_members` (roles: owner/admin/editor/viewer)
- `documents` (id, workspace_id, parent_id for the page tree, title, icon, archived, timestamps)
- `permissions` (per-doc overrides), `shares` (public links, expiry)
- `doc_updates` (doc_id, seq, update BYTEA, author, ts) — append-only Yjs update log
- `doc_snapshots` (doc_id, seq, snapshot BYTEA, ts) — periodic compaction of the log
- `files` (id, doc_id, s3_key, mime, size)

**Document content (Yjs doc per page):**

- Root `Y.Map` → ordered list of blocks (or `Y.XmlFragment` if using ProseMirror-native).
- Each block: `{ id, type, props, content: Y.Text, children }`.
- Block types: paragraph, heading, list, todo, toggle, code, image, table, embed, database-row…
- The **page tree** (nesting of pages) lives in Postgres metadata; **block tree within a page**
  lives in the Yjs doc. This keeps navigation/search queryable while edits stay CRDT-merged.

**Persistence flow:** client emits Yjs update → Sync Server appends to `doc_updates` → every
N updates or T seconds, compact into a `doc_snapshot` and prune old updates → snapshots also
pushed to MinIO for backup. On room load: latest snapshot + updates-since replayed into `yrs`.

---

## 4. Frontend strategy — maximize reuse across web / desktop / mobile

Your goal ("replicable with low effort") is achievable for **everything except the rich-text
editor**. Be honest about that seam up front.

**Shared TS core package (`@selfnote/core`) — 100% reused on all three platforms:**

- Domain models & types (also shared with a TS-typed API if backend is TS; otherwise generated).
- Yjs document wiring, block operations (insert/move/delete/transform).
- Sync client: WebSocket provider, awareness, reconnection, offline queue.
- Local persistence adapter interface (IndexedDB on web, SQLite on desktop/mobile).
- Auth/session, permissions logic, API client.

**UI layer — React everywhere, but two render targets:**

| Platform | Shell | UI | Local store | Editor |
|----------|-------|----|-----|--------|
| Web | browser | React + Tailwind | IndexedDB (`y-indexeddb`) | TipTap/BlockNote + `y-prosemirror` |
| Desktop | **Tauri** (Rust) | same React app | SQLite | same as web |
| Mobile | **React Native** | RN + shared logic | `op-sqlite` | see below |

- **Desktop = Tauri**, not Electron: ~10× smaller binaries, lower memory, Rust core (synergy
  if backend is Rust), and it can literally load the *same* React web bundle. Highest reuse.
- **The editor is the one hard seam.** ProseMirror is DOM-based and does not run natively in
  React Native. Two realistic options:
  - **(A) WebView editor on mobile** — run the exact web editor inside a WebView, bridge the
    Yjs doc in/out. Maximum reuse, one editor codebase; cost: native-feel compromises, bridge
    complexity for keyboard/selection.
  - **(B) Native RN editor** (e.g. `10tap`/`react-native-live-markdown`) sharing only the Yjs
    **data model**, not the editor UI. Better feel; cost: a second editor implementation to
    keep in feature-parity.
  - **Recommendation: start with (A)** to ship all platforms fast; revisit (B) for mobile if
    editing feel becomes a complaint. Everything *around* the editor (navigation, page tree,
    sync, search, settings) is shared React logic regardless.

Monorepo so the core package is imported directly (no publish step): **pnpm + Turborepo**.

---

## 5. Backend language — the discussion you deferred

Constraints that matter: CRDT hot path (Yjs-compatible), offline-first, an operator, and
"keep languages few for maintainability."

**Recommendation: two languages total — Rust + TypeScript.**

- **Sync Server → Rust (`yrs`).** This is the performance-critical, memory-sensitive service
  holding many live docs. `yrs` is wire-compatible with JS Yjs, so clients stay on Yjs. Go's
  CRDT story is immature; Node works (y-websocket) but uses more memory per room. Rust wins here.
- **API Server → Rust (`axum`)** *or* **TypeScript (`Hono`/`Fastify`)**:
  - Rust `axum`: single backend language, shares types with the sync server, fast. Slower
    feature velocity.
  - TS: shares types *directly* with the frontend core (one type system end-to-end), fastest
    feature velocity, but adds a runtime. Given the frontend is TS-heavy, this is tempting.
  - **Lean Rust** for one server language and reuse `@selfnote/core` types via generated
    bindings (`ts-rs` emits TS types from Rust structs) — you still get end-to-end types.
- **Operator → Go (`kubebuilder`)** or **Rust (`kube-rs`)**. Go has the richer operator
  ecosystem and examples; `kube-rs` keeps you in one backend language. **Pick Go if you value
  operator ecosystem/docs; pick Rust to stay bilingual.** This is low-churn code, so a third
  language here is tolerable if Go accelerates it.

If you'd rather **minimize risk/ramp-up over raw performance**, the alternative is
**TypeScript everywhere on the server** (Node + Yjs + y-websocket) + Go operator. Simpler to
build, heavier at runtime, single type system. Valid for a self-hosted / small-scale target.

Decision to make together: **Rust-core (perf, 2 langs) vs TS-core (velocity, 1 client lang).**
Defaulting to **Rust sync + Rust API + Go operator** unless you prefer velocity.

---

## 6. Storage & backups

- **Postgres** via the **CloudNativePG** operator: HA, streaming replication, and — key —
  **built-in continuous backup (WAL archiving) to S3/MinIO with point-in-time recovery.**
  We don't reinvent DB backup; we depend on a proven operator.
- **MinIO** (S3-compatible, self-hosted) for: file/image uploads, Yjs snapshots, and Postgres
  backup target. Enable bucket **versioning** + lifecycle rules.
- **Backup layers:**
  1. Postgres continuous WAL + daily base backup → MinIO (PITR).
  2. Yjs snapshots in MinIO (versioned) — content is independently recoverable.
  3. Optional off-site replication (MinIO → external S3/Backblaze) via our operator CronJob.
- **Restore drill** is part of the operator's scope — a documented, tested restore path, not
  just backups that exist.

---

## 7. The operator — worth it? Yes, given k8s.

Since you chose Kubernetes, a custom operator pays off: it turns "deploy Selfnote" into one
CR. But **it should compose existing operators, not reimplement them.**

**CRD: `Selfnote` (kind).** Spec: version, domain, replicas, storage sizes, backup schedule,
SMTP, OIDC config. The operator reconciles:

- Postgres cluster (delegates to **CloudNativePG**).
- MinIO tenant (delegates to **MinIO operator**) + buckets.
- Sync Server + API Server Deployments, HPA, Services.
- Ingress + TLS (delegates to **cert-manager**).
- DB migrations as a pre-upgrade Job (gated rollout).
- Backup CronJobs + off-site replication.
- Version upgrades with ordered migrate→rollout→verify.

**Value:** one-command install, safe upgrades (migrations gated), backups/restore automated,
self-healing. **Build it in a later phase** — first ship a plain `Helm chart` / manifests so
you can deploy while the operator matures. (You said "k8s + operator"; the pragmatic path is
Helm-first, operator-second, and the operator can wrap the same chart logic.)

---

## 8. Auth

- **OIDC-first** (self-hosted **Authentik**/**Keycloak**, or plain email+password for solo).
  API Server validates OIDC; issues short-lived **room tokens** (JWT scoped to doc+permission)
  that the Sync Server verifies before admitting a WebSocket to a room. Clean separation:
  API decides *who can*, Sync enforces *per connection*.

---

## 9. Repo layout (monorepo)

```
selfnote/
├─ apps/
│  ├─ web/            # React + Vite
│  ├─ desktop/        # Tauri (wraps web build)
│  └─ mobile/         # React Native (Expo)
├─ packages/
│  ├─ core/           # @selfnote/core — shared TS: models, Yjs, sync client, api client
│  ├─ editor/         # shared editor (TipTap/BlockNote config)
│  └─ ui/             # shared React components (where RN/DOM allow)
├─ server/
│  ├─ sync/           # Rust (yrs) WebSocket sync service
│  ├─ api/            # Rust (axum) or TS — control plane
│  └─ migrations/     # SQL
├─ operator/          # Go (kubebuilder) or Rust (kube-rs)
├─ deploy/
│  ├─ helm/           # Helm chart (phase 1 deploy)
│  └─ operator-crds/  # CRDs (phase 3)
└─ ARCHITECTURE.md
```

Tooling: **pnpm + Turborepo** (TS), **Cargo workspace** (Rust), **Go module** (operator).

---

## 10. Delivery phases

1. **Skeleton & sync spike (proof of the hard part first).**
   Monorepo + `@selfnote/core` + Rust sync server (`yrs`) + web app with a TipTap+Yjs editor.
   Two browser tabs editing the same doc live, one goes offline, edits, reconnects, merges.
   *If this works, the project's core risk is retired.*
2. **API + persistence.** Auth (email/pw + OIDC), workspaces, page tree, permissions, room
   tokens, Postgres update log + snapshot compaction, file uploads to MinIO.
3. **Desktop (Tauri) + local SQLite persistence + offline queue.**
4. **Mobile (RN)** with WebView editor (option A), SQLite, offline.
5. **Deploy: Helm chart** → CloudNativePG + MinIO + services + cert-manager. First real
   self-hosted install with working backups + a tested restore.
6. **Operator** wrapping it all: `Selfnote` CRD, gated upgrades, backup automation.
7. **Polish:** search, databases/tables view, sharing links, real-time presence/cursors.

**Guiding principle: build phase 1 before committing to anything else.** The CRDT sync loop is
the make-or-break; everything else is comparatively conventional.
```
