#!/usr/bin/env node
/**
 * Entry point. Runs the Selfnote MCP server over stdio (for Claude CLI / Claude
 * Desktop) by default, or over Streamable HTTP (for claude.ai remote connectors)
 * when MCP_HTTP_PORT is set.
 *
 * Required env:
 *   SELFNOTE_URL    your instance origin, e.g. https://notes.example.com
 *   SELFNOTE_TOKEN  a personal access token (snp_…) from Connections settings
 * Optional env:
 *   SELFNOTE_API_URL  explicit API base (defaults to `${SELFNOTE_URL}/api`)
 *   MCP_HTTP_PORT     run an HTTP endpoint at :PORT/mcp instead of stdio
 *   MCP_HTTP_AUTH     require `Authorization: Bearer <value>` on the HTTP endpoint
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { SelfnoteClient } from "./selfnote.js";
import { buildServer } from "./server.js";

const url = process.env.SELFNOTE_URL;
const token = process.env.SELFNOTE_TOKEN;
if (!url || !token) {
  console.error(
    "selfnote-mcp: set SELFNOTE_URL (e.g. https://notes.example.com) and SELFNOTE_TOKEN (an snp_… token).",
  );
  process.exit(1);
}

const client = new SelfnoteClient(url, token, process.env.SELFNOTE_API_URL);
const httpPort = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null;

async function startStdio(): Promise<void> {
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("selfnote-mcp: ready (stdio)");
}

function startHttp(port: number): void {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  const auth = process.env.MCP_HTTP_AUTH;

  // Stateless Streamable HTTP: build a fresh server + transport per request.
  app.post("/mcp", async (req, res) => {
    if (auth && req.headers.authorization !== `Bearer ${auth}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const server = buildServer(client);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("selfnote-mcp: request error", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.listen(port, () => console.error(`selfnote-mcp: ready (HTTP) on :${port}/mcp`));
}

if (httpPort) startHttp(httpPort);
else void startStdio();
