# Working on Selfnote

## Development workflow (required for every feature or bugfix)

1. Analyze the problem first.
2. Check GitHub for an existing issue; if there is none, open one.
3. Write a short design/architecture for the change and post it as a comment on the issue.
4. Do the work on a branch. The PR description must reference the issue with "Closes #N"
   so the issue closes automatically on merge.
5. Before merging, launch an agent to review the changes (the code-review skill) and
   address its findings.
6. Merge the PR (merge commit, matching repo history). The issue closes with it.

## Style rules

- Never add "Co-Authored-By: Claude" trailers to commits.
- Never add "Generated with Claude Code" footers or session links to PR descriptions.
- No em dashes anywhere: user-facing copy, commits, PRs, issues, code comments.

## Repo facts

- Monorepo: pnpm + Turborepo (TS: apps/web, apps/mobile, apps/desktop, apps/website,
  packages/*, tools/mcp-server) and a Cargo workspace (server/api, server/sync, operator).
- Deploys go to the homelab k3s cluster (namespace selfnote) as linux/amd64 images pushed
  to registry.fulvio.dev/selfnote/*. The cluster is the source of truth for image tags
  (deploy/homelab/*.yaml are scrubbed examples); roll with kubectl set image.
- Do not roll selfnote-api while an AI bulk-label job is running (the job is in-memory);
  check for a claude process in the api pod first.
- The API runs sqlx migrations from server/migrations on boot.
- Typechecks: `pnpm typecheck` in apps/web and packages/editor, `npx tsc --noEmit` in
  apps/mobile and tools/mcp-server, `cargo build -p selfnote-api` for the server.
