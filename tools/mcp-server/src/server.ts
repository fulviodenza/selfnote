/**
 * The Selfnote MCP server definition — the tools an external Claude can call to
 * read and write notes in a self-hosted instance. The flagship tool is
 * `save_conversation`, which files a summary of the current chat as a note and
 * reports back where it landed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SelfnoteClient,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type Tri,
} from "./selfnote.js";
import { docToBlockOutline, docToMarkdown, markdownToUpdateBase64 } from "./edit.js";
import { createRequire } from "node:module";

// The version MCP reports is the package version, read at runtime rather than
// written out a second time: a hardcoded copy silently goes stale the first
// time someone bumps package.json alone. `../package.json` resolves to the
// package root from dist/ and from src/ alike, and a static import cannot be
// used because package.json sits outside the compiler's rootDir.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function isoDate(): string {
  // The MCP process is a normal Node runtime; a real clock is available here.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the workspace a tool call should act on. Every workspace-scoped tool
 * takes an optional id so a user with one workspace (the common case) never has
 * to name it, and a user with several is not stuck with whichever came first.
 */
async function resolveWorkspace(
  client: SelfnoteClient,
  workspaceId?: string,
): Promise<string> {
  return workspaceId ?? (await client.ensureWorkspace());
}

/**
 * Turn the flat `due_at` argument a model can express into the three-state field
 * the API wants: absent leaves the due date alone, the literal "none" clears it,
 * anything else is a timestamp. Models reliably emit a string or nothing, so
 * "none" is the clearing spelling rather than a separate boolean argument.
 */
function dueField(due?: string): Tri<string> {
  if (due === undefined) return undefined;
  if (due.trim().toLowerCase() === "none") return { clear: true };
  return { set: isoTimestamp(due, "due_at") };
}

/**
 * Normalize a date argument to the full RFC3339 timestamp the API deserializes.
 * Models routinely emit a bare "2026-09-24", which axum's Query extractor
 * rejects with an opaque "Failed to deserialize query string", so every date a
 * tool accepts goes through here rather than only the ones on the body.
 */
function isoTimestamp(value: string, field: string): string {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${field} "${value}" is not a date. Use an ISO timestamp such as 2026-09-24T09:00:00Z.`,
    );
  }
  return parsed.toISOString();
}

/** One task rendered for a model: the fields it can act on, and where to look. */
function taskRow(client: SelfnoteClient, t: Task) {
  return {
    task_id: t.id,
    title: t.title,
    page: t.doc_title,
    kind: t.block_id ? "block" : "page",
    status: t.status,
    priority: t.priority,
    due_at: t.due_at,
    ...(t.detached ? { detached: true } : {}),
    url: client.deepLink(t.doc_id),
  };
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export function buildServer(client: SelfnoteClient): McpServer {
  const server = new McpServer({ name: "selfnote", version });

  server.tool(
    "list_notes",
    "Search or list notes in the user's Selfnote workspace. With no query, lists recent notes. Returns each note's id, title, and a link that opens it.",
    {
      query: z.string().optional().describe("Optional search text to match note titles."),
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
    },
    async ({ query, workspace_id }) => {
      const workspaceId = await resolveWorkspace(client, workspace_id);
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
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
    },
    async ({ title, markdown, parent_note_id, workspace_id }) => {
      const workspaceId = await resolveWorkspace(client, workspace_id);
      if (parent_note_id) {
        // The API checks membership on the workspace but never that the parent
        // belongs to it, so a mismatched pair creates a page pointing out of its
        // own tree, which then renders at the top level of the wrong workspace.
        const parent = await client.getDocument(parent_note_id);
        if (parent.workspace_id !== workspaceId) {
          throw new Error(
            "That parent note is in a different workspace. Pass its workspace_id, or pick a parent from this one.",
          );
        }
      }
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
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
    },
    async ({ summary, title, note_id, workspace_id }) => {
      const workspaceId = await resolveWorkspace(client, workspace_id);
      const heading = title?.trim() || `Conversation summary ${isoDate()}`;

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
    "Read the current Markdown content of a note by id. Use this before updating a note so you can edit its existing content. Pass with_block_ids to get the note's blocks with their ids instead, which is how to find the block id that manage_task's create_block_task needs.",
    {
      note_id: z.string().describe("The id of the note to read."),
      with_block_ids: z
        .boolean()
        .optional()
        .describe(
          "Return each block as id, type and text instead of rendered Markdown. Use this to find a block id to anchor a task to.",
        ),
    },
    async ({ note_id, with_block_ids }) => {
      const updates = await client.getContent(note_id);
      if (with_block_ids) {
        const blocks = (await docToBlockOutline(updates)).filter((b) => b.text || b.type !== "paragraph");
        if (!blocks.length) return text("(this note is empty)");
        return json(blocks.map((b) => ({ block_id: b.id, type: b.type, text: b.text })));
      }
      const markdown = await docToMarkdown(updates);
      return text(markdown || "(this note is empty)");
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

  /* ============================ workspace, structure, tasks, labels === */

  server.tool(
    "list_workspaces",
    "List the workspaces this token can reach. Only needed when the user has more than one: every other tool defaults to the first workspace, so call this when the user names a workspace or when a tool reports the wrong one.",
    {},
    async () => {
      const workspaces = await client.listWorkspaces();
      return json(workspaces.map((w) => ({ workspace_id: w.id, name: w.name })));
    },
  );

  server.tool(
    "organize_note",
    "Move, rename, re-icon, archive or trash a note. This applies immediately, unlike body edits, because every one of these is undone in a single gesture in the app. Moving defaults to placing the note last among its new siblings. Trashing is reversible (the note goes to the trash shelf); there is no permanent delete here on purpose.",
    {
      note_id: z.string().describe("The id of the note to change."),
      action: z
        .enum(["move", "rename", "set_icon", "archive", "unarchive", "trash", "untrash"])
        .describe("What to do to the note."),
      parent_note_id: z
        .string()
        .optional()
        .describe(
          'For action "move": the id of the note to move this under. Pass "root" to move it to the top level.',
        ),
      title: z.string().optional().describe('For action "rename": the new title.'),
      icon: z.string().optional().describe('For action "set_icon": an emoji to show beside the title.'),
    },
    async ({ note_id, action, parent_note_id, title, icon }) => {
      switch (action) {
        case "move": {
          if (!parent_note_id) {
            throw new Error('move needs parent_note_id (an id, or "root" for the top level).');
          }
          const doc = await client.getDocument(note_id);
          const target = parent_note_id.trim();
          const toRoot = target.toLowerCase() === "root";
          const newParent = toRoot ? null : target;
          if (newParent === note_id) throw new Error("A note cannot be moved under itself.");
          // Position and parent go in one write, so the note is never briefly
          // under its new parent at a sort key left over from the old one.
          const position = await client.positionAtEnd(doc.workspace_id, newParent, note_id);
          const moved = await client.updateDocument(note_id, {
            parentId: toRoot ? { clear: true } : { set: target },
            position,
          });
          const where = toRoot ? "the top level" : `"${(await client.getDocument(target)).title}"`;
          return text(`Moved "${moved.title}" to ${where}.\nLocation: ${client.deepLink(moved.id)}`);
        }
        case "rename": {
          if (!title?.trim()) throw new Error("rename needs a title.");
          const doc = await client.updateDocument(note_id, { title });
          return text(`Renamed to "${doc.title}".\nLocation: ${client.deepLink(doc.id)}`);
        }
        case "set_icon": {
          if (!icon?.trim()) throw new Error("set_icon needs an icon.");
          const doc = await client.updateDocument(note_id, { icon });
          return text(`Set the icon on "${doc.title}".`);
        }
        case "archive":
        case "unarchive": {
          const doc = await client.updateDocument(note_id, { archived: action === "archive" });
          return text(`${action === "archive" ? "Archived" : "Unarchived"} "${doc.title}".`);
        }
        case "trash":
        case "untrash": {
          const doc = await client.updateDocument(note_id, { trashed: action === "trash" });
          if (action === "trash") {
            return text(`Moved "${doc.title}" to the trash. It is recoverable from the trash shelf.`);
          }
          // Restoring does not always put the page back where it was: the server
          // detaches it to the top level when its old parent is still shelved,
          // and a page trashed while archived returns to the archive.
          const shelf = doc.archived ? "the archive" : "the notes list";
          const place = doc.parent_id ? "under its parent" : "at the top level";
          return text(`Restored "${doc.title}" to ${shelf}, ${place}.`);
        }
      }
    },
  );

  server.tool(
    "manage_task",
    "Create or change a task. A note can itself be a task (action create_page_task), or a single block inside a note can be one (action create_block_task, which needs the block id from read_note). Applies immediately. Use list_tasks or read_note first to get a task_id for update and delete.",
    {
      action: z
        .enum(["create_page_task", "create_block_task", "update", "delete", "list_on_note"])
        .describe("What to do."),
      note_id: z
        .string()
        .optional()
        .describe("The note: required for create_page_task, create_block_task and list_on_note."),
      task_id: z.string().optional().describe("The task: required for update and delete."),
      block_id: z
        .string()
        .optional()
        .describe(
          "For create_block_task: the id of the block inside the note this task anchors to. Read the note first to find it; it cannot be invented.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "For create_block_task: the block's text, cached so task lists need not open the note. Required for that action, since re-creating a task on the same block overwrites this cached title.",
        ),
      status: z.enum(TASK_STATUSES).optional().describe("Task status."),
      priority: z.enum(TASK_PRIORITIES).optional().describe("Task priority."),
      due_at: z
        .string()
        .optional()
        .describe('Due date as an ISO timestamp, or "none" to clear it. Omit to leave it unchanged.'),
      due_all_day: z.boolean().optional().describe("Whether the due date is a day rather than a time."),
    },
    async ({ action, note_id, task_id, block_id, title, status, priority, due_at, due_all_day }) => {
      const fields = { status, priority, dueAt: dueField(due_at), dueAllDay: due_all_day };
      switch (action) {
        case "create_page_task": {
          if (!note_id) throw new Error("create_page_task needs note_id.");
          const task = await client.setPageTask(note_id, fields);
          return text(
            `"${task.title}" is now a task (${task.status}${task.due_at ? `, due ${task.due_at}` : ""}).\n` +
              `Task id: ${task.id}\nLocation: ${client.deepLink(task.doc_id)}`,
          );
        }
        case "create_block_task": {
          if (!note_id || !block_id) throw new Error("create_block_task needs note_id and block_id.");
          // The server upserts on (doc_id, block_id) and refreshes the title from
          // the request, so a second call without one blanks the board card.
          if (!title?.trim()) {
            throw new Error(
              "create_block_task needs title, the block's text. Call read_note with with_block_ids to get both the id and the text.",
            );
          }
          const task = await client.createBlockTask(note_id, block_id, { ...fields, title });
          return text(
            `Made a task out of a block in "${task.doc_title}".\n` +
              `Task id: ${task.id}\nLocation: ${client.deepLink(task.doc_id)}`,
          );
        }
        case "update": {
          if (!task_id) throw new Error("update needs task_id.");
          const task = await client.updateTask(task_id, fields);
          return text(
            `Updated "${task.title}": ${task.status}, priority ${task.priority}` +
              `${task.due_at ? `, due ${task.due_at}` : ", no due date"}.\n` +
              `Location: ${client.deepLink(task.doc_id)}`,
          );
        }
        case "delete": {
          if (!task_id) throw new Error("delete needs task_id.");
          await client.deleteTask(task_id);
          return text("Deleted the task. The note and its text are untouched.");
        }
        case "list_on_note": {
          if (!note_id) throw new Error("list_on_note needs note_id.");
          const tasks = await client.listDocTasks(note_id);
          return json(tasks.map((t) => taskRow(client, t)));
        }
      }
    },
  );

  server.tool(
    "list_tasks",
    "List tasks across the workspace: the agenda. Filter by status, due window, the notes under one parent note, or labels. Use this to answer questions like what is overdue, what is due this week, or what is left on a project.",
    {
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
      status: z
        .array(z.enum(TASK_STATUSES))
        .optional()
        .describe("Keep only tasks in these states. Defaults to all."),
      due_before: z.string().optional().describe("ISO timestamp: only tasks due before this."),
      due_after: z.string().optional().describe("ISO timestamp: only tasks due after this."),
      include_undated: z
        .boolean()
        .optional()
        .describe(
          "Include tasks with no due date. Defaults to false when a due window is given, true otherwise.",
        ),
      under_note_id: z
        .string()
        .optional()
        .describe("Only tasks on this note and every note beneath it, which is how to scope to a project."),
      label_ids: z.array(z.string()).optional().describe("Only tasks on notes carrying any of these labels."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum tasks to return, 1 to 500. Defaults to 200."),
    },
    async (args) => {
      const workspaceId = await resolveWorkspace(client, args.workspace_id);
      const dueBefore = args.due_before ? isoTimestamp(args.due_before, "due_before") : undefined;
      const dueAfter = args.due_after ? isoTimestamp(args.due_after, "due_after") : undefined;
      // The API includes undated tasks by default, which turns "what is due this
      // week" into "this week, plus every undated task in the workspace". A due
      // window means the caller asked about dates, so undated tasks stay out
      // unless they say otherwise.
      const window = Boolean(dueBefore || dueAfter);
      const tasks = await client.listTasks({
        workspaceId,
        status: args.status,
        dueBefore,
        dueAfter,
        includeUndated: args.include_undated ?? (window ? false : undefined),
        docId: args.under_note_id,
        labelIds: args.label_ids,
        limit: args.limit,
      });
      if (!tasks.length) return text("No tasks match that.");
      return json(tasks.map((t) => taskRow(client, t)));
    },
  );

  server.tool(
    "manage_labels",
    "Read or change labels. add_to_note and remove_from_note edit a note's label set safely; set_on_note replaces it wholesale, so prefer the first two unless the user asked for exactly one set of labels.",
    {
      action: z
        .enum(["list", "create", "on_note", "add_to_note", "remove_from_note", "set_on_note"])
        .describe("What to do."),
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
      note_id: z.string().optional().describe("The note, for the note-scoped actions."),
      name: z.string().optional().describe("For create: the label name. Existing names are reused, not duplicated."),
      color: z.string().optional().describe("For create: an optional colour."),
      label_ids: z
        .array(z.string())
        .optional()
        .describe("Label ids for add_to_note, remove_from_note and set_on_note."),
    },
    async ({ action, workspace_id, note_id, name, color, label_ids }) => {
      switch (action) {
        case "list": {
          const workspaceId = await resolveWorkspace(client, workspace_id);
          const labels = await client.listLabels(workspaceId);
          return json(labels.map((l) => ({ label_id: l.id, name: l.name, color: l.color })));
        }
        case "create": {
          if (!name?.trim()) throw new Error("create needs a name.");
          const workspaceId = await resolveWorkspace(client, workspace_id);
          const label = await client.createLabel(workspaceId, name, color);
          return text(`Label "${label.name}" is ready.\nLabel id: ${label.id}`);
        }
        case "on_note": {
          if (!note_id) throw new Error("on_note needs note_id.");
          const labels = await client.docLabels(note_id);
          return json(labels.map((l) => ({ label_id: l.id, name: l.name })));
        }
        case "add_to_note":
        case "remove_from_note": {
          if (!note_id || !label_ids?.length) {
            throw new Error(`${action} needs note_id and label_ids.`);
          }
          // The API replaces a note's label set outright, so adding or removing
          // one label means sending the whole intended set back. Reading first
          // is what keeps the other labels on the note.
          const current = (await client.docLabels(note_id)).map((l) => l.id);
          const next =
            action === "add_to_note"
              ? Array.from(new Set([...current, ...label_ids]))
              : current.filter((id) => !label_ids.includes(id));
          const labels = await client.setDocLabels(note_id, next);
          return text(
            `Labels on the note: ${labels.map((l) => l.name).join(", ") || "(none)"}\n` +
              `Location: ${client.deepLink(note_id)}`,
          );
        }
        case "set_on_note": {
          // A full replace with no ids clears the note. Silently wiping a note's
          // labels because the array went missing is worse than an error, so the
          // caller has to pass one, even an empty one, to mean it.
          if (!note_id || label_ids === undefined) {
            throw new Error(
              "set_on_note needs note_id and label_ids. It replaces the note's labels outright, so pass an empty array to clear them, or use add_to_note to add one.",
            );
          }
          const labels = await client.setDocLabels(note_id, label_ids);
          return text(
            `Labels on the note are now: ${labels.map((l) => l.name).join(", ") || "(none)"}`,
          );
        }
      }
    },
  );

  server.tool(
    "search_notes",
    "Full text search across the workspace: note titles, note bodies, and labels. Use this when looking for content inside notes; list_notes only matches titles and is cheaper for browsing.",
    {
      query: z.string().describe("What to search for."),
      workspace_id: z.string().optional().describe("Defaults to the user's first workspace."),
    },
    async ({ query, workspace_id }) => {
      const workspaceId = await resolveWorkspace(client, workspace_id);
      const results = await client.search(workspaceId, query);
      return json({
        pages: results.pages.map((p) => ({ id: p.id, title: p.title, url: client.deepLink(p.id) })),
        labels: results.labels.map((l) => ({ label_id: l.id, name: l.name })),
        // The API marks matches with <mark>…</mark>; strip it, a model reads plain text.
        matches_in_body: results.texts.map((t) => ({
          id: t.id,
          title: t.title,
          snippet: t.snippet.replace(/<\/?mark>/g, ""),
          url: client.deepLink(t.id),
        })),
      });
    },
  );

  server.tool(
    "get_note_links",
    "The notes a note links out to, and the notes that link back to it. Use this to follow how the user's notes connect before summarizing or reorganizing them.",
    { note_id: z.string().describe("The id of the note.") },
    async ({ note_id }) => {
      const [outgoing, backlinks] = await Promise.all([
        client.outgoingLinks(note_id),
        client.backlinks(note_id),
      ]);
      return json({
        links_to: outgoing.map((l) => ({ id: l.target.id, title: l.target.title })),
        linked_from: backlinks.map((l) => ({ id: l.source.id, title: l.source.title })),
      });
    },
  );

  return server;
}
