/**
 * The Selfnote MCP server definition — the tools an external Claude can call to
 * read and write notes in a self-hosted instance. The flagship tool is
 * `save_conversation`, which files a summary of the current chat as a note and
 * reports back where it landed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SelfnoteClient } from "./selfnote.js";
import { docToMarkdown, markdownToUpdateBase64 } from "./edit.js";

function isoDate(): string {
  // The MCP process is a normal Node runtime; a real clock is available here.
  return new Date().toISOString().slice(0, 10);
}

export function buildServer(client: SelfnoteClient): McpServer {
  const server = new McpServer({ name: "selfnote", version: "0.1.0" });

  server.tool(
    "list_notes",
    "Search or list notes in the user's Selfnote workspace. With no query, lists recent notes. Returns each note's id, title, and a link that opens it.",
    { query: z.string().optional().describe("Optional search text to match note titles.") },
    async ({ query }) => {
      const workspaceId = await client.ensureWorkspace();
      const docs = query
        ? await client.searchDocuments(workspaceId, query)
        : await client.listDocuments(workspaceId);
      const rows = docs.slice(0, 50).map((d) => ({
        id: d.id,
        title: d.title,
        url: client.deepLink(d.id),
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    "create_note",
    "Create a new note in Selfnote, optionally nested under an existing note, with optional Markdown body. Returns the new note's location.",
    {
      title: z.string().describe("Title for the new note."),
      markdown: z.string().optional().describe("Optional note body as Markdown."),
      parent_note_id: z
        .string()
        .optional()
        .describe("Optional id of an existing note to nest this under."),
    },
    async ({ title, markdown, parent_note_id }) => {
      const workspaceId = await client.ensureWorkspace();
      const doc = await client.createDocument(workspaceId, parent_note_id ?? null, title);
      if (markdown && markdown.trim()) {
        await client.setContent(doc.id, await markdownToUpdateBase64(markdown));
      }
      return {
        content: [
          {
            type: "text",
            text: `Created note "${doc.title}".\nLocation: ${client.deepLink(doc.id)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "save_conversation",
    "Save a summary of the current conversation into the user's Selfnote as a note, and return where it was filed. Write the summary yourself as clear Markdown before calling this. By default it is filed as a sub-page under a 'Conversations' note; pass note_id to file it under a specific note instead.",
    {
      summary: z.string().describe("The conversation summary, written as Markdown."),
      title: z
        .string()
        .optional()
        .describe("Optional note title; defaults to a dated title."),
      note_id: z
        .string()
        .optional()
        .describe("Optional id of an existing note to file this summary under as a sub-page."),
    },
    async ({ summary, title, note_id }) => {
      const workspaceId = await client.ensureWorkspace();
      const heading = title?.trim() || `Conversation summary — ${isoDate()}`;

      let parentId = note_id ?? null;
      let parentLabel = "the top level";
      if (!parentId) {
        const conversations = await client.findOrCreateNote(workspaceId, "Conversations");
        parentId = conversations.id;
        parentLabel = '"Conversations"';
      }

      const doc = await client.createDocument(workspaceId, parentId, heading);
      const body = `# ${heading}\n\n${summary.trim()}\n`;
      await client.setContent(doc.id, await markdownToUpdateBase64(body));

      return {
        content: [
          {
            type: "text",
            text:
              `Saved the summary to Selfnote under ${parentLabel}.\n` +
              `Note: ${heading}\n` +
              `Location: ${client.deepLink(doc.id)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "read_note",
    "Read the current Markdown content of a note by id. Use this before updating a note so you can edit its existing content.",
    { note_id: z.string().describe("The id of the note to read.") },
    async ({ note_id }) => {
      const updates = await client.getContent(note_id);
      const markdown = await docToMarkdown(updates);
      return { content: [{ type: "text", text: markdown || "(this note is empty)" }] };
    },
  );

  server.tool(
    "append_to_note",
    "Propose appending Markdown to the end of an existing note's body. The edit is NOT applied immediately: it is staged as a pending proposal that the note's owner reviews (with a before/after diff) and accepts or rejects in the app. Returns the proposal id and the note's location.",
    {
      note_id: z.string().describe("The id of the note to append to."),
      markdown: z.string().describe("Markdown to add to the end of the note."),
    },
    async ({ note_id, markdown }) => {
      const proposal = await client.createProposal(note_id, "append", markdown, "Append to note");
      return {
        content: [
          {
            type: "text",
            text:
              `Staged an append as a pending edit for review — the note is unchanged until a human accepts it.\n` +
              `Proposal: ${proposal.id}\n` +
              `Location: ${client.deepLink(note_id)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_note",
    "Propose replacing a note's entire body with new Markdown. Use read_note first, edit the content, then pass the full new body here. The edit is NOT applied immediately: it is staged as a pending proposal that the note's owner reviews (with a before/after diff) and accepts or rejects in the app. Returns the proposal id and the note's location.",
    {
      note_id: z.string().describe("The id of the note to rewrite."),
      markdown: z.string().describe("The complete new Markdown body for the note."),
    },
    async ({ note_id, markdown }) => {
      const proposal = await client.createProposal(note_id, "replace", markdown, "Replace note body");
      return {
        content: [
          {
            type: "text",
            text:
              `Staged a full rewrite as a pending edit for review — the note is unchanged until a human accepts it.\n` +
              `Proposal: ${proposal.id}\n` +
              `Location: ${client.deepLink(note_id)}`,
          },
        ],
      };
    },
  );

  return server;
}
