# Selfnote MCP server — remote (Streamable HTTP) mode, for claude.ai connectors.
# Build context is this directory (tools/mcp-server).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Runs HTTP mode when MCP_HTTP_PORT is set; otherwise stdio (not useful in a container).
ENV MCP_HTTP_PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
