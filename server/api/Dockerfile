# Build context is the repo root: docker build -f server/api/Dockerfile .
# Uses sqlx runtime queries, so no live DB is needed at build time.
# Pin bookworm so the build-time glibc matches the debian:bookworm-slim runtime
# (the rolling rust:1-slim tag moved to a newer glibc and broke the runtime).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p selfnote-api

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
# Claude Code needs a writable HOME for its config/session state.
ENV HOME=/tmp API_ADDR=0.0.0.0:4445
EXPOSE 4445
CMD ["selfnote-api"]
