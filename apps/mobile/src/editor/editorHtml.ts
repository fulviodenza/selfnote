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
    </style>
  </head>
  <body>
    <div id="root"></div>
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
      import { BlockNoteEditor } from "https://esm.sh/@blocknote/core@0.54.0?external=yjs";
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

      // Local doc changes -> RN (skip echoes of updates we applied from RN).
      doc.on("update", (update, origin) => {
        if (origin === "rn") return;
        send({ type: "update", update: toBase64(update) });
      });

      function handleFromRN(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "init") {
          // Mount the editor FIRST (on the empty doc), THEN apply the server's
          // state as a remote update. BlockNote's Yjs binding renders content
          // that arrives after mount; mounting onto an already-populated fragment
          // left the editor blank.
          if (!ready) { mountEditor(msg.user); ready = true; }
          if (msg.state) Y.applyUpdate(doc, fromBase64(msg.state), "rn");
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
          window.__editorMounted = true;
          const fb = document.getElementById("fallback");
          if (fb) fb.style.display = "none";
        } catch (e) {
          send({ type: "console", level: "error", text: "mountEditor failed: " + ((e && e.stack) || e) });
        }
      }

      send({ type: "ready" });
    </script>
  </body>
</html>`;
