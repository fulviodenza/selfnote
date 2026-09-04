# Selfnote

A **self-hosted, Notion-like workspace** — real-time multiplayer editing, offline-first,
with **web, desktop, and mobile** clients that all talk to your own server. Optional
**AI Assist** runs against a model you control (local Claude CLI, the Anthropic API, or
Ollama). Your notes, your instance, your keys.

Built on a CRDT core (Yjs / [yrs](https://github.com/y-crdt/y-crdt)) so edits merge
cleanly across devices and offline sessions, and a block editor
([BlockNote](https://www.blocknotejs.org/)) shared by every client.

## Features

- **Real-time collaboration** — multiple cursors, live presence, conflict-free merges.
- **Offline-first** — keep editing with no connection; changes reconcile on reconnect.
- **One design, three clients** — a shared "Ink & Paper" design system with light/dark
  mode across web, desktop (Tauri), and mobile (Expo/React Native).
- **AI Assist** — an in-editor panel (Continue / Summarize / Ideas / Improve / Ask) that
  only appears when *your* server has an AI backend configured. Suggestions insert into
  the doc and sync like any other edit.
- **Page tree** — nested pages, rename, archive, search.
- **Sharing** — public read/write share links via short-lived room tokens.
- **Self-hostable everywhere** — nothing is hardcoded: native apps ask which instance to
  connect to on first launch; the browser client uses whatever origin serves it.
- **Obsidian import** — bring a Markdown vault in.

## Screenshots

| First-launch onboarding | Documents | Dark mode |
|---|---|---|
| ![Onboarding](docs/screenshots/mobile-onboarding.png) | ![Documents](docs/screenshots/mobile-app.png) | ![Dark mode](docs/screenshots/mobile-dark.png) |

> Shots are from the mobile client; the web and desktop clients share the same UI and
> design system. (Add web/desktop captures under `docs/screenshots/` too.)

## Architecture

Two small Rust services over Postgres, and a shared TypeScript client core:

- **`server/api`** (axum + sqlx) — control plane: auth, workspaces, the page tree,
  permissions, room-token issuance, optional AI endpoints.
- **`server/sync`** (yrs) — a WebSocket hub speaking the Yjs sync protocol
  (wire-compatible with stock `y-websocket`); persists updates to Postgres and compacts
  snapshots so documents survive restarts.
- **`packages/core`** — framework-free Yjs + sync + pluggable persistence, shared by all
  clients (IndexedDB on web, SQLite on mobile).
- **`packages/editor`** — the shared BlockNote collaborative editor.

```
apps/web/          React + Vite web client (also the desktop frontend)
apps/desktop/      Tauri 2 native shell (bundles apps/web)
apps/mobile/       Expo / React Native app (WebView editor + SQLite)
packages/core/     @selfnote/core — Yjs + sync + persistence (framework-free)
packages/editor/   @selfnote/editor — BlockNote collaborative editor
server/api/        Rust control-plane API (auth, workspaces, docs, room tokens, AI)
server/sync/       Rust WebSocket sync server (yrs) + Postgres persistence
server/migrations/ SQL migrations
deploy/helm/       Helm chart (services + Ingress + CloudNativePG + MinIO)
operator/          Go operator: Selfnote CRD + reconciler
tools/smoketest/   automated end-to-end sync/merge/persistence tests
```

## Prerequisites

- **Rust** (stable) + Cargo
- **Node 22+** and **pnpm 11+** (`corepack enable`)
- **Docker** (for the dev Postgres + MinIO)
- Mobile: the **Expo** toolchain + Android Studio / Xcode. Desktop: the **Tauri**
  prerequisites (Rust + platform webview; `cargo install tauri-cli`).

## Quick start (development)

```bash
# 1. Install JS deps
pnpm install

# 2. Start Postgres + MinIO
docker compose -f docker-compose.dev.yml up -d

# 3. API server (terminal 1) — runs migrations on boot, listens on :4445
cargo run -p selfnote-api

# 4. Sync server (terminal 2) — listens on ws://0.0.0.0:4444/ws/:doc
DATABASE_URL=postgres://selfnote:selfnote@localhost:5432/selfnote \
  ROOM_SECRET=dev-room-secret SYNC_REQUIRE_AUTH=1 \
  cargo run -p selfnote-sync

# 5. Web client (terminal 3) — http://localhost:5173
pnpm --filter @selfnote/web dev
```

Open the web app, register an account, and start editing. Open a second browser to see
live collaboration; use **Simulate offline**, type, then reconnect to watch edits merge.

## Building & running the clients

### Web

```bash
pnpm --filter @selfnote/web build     # → apps/web/dist (static SPA)
```

The browser client resolves its server from the **page origin** (`/api` for HTTP,
`wss://<host>/ws` for sync) — so the same build works on any domain with nothing baked in,
as long as your reverse proxy routes `/api` and `/ws` to the two services (see
`apps/web/nginx.conf` for the reference proxy).

### Desktop (Tauri)

```bash
cargo install tauri-cli --version "^2"      # once
cd apps/desktop && cargo tauri build        # native app + installer under src-tauri/target/release/bundle
# dev with hot reload:
cd apps/desktop && cargo tauri dev
```

The desktop app bundles the web frontend. On first launch it asks which Selfnote
**instance** to connect to (it has no serving origin of its own). Release bundles are
unsigned unless you provide signing keys.

### Mobile (Expo / React Native)

A standalone Expo project (its own `node_modules`, not part of the pnpm workspace).

```bash
cd apps/mobile
npm install
npm run typecheck
npm run android         # or: npm run ios   (needs Android Studio / Xcode)
```

On first launch the app asks for your **server address** (e.g. `notes.example.com`); it
derives `/api` + `/ws`, verifies the server, and saves it — you can change it later in
Settings. Nothing is hardcoded in the shipped app.

## Self-hosting

The browser + native clients all talk to two services (`api` on 4445, `sync` on 4444)
plus Postgres; the web is served by an nginx that proxies `/api` and `/ws` to them (one
origin serves the whole app).

- **Helm** (Kubernetes) — `deploy/helm/selfnote` deploys api/sync/web, a WebSocket-aware
  Ingress, in-cluster MinIO, and a CloudNativePG Postgres cluster with WAL backups.
  Set your image registry, ingress host, and secrets in `values.yaml`
  (`jwtSecret` / `roomSecret` / MinIO creds — change the `change-me-*` placeholders).
- **Operator** — `operator/` provides a `Selfnote` CRD (`kubectl get sn`) whose reconciler
  owns the workloads and composes a Postgres cluster.
- **Backups** — `deploy/restore-drill.sh` verifies backup → restore into a fresh cluster.

## AI Assist (optional)

`/ai/status` + `/ai/complete` on the API expose an AI backend; the clients show the
**✦ Assist** panel only when a provider is available. Configure one via env on the API:

| Provider | Env |
|---|---|
| Local **Claude CLI** (uses your subscription; data stays on the box) | `claude` on `PATH` (or `SELFNOTE_AI_CMD`) + `CLAUDE_CODE_OAUTH_TOKEN` |
| **Anthropic API** | `ANTHROPIC_API_KEY` (+ optional `SELFNOTE_AI_MODEL`) |
| **Ollama** | `OLLAMA_HOST` |

See [`apps/mobile/docs/AI_DEPLOY.md`](apps/mobile/docs/AI_DEPLOY.md) for details.
`/ai/complete` enforces workspace membership for the referenced document.

## Testing

```bash
cargo test                 # Rust unit tests (protocol codec, etc.)
cargo clippy -- -D warnings
pnpm -r typecheck

# end-to-end: start the sync server first, then:
pnpm smoketest             # 2 clients — live propagation + offline-merge convergence
```

## License

See [`LICENSE`](LICENSE).
