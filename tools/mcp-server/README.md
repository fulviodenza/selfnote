# @selfnote/mcp

An [MCP](https://modelcontextprotocol.io) server that connects an external Claude —
in the **CLI**, **Desktop**, or **claude.ai** — to your self-hosted Selfnote instance.
Its headline use: in a chat that has nothing to do with Selfnote, tell Claude *"save
this conversation to my notes"* and it files a clean summary into a note and hands you
back the link.

## Tools

| Tool | What it does |
|---|---|
| `save_conversation` | Write a Markdown summary into Selfnote (a sub-page under a "Conversations" note by default, or under a note you name) and return its location. |
| `create_note` | Create a note, optionally nested, with an optional Markdown body. |
| `list_notes` | Search or list notes (id, title, link). |

Writes go through the same path as the app's importer: Markdown → BlockNote blocks →
a Yjs update on the `document-store` fragment → `POST /documents/:id/content`. So a
saved note opens and syncs exactly like one you wrote by hand.

## Configuration

| Env | Required | Meaning |
|---|---|---|
| `SELFNOTE_URL` | yes | Your instance origin, e.g. `https://notes.example.com` |
| `SELFNOTE_TOKEN` | yes | A personal access token (`snp_…`) — create one in the app under **Connections** |
| `SELFNOTE_API_URL` | no | Explicit API base (defaults to `${SELFNOTE_URL}/api`) |
| `MCP_HTTP_PORT` | no | Serve Streamable HTTP at `:PORT/mcp` instead of stdio (for claude.ai) |
| `MCP_HTTP_AUTH` | no | Require `Authorization: Bearer <value>` on the HTTP endpoint |

## Local (Claude CLI / Desktop)

```bash
npm install && npm run build

# Claude Code (CLI):
claude mcp add selfnote \
  --env SELFNOTE_URL=https://notes.example.com \
  --env SELFNOTE_TOKEN=snp_... \
  -- node /absolute/path/to/tools/mcp-server/dist/index.js
```

Or in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "selfnote": {
      "command": "node",
      "args": ["/absolute/path/to/tools/mcp-server/dist/index.js"],
      "env": { "SELFNOTE_URL": "https://notes.example.com", "SELFNOTE_TOKEN": "snp_..." }
    }
  }
}
```

## Remote (claude.ai custom connector)

Run it in HTTP mode behind TLS (e.g. your existing Cloudflare tunnel), then add it in
claude.ai → Settings → Connectors as a custom connector pointing at `https://…/mcp`.

```bash
MCP_HTTP_PORT=8080 \
MCP_HTTP_AUTH=$(openssl rand -hex 24) \
SELFNOTE_URL=https://notes.example.com \
SELFNOTE_TOKEN=snp_... \
node dist/index.js
```

The server holds your token, so **anyone who can reach `/mcp` acts as you** — always
set `MCP_HTTP_AUTH` and put it behind HTTPS. A container image is provided
(`Dockerfile`); see `docs/mcp.md` for the full remote deployment.

See [`docs/mcp.md`](../../docs/mcp.md) for the end-to-end guide, including the
`save-to-selfnote` Claude skill.
