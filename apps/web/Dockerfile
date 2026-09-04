# Build context is the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
# Sync WebSocket endpoint is baked into the SPA at build time.
ARG VITE_SYNC_URL=ws://localhost:4444/ws
ENV VITE_SYNC_URL=$VITE_SYNC_URL
COPY . .
RUN pnpm install --no-frozen-lockfile && pnpm --filter @selfnote/web build

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
