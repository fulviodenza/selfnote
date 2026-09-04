# Build context is the repo root: docker build -f server/sync/Dockerfile .
# Pin bookworm so build-time glibc matches the debian:bookworm-slim runtime
# (the rolling rust:1-slim tag moved to a newer glibc — same fix as the api image).
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p selfnote-sync

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/selfnote-sync /usr/local/bin/selfnote-sync
EXPOSE 4444
ENV SYNC_ADDR=0.0.0.0:4444
CMD ["selfnote-sync"]
