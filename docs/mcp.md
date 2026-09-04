# Connecting Claude to Selfnote (MCP)

The Selfnote **MCP server** lets Claude — running anywhere, in a chat that has nothing
to do with Selfnote — file a summary of your conversation into your notes and hand you
back the link. You ask *"save this to my notes"*; Claude writes a clean summary and
drops it into a note that then syncs to every client like anything else you wrote.

It works two ways:

- **Local** — a small process you run next to Claude CLI or Claude Desktop (stdio).
- **Remote** — an HTTP endpoint you expose so **claude.ai** can reach it as a custom connector.

Both use the same building blocks: a **personal access token** and the
[`@selfnote/mcp`](../tools/mcp-server) server.

---

## 1. Create a personal access token

In the Selfnote web app: **Connections** (sidebar) → name a token → **Generate**. Copy
the `snp_…` value; it's shown once. Treat it like a password — it can read and write
your notes. Revoke it any time from the same screen.

## 2. Build the server

```bash
cd tools/mcp-server
npm install && npm run build
```

## 3a. Local — Claude CLI / Desktop

Claude Code (CLI):

```bash
claude mcp add selfnote \
  --env SELFNOTE_URL=https://notes.example.com \
  --env SELFNOTE_TOKEN=snp_... \
  -- node "$(pwd)/dist/index.js"
```

Claude Desktop — add to `claude_desktop_config.json`:

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

Restart Claude and confirm the `selfnote` tools appear.

## 3b. Remote — claude.ai custom connector

claude.ai can only reach a server over HTTPS, so run the server in HTTP mode behind TLS.
The easiest route on an existing Selfnote cluster is your **Cloudflare tunnel**: publish
a hostname (e.g. `mcp.notes.example.com`) to the MCP service.

Run it (Docker image provided):

```bash
docker run -d --name selfnote-mcp -p 8080:8080 \
  -e MCP_HTTP_PORT=8080 \
  -e MCP_HTTP_AUTH=$(openssl rand -hex 24) \
  -e SELFNOTE_URL=https://notes.example.com \
  -e SELFNOTE_TOKEN=snp_... \
  ghcr.io/<owner>/selfnote-mcp:latest
```

Then in **claude.ai → Settings → Connectors → Add custom connector**, point it at
`https://mcp.notes.example.com/mcp` and provide the `MCP_HTTP_AUTH` value as the
connector's bearer token.

> Security: the server holds your token, so **anyone who can reach `/mcp` acts as you**.
> Always set `MCP_HTTP_AUTH` and keep the endpoint on HTTPS. One server instance = one
> user's token; run separate instances for separate users.

## 4. Install the skill (optional but recommended)

The [`save-to-selfnote`](../skills/save-to-selfnote) skill teaches Claude the right
behavior: summarize the conversation well, pick the right note, save it, and report the
location. Install it where your Claude looks for skills — e.g. copy the folder into
`~/.claude/skills/` for Claude Code, or your project's `.claude/skills/`.

## 5. Use it

In any Claude chat with the connector enabled:

> "Save this conversation to my Selfnote."

Claude writes a Markdown summary, calls `save_conversation`, and replies with where it
landed — e.g. *"Saved to your Conversations as 'Trip planning — 2026-09-04': <link>."*
Open the link and the note is there, live and synced.

To target a specific note: *"Add a summary of this to my 'Japan trip' note."* Claude
finds it with `list_notes` and files the summary as a sub-page under it.

## Editing existing notes

Beyond creating notes, Claude can read and edit an existing note in place:

- `read_note` — return a note's current body as Markdown.
- `append_to_note` — add Markdown to the end of a note, keeping its existing content.
- `update_note` — replace a note's whole body (read it first, edit, write it back).

These are true in-place edits: the server returns the note's current CRDT state
(`GET /documents/:id/content`), the MCP reconstructs the Yjs doc, mutates the
`document-store` fragment with `y-prosemirror`'s `updateYFragment`, and sends the
resulting **incremental diff** back via `POST /documents/:id/content`. So an edit
merges cleanly and syncs live to open editors, exactly like a human's keystrokes —
no duplicated content.

This makes a "living document" workflow work: keep a note, and say *"add X to my
Feature Summary note"* — Claude finds it (`list_notes`), reads it, appends, and it
updates in place.

## How writes work

New notes are seeded via `POST /documents/:id/content` with a full BlockNote Yjs
update (the same path the Obsidian importer uses); edits to existing notes go through
the read-modify-write diff described above.
