# Build context is the repo root: docker build -f server/api/Dockerfile .
# Uses sqlx runtime queries, so no live DB is needed at build time.
# Pin bookworm so the build-time glibc matches the debian:bookworm-slim runtime
# (the rolling rust:1-slim tag moved to a newer glibc and broke the runtime).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p selfnote-api

# Build the Node diff helper (`selfnote-edit-diff`) that AI-edit proposals and
# version-history checkpoints shell out to for the BlockNote/Yjs diff path — the
# same relationship the AI provider has with the `claude` CLI.
FROM node:22-slim AS diffhelper
WORKDIR /helper
COPY tools/mcp-server/package.json tools/mcp-server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tools/mcp-server/tsconfig.json ./
COPY tools/mcp-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim
# ca-certificates for outbound TLS; nodejs + the Claude Code CLI so the AI
# provider can run `claude -p` against a Claude subscription (auth via the
# CLAUDE_CODE_OAUTH_TOKEN env). Pushed directly to Harbor (not through the
# Cloudflare tunnel), so image size is not constrained.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates nodejs npm \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/selfnote-api /usr/local/bin/selfnote-api
# The BlockNote/Yjs diff helper: bundle its built code + prod deps and expose it
# on PATH as `selfnote-edit-diff` (proposals.rs / history.rs default command).
COPY --from=diffhelper /helper/dist /opt/selfnote-mcp/dist
COPY --from=diffhelper /helper/node_modules /opt/selfnote-mcp/node_modules
COPY --from=diffhelper /helper/package.json /opt/selfnote-mcp/package.json
RUN printf '#!/bin/sh\nexec node /opt/selfnote-mcp/dist/diff-cli.js "$@"\n' \
      > /usr/local/bin/selfnote-edit-diff \
    && chmod +x /usr/local/bin/selfnote-edit-diff
# Claude Code needs a writable HOME for its config/session state.
ENV HOME=/tmp API_ADDR=0.0.0.0:4445
EXPOSE 4445
CMD ["selfnote-api"]
