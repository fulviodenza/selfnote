/**
 * HTML document hosted inside the WebView. It runs BlockNote bound to a local Yjs
 * doc and bridges binary CRDT updates to/from the React Native side over
 * `postMessage`. Because both sides speak Yjs updates, the bridge is lossless and
 * the RN side stays the authoritative doc (synced to the server + SQLite).
 *
 * NOTE: for production/offline this should be a locally-bundled asset instead of
 * importing from a CDN. Kept as an ESM/CDN document here so the bridge is readable
 * and self-contained; swap the imports for a bundled build (vite) when packaging.
 */
export const EDITOR_HTML = /* html */ `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <link rel="stylesheet" href="https://esm.sh/@blocknote/core@0.54.0/style.css" />
    <!--
      Force a SINGLE shared copy of the CRDT libs. Without this, esm.sh gives our
      direct yjs/lib0/y-protocols imports a different instance than the copies
      bundled inside @blocknote/core, so BlockNote's Yjs !== our Yjs → "Not same
      Y.Doc" and the editor renders blank. The import map pins one URL each (at the
      versions BlockNote 0.54 resolves), and \`?external=\` below makes BlockNote's
      bundled y-prosemirror import these same shared instances.
    -->
    <script type="importmap">
    { "imports": { "yjs": "https://esm.sh/yjs@13.6.32" } }
    </script>
    <style>
      html, body, #root { margin: 0; height: 100%; }
      body { font-family: -apple-system, system-ui, sans-serif; }
      #fallback {
        position: fixed; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 14px; padding: 24px;
        text-align: center; color: #606670; background: #fff;
      }
      #fallback button {
        min-height: 48px; padding: 12px 20px; font-size: 16px; font-weight: 600;
        border: 1px solid #E2E1DC; border-radius: 12px; background: #fff; color: #2B44C7;
      }
      /*
        Slash menu + link-note picker (mobile parity for docs/features/
        editor-slash-commands.md). Ink & Paper tokens, large tap targets.
      */
      #slash {
        position: absolute; z-index: 20; min-width: 220px; max-width: 320px;
        max-height: 280px; overflow-y: auto; background: #fff; color: #1B1D22;
        border: 1px solid #E2E1DC; border-radius: 12px; padding: 6px;
        box-shadow: 0 2px 12px rgba(20,22,28,0.14);
        -webkit-overflow-scrolling: touch;
      }
      #slash .item {
        display: flex; align-items: center; gap: 10px; width: 100%;
        min-height: 48px; padding: 8px 12px; border-radius: 8px; cursor: pointer;
        font-size: 16px; box-sizing: border-box;
      }
      #slash .item.active, #slash .item:active { background: #EAEDFB; }
      #slash .item .title { flex: 1; }
      #slash .item .sub { color: #9A9EA6; font-size: 13px; }
      #slash .group { padding: 8px 12px 4px; font-size: 13px; color: #9A9EA6; }
      #slash .empty { padding: 12px; color: #9A9EA6; font-size: 15px; }
      /* Link-note picker as a bottom sheet, mirroring the RN Sheet. */
      #linkpick-scrim { position: fixed; inset: 0; z-index: 30; background: rgba(20,22,28,0.45); }
      #linkpick {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 31;
        background: #fff; color: #1B1D22; border-top-left-radius: 20px;
        border-top-right-radius: 20px; padding: 20px; padding-bottom: 32px;
        max-height: 70%; display: flex; flex-direction: column; gap: 12px;
        box-shadow: 0 2px 12px rgba(20,22,28,0.14);
      }
      #linkpick .grabber { align-self: center; width: 40px; height: 4px; border-radius: 999px; background: #E2E1DC; margin-bottom: 4px; }
      #linkpick .head { font-family: Georgia, serif; font-size: 20px; font-weight: 600; }
      #linkpick input {
        min-height: 48px; border: 1px solid #E2E1DC; border-radius: 12px;
        padding: 8px 12px; font-size: 16px; color: #1B1D22; background: #fff;
        box-sizing: border-box; width: 100%;
      }
      #linkpick .list { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      #linkpick .lbl { font-size: 14px; font-weight: 500; color: #606670; margin: 4px 0; }
      #linkpick .row {
        display: flex; align-items: center; gap: 8px; min-height: 48px;
        padding: 8px; border-radius: 8px; cursor: pointer; font-size: 16px;
      }
      #linkpick .row:active { background: #EAEDFB; }
      #linkpick .row .ricon { width: 22px; text-align: center; }
      #linkpick .row .rtitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #linkpick .state { padding: 12px 4px; color: #9A9EA6; font-size: 15px; }
      /*
        Read-only version-history preview (docs/features/version-history.md §5).
        A full-cover overlay hosting a throwaway BlockNote editor bound to the
        checkpoint's state; it never touches the live doc/fragment underneath.
      */
      #preview {
        position: fixed; inset: 0; z-index: 40; background: #fff; overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      #preview-root { min-height: 100%; }
      /* Suppress editing affordances so the preview reads as read-only. */
      #preview .bn-side-menu, #preview [data-content-type] .bn-drag-handle { display: none !important; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <div id="preview" style="display:none"><div id="preview-root"></div></div>
    <div id="slash" style="display:none"></div>
    <div id="fallback"><span id="fbmsg">Loading editor…</span><button id="retry" style="display:none" onclick="location.reload()">Retry</button></div>
    <script>
      // Classic (non-module) script: if the module below fails to load its
      // esm.sh assets (offline / CDN hiccup), the module body never runs — so this
      // timeout swaps the overlay to a Retry prompt instead of a blank screen.
      window.__editorMounted = false;
      setTimeout(function () {
        if (window.__editorMounted) return;
        var msg = document.getElementById("fbmsg");
        var btn = document.getElementById("retry");
        if (msg) msg.textContent = "Couldn't load the editor. Check your connection.";
        if (btn) btn.style.display = "block";
      }, 12000);
    </script>
    <script type="module">
      import * as Y from "yjs";
      import { fromBase64, toBase64 } from "https://esm.sh/lib0@0.2.117/buffer";
      import {
        BlockNoteEditor,
        SuggestionMenu,
        getDefaultSlashMenuItems,
        filterSuggestionItems,
      } from "https://esm.sh/@blocknote/core@0.54.0?external=yjs";
      import { withCollaboration } from "https://esm.sh/@blocknote/core@0.54.0/yjs?external=yjs";
      import { Awareness } from "https://esm.sh/y-protocols@1.0.7/awareness?external=yjs";

      const RN = window.ReactNativeWebView;
      const send = (o) => RN && RN.postMessage(JSON.stringify(o));

      // Forward the WebView's console + uncaught errors to the RN side, which
      // logs them — the WebView's JS console is otherwise invisible in release.
      ["log", "warn", "error"].forEach((level) => {
        const orig = console[level] && console[level].bind(console);
        console[level] = (...args) => {
          try { send({ type: "console", level, text: args.map((a) => (a && a.stack) || String(a)).join(" ") }); } catch {}
          if (orig) orig(...args);
        };
      });
      window.addEventListener("error", (e) => send({ type: "console", level: "error", text: "onerror: " + (e.message || e) + " @" + (e.filename || "") + ":" + (e.lineno || "") }));
      window.addEventListener("unhandledrejection", (e) => send({ type: "console", level: "error", text: "unhandledrejection: " + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)) }));

      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      let ready = false;
      let bnEditor = null; // the BlockNote instance, for AI getText/insert
      // Read-only version-history preview: a throwaway doc + editor mounted over
      // the live one, torn down on clear. Never mutates the live fragment.
      let previewEditor = null;

      // Slash-command config, sent by RN on init (docs/features/
      // editor-slash-commands.md §5). Network + auth live on the RN side, so the
      // WebView bridges link-note search and AI summarize over postMessage.
      let editable = true;      // hide insert commands in read-only mode
      let aiAvailable = false;  // gate /ai-summarize on GET /ai/status
      let aiFeatures = [];      // must include "summarize" for /ai-summarize to show
      let bridgeSeq = 0;        // request id for linkNoteQuery / aiSummarize
      // requestId -> resolver, for RN replies to WebView-initiated bridge calls.
      const bridgePending = new Map();

      // Local doc changes -> RN (skip echoes of updates we applied from RN).
      doc.on("update", (update, origin) => {
        if (origin === "rn") return;
        send({ type: "update", update: toBase64(update) });
      });

      // Backlinks (docs/features/backlinks-graph.md §5): whenever content
      // changes, re-scan the document for inline "selfnote:<id>" links and report
      // the full outgoing set to RN, which PUTs /documents/:id/links (debounced).
      // The scan runs on any update (local or remote) so the stored set converges.
      let linkScanTimer = null;
      doc.on("update", () => {
        if (linkScanTimer) clearTimeout(linkScanTimer);
        linkScanTimer = setTimeout(scanAndReportLinks, 1000);
      });

      const SELFNOTE_PREFIX = "selfnote:";

      // Walk BlockNote content collecting inline links with the selfnote: scheme.
      // One edge per target (last-seen anchor text wins as the label), matching
      // the server's dedupe. Returns [{ target_id, label }].
      function extractLinks() {
        const byTarget = new Map();
        if (!bnEditor) return [];
        const visitInline = (inline) => {
          if (!inline) return;
          if (Array.isArray(inline)) { inline.forEach(visitInline); return; }
          if (inline.type === "link" && typeof inline.href === "string" &&
              inline.href.indexOf(SELFNOTE_PREFIX) === 0) {
            const targetId = inline.href.slice(SELFNOTE_PREFIX.length);
            if (targetId) {
              let label = "";
              try {
                const c = inline.content;
                if (Array.isArray(c)) label = c.map((n) => (n && n.text) || "").join("");
                else if (c && c.text) label = c.text;
              } catch {}
              byTarget.set(targetId, label || null);
            }
          }
          // Recurse into nested content (link content is itself inline).
          if (inline.content) visitInline(inline.content);
        };
        const visitBlock = (block) => {
          if (!block) return;
          if (block.content) visitInline(block.content);
          if (Array.isArray(block.children)) block.children.forEach(visitBlock);
        };
        try { (bnEditor.document || []).forEach(visitBlock); } catch (e) {
          send({ type: "console", level: "error", text: "extractLinks failed: " + e });
        }
        const links = [];
        byTarget.forEach((label, target_id) => links.push({ target_id, label }));
        return links;
      }

      function scanAndReportLinks() {
        linkScanTimer = null;
        if (!ready || !bnEditor) return;
        send({ type: "linksChanged", links: extractLinks() });
      }

      function handleFromRN(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "init") {
          // Slash-command gating from RN (defaults keep the menu safe if absent).
          editable = msg.editable !== false;
          aiAvailable = !!msg.aiAvailable;
          aiFeatures = Array.isArray(msg.aiFeatures) ? msg.aiFeatures : [];
          // Mount the editor FIRST (on the empty doc), THEN apply the server's
          // state as a remote update. BlockNote's Yjs binding renders content
          // that arrives after mount; mounting onto an already-populated fragment
          // left the editor blank.
          if (!ready) { mountEditor(msg.user); ready = true; }
          if (msg.state) Y.applyUpdate(doc, fromBase64(msg.state), "rn");
        } else if (msg.type === "config") {
          // AI status resolves after the editor mounts, so RN re-sends the
          // slash-command gating; the next "/" reflects it (matches web props).
          editable = msg.editable !== false;
          aiAvailable = !!msg.aiAvailable;
          aiFeatures = Array.isArray(msg.aiFeatures) ? msg.aiFeatures : [];
        } else if (msg.type === "linkNoteResults" || msg.type === "aiSummarizeResult" || msg.type === "aiSummarizeError") {
          // A reply to a WebView-initiated bridge call (link search / summarize).
          const fn = bridgePending.get(msg.requestId);
          if (fn) { bridgePending.delete(msg.requestId); fn(msg); }
        } else if (msg.type === "update" && msg.update) {
          Y.applyUpdate(doc, fromBase64(msg.update), "rn");
        } else if (msg.type === "getText") {
          // Reply with the document as markdown, for AI context.
          const reqId = msg.reqId;
          (async () => {
            let text = "";
            try {
              if (bnEditor) text = await bnEditor.blocksToMarkdownLossy(bnEditor.document);
            } catch (e) {
              send({ type: "console", level: "error", text: "getText failed: " + e });
            }
            send({ type: "text", reqId, text });
          })();
        } else if (msg.type === "getSelection") {
          // Reply with the note's full markdown plus the currently-selected text
          // (if any), so a note-level AI action can default to selection scope.
          const reqId = msg.reqId;
          (async () => {
            let text = "";
            let selection = "";
            try {
              if (bnEditor) {
                text = await bnEditor.blocksToMarkdownLossy(bnEditor.document);
                try {
                  selection = bnEditor.getSelectedText ? bnEditor.getSelectedText() : "";
                } catch { selection = ""; }
              }
            } catch (e) {
              send({ type: "console", level: "error", text: "getSelection failed: " + e });
            }
            send({ type: "text", reqId, text, selection });
          })();
        } else if (msg.type === "replace") {
          // Replace the current selection (when present) or the whole document
          // with the AI result, parsed from markdown. Flows through Yjs.
          (async () => {
            try {
              if (!bnEditor) return;
              const blocks = await bnEditor.tryParseMarkdownToBlocks(msg.text || "");
              bnEditor.replaceBlocks(bnEditor.document, blocks);
            } catch (e) {
              send({ type: "console", level: "error", text: "replace failed: " + e });
            }
          })();
        } else if (msg.type === "renderMarkdown") {
          // Render an *other* doc's Yjs state to markdown headlessly, without
          // disturbing the mounted editor — used to resolve extra-context notes.
          // Mirrors getText's blocksToMarkdownLossy path on a throwaway doc.
          const reqId = msg.reqId;
          (async () => {
            let text = "";
            try {
              if (msg.state) {
                const tmp = new Y.Doc();
                Y.applyUpdate(tmp, fromBase64(msg.state));
                const ed = BlockNoteEditor.create(
                  withCollaboration({
                    collaboration: {
                      fragment: tmp.getXmlFragment("document-store"),
                      user: { name: "render", color: "#000000" },
                      provider: { awareness: new Awareness(tmp) },
                    },
                  }),
                );
                text = await ed.blocksToMarkdownLossy(ed.document);
              }
            } catch (e) {
              send({ type: "console", level: "error", text: "renderMarkdown failed: " + e });
            }
            send({ type: "text", reqId, text });
          })();
        } else if (msg.type === "preview") {
          // Render a version-history checkpoint read-only in an overlay. Apply the
          // base64 state into a fresh throwaway Y.Doc and mount a non-editable
          // BlockNote bound to its "document-store" fragment. The live doc below
          // is untouched, so editing continues underneath until Restore is pressed.
          (async () => {
            try {
              teardownPreview();
              const tmp = new Y.Doc();
              if (msg.state) Y.applyUpdate(tmp, fromBase64(msg.state));
              const ed = BlockNoteEditor.create(
                withCollaboration({
                  collaboration: {
                    fragment: tmp.getXmlFragment("document-store"),
                    user: { name: "preview", color: "#606670" },
                    provider: { awareness: new Awareness(tmp) },
                  },
                }),
              );
              try { ed.isEditable = false; } catch {}
              previewEditor = ed;
              const overlay = document.getElementById("preview");
              const host = document.getElementById("preview-root");
              if (host) { host.innerHTML = ""; ed.mount(host); }
              try { ed.isEditable = false; } catch {}
              if (overlay) overlay.style.display = "block";
            } catch (e) {
              send({ type: "console", level: "error", text: "preview failed: " + ((e && e.stack) || e) });
            }
          })();
        } else if (msg.type === "clearPreview") {
          teardownPreview();
        } else if (msg.type === "insert" && msg.text) {
          // Append an AI suggestion; it flows through Yjs to the server.
          (async () => {
            try {
              if (!bnEditor) return;
              const blocks = await bnEditor.tryParseMarkdownToBlocks(msg.text);
              const docBlocks = bnEditor.document;
              const ref = docBlocks[docBlocks.length - 1];
              if (ref) bnEditor.insertBlocks(blocks, ref, "after");
              else bnEditor.replaceBlocks(bnEditor.document, blocks);
            } catch (e) {
              send({ type: "console", level: "error", text: "insert failed: " + e });
            }
          })();
        }
      }

      // RN delivers messages on window (iOS) and document (Android).
      window.addEventListener("message", (e) => handleFromRN(e.data));
      document.addEventListener("message", (e) => handleFromRN(e.data));

      // Tear down the read-only version-history preview overlay + its throwaway
      // editor, revealing the live editor untouched underneath.
      function teardownPreview() {
        try { if (previewEditor) previewEditor.mount(undefined); } catch {}
        previewEditor = null;
        const overlay = document.getElementById("preview");
        const host = document.getElementById("preview-root");
        if (host) host.innerHTML = "";
        if (overlay) overlay.style.display = "none";
      }

      function mountEditor(user) {
        try {
          const editor = BlockNoteEditor.create(
            withCollaboration({
              collaboration: {
                fragment: doc.getXmlFragment("document-store"),
                user: user || { name: "Guest", color: "#2563eb" },
                provider: { awareness },
              },
            }),
          );
          bnEditor = editor;
          editor.mount(document.getElementById("root"));
          setupSlashMenu(editor);
          window.__editorMounted = true;
          const fb = document.getElementById("fallback");
          if (fb) fb.style.display = "none";
        } catch (e) {
          send({ type: "console", level: "error", text: "mountEditor failed: " + ((e && e.stack) || e) });
        }
      }

      /* ------------------------------------------------- Slash commands --- */
      // Mobile parity for docs/features/editor-slash-commands.md. We reuse
      // BlockNote's core suggestion-menu plugin (the same one web's React
      // SuggestionMenuController wraps) but render the menu with vanilla DOM,
      // since the WebView bundle has no React. Items: the default blocks plus
      // Table, Link note, and (gated) AI summarize.

      // Escape untrusted text before injecting it into innerHTML.
      function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
          { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
      }

      // Ask RN to run a network+auth call (link search or AI summarize) and
      // resolve with its reply. Mirrors the web network calls (§5).
      function bridge(type, payload) {
        const requestId = ++bridgeSeq;
        return new Promise((resolve) => {
          bridgePending.set(requestId, resolve);
          send(Object.assign({ type, requestId }, payload));
        });
      }

      // Insert an inline link to a note at the cursor: text = title, href =
      // the "selfnote:<id>" scheme (docs/features/backlinks-graph.md §4/§5).
      // Tapping it posts navigateToDoc back to RN; the link scan reports the
      // edge to the server via PUT /documents/:id/links.
      function insertNoteLink(id, title) {
        try {
          if (!bnEditor) return;
          bnEditor.insertInlineContent([
            { type: "link", href: SELFNOTE_PREFIX + id, content: title || "Untitled" },
            " ",
          ]);
          // Report immediately (don't wait for the debounce) so the edge lands.
          if (linkScanTimer) clearTimeout(linkScanTimer);
          linkScanTimer = setTimeout(scanAndReportLinks, 1000);
        } catch (e) {
          send({ type: "console", level: "error", text: "insertNoteLink failed: " + e });
        }
      }

      // Run /ai-summarize: extract the note as markdown, ask RN to POST
      // /ai/complete, then parse the summary markdown and insert it as block(s)
      // below the current block. On error insert nothing (RN surfaces a toast).
      async function runSummarize(block) {
        if (!bnEditor) return;
        let context = "";
        try { context = await bnEditor.blocksToMarkdownLossy(bnEditor.document); } catch {}
        const reply = await bridge("aiSummarize", { context });
        if (!reply || reply.type !== "aiSummarizeResult" || !reply.text) return;
        try {
          const blocks = await bnEditor.tryParseMarkdownToBlocks(reply.text);
          const ref = block || bnEditor.getTextCursorPosition().block;
          bnEditor.insertBlocks(blocks, ref, "after");
        } catch (e) {
          send({ type: "console", level: "error", text: "summarize insert failed: " + e });
        }
      }

      // Build the custom items, appended to the default slash items. Each item
      // is { title, aliases, group, onItemClick }. Gating matches web exactly.
      function customSlashItems(editor) {
        const items = [];
        // /table — pure client-side native table block, no network (§3.1).
        items.push({
          title: "Table",
          aliases: ["table", "grid"],
          group: "Blocks",
          onItemClick: () => {
            editor.insertBlocks(
              [{ type: "table", content: { type: "tableContent", rows: [
                { cells: ["", "", ""] },
                { cells: ["", "", ""] },
              ] } }],
              editor.getTextCursorPosition().block,
              "after",
            );
          },
        });
        // /link-note — opens the picker (§3.2).
        items.push({
          title: "Link note",
          aliases: ["link", "note", "mention"],
          group: "Blocks",
          onItemClick: () => openLinkPicker(),
        });
        // /ai-summarize — only when AI is available with the "summarize" feature.
        if (aiAvailable && aiFeatures.indexOf("summarize") !== -1) {
          items.push({
            title: "AI summarize",
            aliases: ["ai", "summary", "summarize"],
            group: "AI",
            onItemClick: () => {
              const block = editor.getTextCursorPosition().block;
              void runSummarize(block);
            },
          });
        }
        return items;
      }

      function getSlashItems(editor, query) {
        // In read-only mode, offer no insert commands at all.
        if (!editable) return [];
        // Drop the built-in "table" item so our custom Table (grouped "Blocks",
        // matching web) is the single table command — no duplicate entry.
        const defaults = getDefaultSlashMenuItems(editor).filter((it) => it.key !== "table");
        const all = defaults.concat(customSlashItems(editor));
        return filterSuggestionItems(all, query || "");
      }

      function setupSlashMenu(editor) {
        const ext = editor.getExtension(SuggestionMenu);
        if (!ext || !ext.store) {
          send({ type: "console", level: "error", text: "no suggestion menu extension" });
          return;
        }
        const el = document.getElementById("slash");
        let items = [];
        let activeIndex = 0;

        const close = () => {
          el.style.display = "none";
          el.innerHTML = "";
          items = [];
        };

        const choose = (i) => {
          const it = items[i];
          if (!it) return;
          // Match web's SuggestionMenuController: close, delete the "/query"
          // trigger text (clearQuery), then run the command.
          try { ext.closeMenu(); } catch {}
          try { ext.clearQuery(); } catch {}
          try { it.onItemClick(); } catch (e) {
            send({ type: "console", level: "error", text: "slash item failed: " + e });
          }
          close();
        };

        const render = (state) => {
          if (!state || !state.show || state.triggerCharacter !== "/") { close(); return; }
          items = getSlashItems(editor, state.query);
          activeIndex = 0;
          if (items.length === 0) {
            el.innerHTML = '<div class="empty">No matching commands.</div>';
          } else {
            let html = "";
            let lastGroup = null;
            items.forEach((it, i) => {
              if (it.group && it.group !== lastGroup) {
                html += '<div class="group">' + esc(it.group) + "</div>";
                lastGroup = it.group;
              }
              html += '<div class="item' + (i === 0 ? " active" : "") + '" data-i="' + i + '">' +
                '<span class="title">' + esc(it.title) + "</span>" +
                (it.subtext ? '<span class="sub">' + esc(it.subtext) + "</span>" : "") +
                "</div>";
            });
            el.innerHTML = html;
            el.querySelectorAll(".item").forEach((node) => {
              // pointerdown (not click) so the menu acts before the editor blurs.
              node.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                choose(parseInt(node.getAttribute("data-i"), 10));
              });
            });
          }
          // Position just below the caret's reference rect.
          const r = state.referencePos;
          el.style.display = "block";
          const top = Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8);
          let left = r.left;
          left = Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8));
          el.style.top = Math.max(8, top) + "px";
          el.style.left = left + "px";
        };

        ext.store.subscribe(({ currentVal }) => render(currentVal));
        render(ext.store.state);
      }

      /* --------------------------------------------- Link-note picker --- */
      // Bottom sheet (§5 touch adaptation). Empty query -> recents via RN's
      // api.listDocuments; typing -> RN's api.searchDocuments, debounced ~200ms.
      let linkDebounce = null;
      let linkSeq = 0; // guards against out-of-order search replies

      function closeLinkPicker() {
        const scrim = document.getElementById("linkpick-scrim");
        const sheet = document.getElementById("linkpick");
        if (scrim) scrim.remove();
        if (sheet) sheet.remove();
        if (linkDebounce) { clearTimeout(linkDebounce); linkDebounce = null; }
      }

      function renderLinkResults(listEl, docs, label) {
        if (!docs || docs.length === 0) {
          listEl.innerHTML = '<div class="state">No matching notes.</div>';
          return;
        }
        let html = '<div class="lbl">' + esc(label) + "</div>";
        docs.forEach((d) => {
          html += '<div class="row" data-id="' + esc(d.id) + '" data-title="' + esc(d.title || "") + '">' +
            '<span class="ricon">' + esc(d.icon || "📄") + "</span>" +
            '<span class="rtitle">' + esc(d.title || "Untitled") + "</span>" +
            "</div>";
        });
        listEl.innerHTML = html;
        listEl.querySelectorAll(".row").forEach((node) => {
          node.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            insertNoteLink(node.getAttribute("data-id"), node.getAttribute("data-title"));
            closeLinkPicker();
          });
        });
      }

      async function queryLinks(listEl, q) {
        const seq = ++linkSeq;
        listEl.innerHTML = '<div class="state">Searching…</div>';
        const reply = await bridge("linkNoteQuery", { q: q });
        if (seq !== linkSeq) return; // a newer query superseded this one
        if (!reply || reply.type !== "linkNoteResults") {
          listEl.innerHTML = '<div class="state">Couldn\\'t load notes.</div>';
          return;
        }
        renderLinkResults(listEl, reply.docs || [], q ? "Search" : "Recent");
      }

      function openLinkPicker() {
        if (!editable) return;
        closeLinkPicker();
        const scrim = document.createElement("div");
        scrim.id = "linkpick-scrim";
        scrim.addEventListener("pointerdown", (e) => { e.preventDefault(); closeLinkPicker(); });
        const sheet = document.createElement("div");
        sheet.id = "linkpick";
        sheet.innerHTML =
          '<div class="grabber"></div>' +
          '<div class="head">Link a note</div>' +
          '<input id="linkpick-q" placeholder="Search notes…" autocomplete="off" autocapitalize="none" autocorrect="off" />' +
          '<div class="list" id="linkpick-list"></div>';
        document.body.appendChild(scrim);
        document.body.appendChild(sheet);
        const input = document.getElementById("linkpick-q");
        const listEl = document.getElementById("linkpick-list");
        input.addEventListener("input", () => {
          if (linkDebounce) clearTimeout(linkDebounce);
          const q = input.value.trim();
          linkDebounce = setTimeout(() => { void queryLinks(listEl, q); }, 200);
        });
        input.focus();
        // Empty query on open -> recents.
        void queryLinks(listEl, "");
      }

      // Intercept taps on inserted note links: navigate in-app instead of the
      // WebView trying to follow the "selfnote:<id>" href (which the OS/shell
      // would otherwise try to open as an external scheme).
      document.addEventListener("click", (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href^="selfnote:"]') : null;
        if (a) {
          e.preventDefault();
          const id = a.getAttribute("href").slice(SELFNOTE_PREFIX.length);
          if (id) send({ type: "navigateToDoc", id });
        }
      }, true);

      send({ type: "ready" });
    </script>
  </body>
</html>`;
