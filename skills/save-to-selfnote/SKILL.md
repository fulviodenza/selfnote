---
name: save-to-selfnote
description: Summarize the current conversation and save it into the user's self-hosted Selfnote via the selfnote MCP server, then tell them where it was filed. Use when the user asks to save, log, file, or "put this in my notes" for Selfnote — even from a chat about an unrelated topic.
---

# Save to Selfnote

You can file a summary of the current conversation into the user's self-hosted
Selfnote workspace using the **selfnote** MCP server. Use this when the user says
things like "save this to Selfnote", "add this to my notes", "log our conversation",
or "put a summary in my <name> note".

## Requirements

This skill needs the `selfnote` MCP server connected (tools: `save_conversation`,
`create_note`, `list_notes`). If those tools aren't available, tell the user to set up
the Selfnote MCP server (see the project's `docs/mcp.md`) and stop.

## How to save

1. **Write the summary yourself first.** Produce concise, well-structured Markdown that
   captures what was actually discussed — not a transcript. A good shape:
   - a one-line overview,
   - the key points or decisions as a short bullet list,
   - any open questions or next steps.
   Keep it faithful to the conversation; don't invent details.

2. **Pick where it goes.**
   - If the user named a specific note ("put it in my Japan trip note"), call
     `list_notes` with that text, find the best match, and pass its `id` as `note_id`.
   - Otherwise omit `note_id` — it will be filed as a sub-page under a "Conversations"
     note, which is the sensible default.

3. **Call `save_conversation`** with your Markdown `summary` (and an optional `title`
   and/or `note_id`).

4. **Report the location back to the user** — quote the note title and the returned
   link so they can open it. For example: *"Saved to your Conversations as 'Trip
   planning — 2026-09-04': <link>."*

## Notes

- Only save when the user asks. Don't file conversations automatically.
- If the user wants a brand-new standalone note rather than a conversation summary,
  use `create_note` instead.
- One save per request unless the user asks for more.
