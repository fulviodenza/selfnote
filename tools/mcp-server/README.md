# @selfnote/mcp

An [MCP](https://modelcontextprotocol.io) server that connects an external Claude,
in the **CLI**, **Desktop**, or **claude.ai**, to your self-hosted Selfnote instance.
Its headline use: in a chat that has nothing to do with Selfnote, tell Claude *"save
this conversation to my notes"* and it files a clean summary into a note and hands you
back the link.

## Tools

### Notes

| Tool | What it does |
|---|---|
| `save_conversation` | Write a Markdown summary into Selfnote (a sub-page under a "Conversations" note by default, or under a note you name) and return its location. |
| `create_note` | Create a note, optionally nested, with an optional Markdown body. |
| `list_notes` | Search or list notes by title (id, title, link). |
| `search_notes` | Full text search over titles, note bodies and labels. |
| `read_note` | Return a note's current body as Markdown. |
| `append_to_note` | Propose adding Markdown to the end of a note. Staged for review, see below. |
| `update_note` | Propose replacing a note's whole body. Staged for review, see below. |
| `get_note_links` | The notes a note links to, and the notes linking back to it. |

### Structure and tasks

| Tool | What it does |
|---|---|
| `organize_note` | Move, rename, re-icon, archive, unarchive, trash or untrash a note. |
| `manage_task` | Make a note into a task, make a block inside a note into a task, update one, delete one, or list a note's tasks. |
| `list_tasks` | The agenda: filter by status, due window, labels, or a note and everything beneath it. |
| `manage_labels` | List and create labels, and read, add, remove or replace a note's labels. |
| `list_workspaces` | List reachable workspaces. Only needed if you have more than one. |

Every workspace-scoped tool takes an optional `workspace_id` and defaults to your
first workspace, so a single-workspace setup never has to name one.

## What an agent may change on its own

Note **content** is never rewritten silently. `append_to_note` and `update_note`
stage a pending proposal that you review in the app with a before/after diff and
accept or reject. The API enforces this rather than trusting the client: a
personal access token may propose an edit but cannot approve one, so an agent
cannot accept its own work.

**Structure** applies immediately: moves, renames, icons, archiving, trashing,
tasks and labels. Each is undone in one gesture in the app, and routing them
through a review queue would defeat the point of asking an agent to tidy a
workspace. Trashing is reversible, the note lands on the trash shelf.

Permanent deletion, version history restores, share links and workspace
membership are deliberately **not** exposed. They are irreversible or they
publish, and none of them is needed to organize notes.

New notes are seeded with a Yjs update on the `document-store` fragment via
`POST /documents/:id/content` (same path as the app's importer). Edits to existing
notes read the current state (`GET …/content`), mutate the Yjs doc, and send back an
**incremental diff**, so a note opens, edits, and syncs exactly like one you wrote by
hand, with no duplicated content.

## Configuration

| Env | Required | Meaning |
|---|---|---|
| `SELFNOTE_URL` | yes | Your instance origin, e.g. `https://notes.example.com` |
| `SELFNOTE_TOKEN` | yes | A personal access token (`snp_…`), created in the app under **Connections** |
| `SELFNOTE_API_URL` | no | Explicit API base (defaults to `${SELFNOTE_URL}/api`) |
| `MCP_HTTP_PORT` | no | Serve Streamable HTTP at `:PORT/mcp` instead of stdio (for claude.ai) |
| `MCP_HTTP_AUTH` | no | Require `Authorization: Bearer <value>` on the HTTP endpoint |

## Local (Claude CLI / Desktop)

Requires Node 18 or newer. Nothing to clone or build: `npx` fetches the published
package.

```bash
# Claude Code (CLI):
claude mcp add selfnote \
  --env SELFNOTE_URL=https://notes.example.com \
  --env SELFNOTE_TOKEN=snp_... \
  -- npx -y @selfnote/mcp
```

Or in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "selfnote": {
      "command": "npx",
      "args": ["-y", "@selfnote/mcp"],
      "env": { "SELFNOTE_URL": "https://notes.example.com", "SELFNOTE_TOKEN": "snp_..." }
    }
  }
}
```

### From a clone

Working on the server itself, point Claude at your own build instead:

```bash
npm install && npm run build

claude mcp add selfnote \
  --env SELFNOTE_URL=https://notes.example.com \
  --env SELFNOTE_TOKEN=snp_... \
  -- node /absolute/path/to/tools/mcp-server/dist/index.js
```

## Remote (claude.ai custom connector)

Run it in HTTP mode behind TLS (e.g. your existing Cloudflare tunnel), then add it in
claude.ai → Settings → Connectors as a custom connector pointing at `https://…/mcp`.

```bash
MCP_HTTP_PORT=8080 \
MCP_HTTP_AUTH=$(openssl rand -hex 24) \
SELFNOTE_URL=https://notes.example.com \
SELFNOTE_TOKEN=snp_... \
npx -y @selfnote/mcp
```

From a clone, swap the last line for `node dist/index.js` after building.

The server holds your token, so **anyone who can reach `/mcp` acts as you**. Always
set `MCP_HTTP_AUTH` and put it behind HTTPS. A container image is provided
(`Dockerfile`); see `docs/mcp.md` for the full remote deployment.

See [`docs/mcp.md`](../../docs/mcp.md) for the end-to-end guide, including the
`save-to-selfnote` Claude skill.

## License

AGPL-3.0-or-later. See [`LICENSE`](./LICENSE).
