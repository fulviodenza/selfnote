/**
 * Bundle the reader into self-contained HTML documents, one per format.
 *
 * Separate pages on purpose: a PDF session should not hold epub.js in memory
 * and an EPUB session should not hold pdf.js, which is several times larger.
 * Everything is inlined, workers included, so neither page needs the network.
 * Each exports as a JS string, the only form a React Native WebView takes
 * directly and equally usable as an iframe srcdoc later on web.
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

async function bundle(entry) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["safari15"],
    minify: true,
    write: false,
    legalComments: "none",
  });
  // A literal "</script>" inside the bundle would end the tag early.
  return result.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");
}

/* Ink and Paper, read from packages/core/tokens.json at build time so the
   reader pages cannot drift from the apps. */
const TOKENS = JSON.parse(
  readFileSync(new URL("../core/tokens.json", import.meta.url), "utf8"),
);
const L = TOKENS.light;
const D = TOKENS.dark;
/** The accent at the given alpha, for highlight and selection fills. */
const accentAlpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const SHARED_CSS = `
  :root { --paper: ${L.paper}; --surface: ${L.surface}; --ink: ${L.ink}; --ink-soft: ${L.inkSoft};
    --accent: ${L.accent}; --accent-wash: ${L.accentWash}; --on-accent: ${L.onAccent}; --hairline: ${L.hairline};
    --highlight: ${accentAlpha(L.accent, 0.22)}; --selection: ${accentAlpha(L.accent, 0.28)};
    --shadow-floating: ${TOKENS.shadowFloating};
    --note-paper: var(--surface); --note-rule: var(--hairline);
    --margin-x: 7vw; --margin-y: 4.5vh; }
  html[data-theme="dark"] { --paper: ${D.paper}; --surface: ${D.surface}; --ink: ${D.ink};
    --ink-soft: ${D.inkSoft}; --accent: ${D.accent}; --accent-wash: ${D.accentWash}; --on-accent: ${D.onAccent};
    --hairline: ${D.hairline}; --highlight: ${accentAlpha(D.accent, 0.28)};
    --selection: ${accentAlpha(D.accent, 0.32)};
    /* Inserts keep the light sheet: web canvas ink is stored as a fixed dark
       colour and would vanish on a dark one. */
    --note-paper: ${L.surface}; --note-rule: ${L.hairline}; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; }
  body { -webkit-user-select: none; user-select: none; }
  /* The commit affordance for a selection: floats above everything and stays
     tappable no matter what the content does with events. */
  #save-highlight {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(26px + env(safe-area-inset-bottom));
    display: none; align-items: center;
    padding: 14px 28px; border: 0; border-radius: 999px;
    background: var(--accent); color: var(--on-accent);
    font: 600 16px -apple-system, system-ui, sans-serif;
    box-shadow: var(--shadow-floating);
    z-index: 10; cursor: pointer;
  }
  /* A highlight not yet in Selfnote: the same fill, outlined in dashes. */
  .selfnote-highlight-pending { stroke: var(--accent);
    stroke-width: 1.5px; stroke-dasharray: 4 3; }`;

function page(bodyHtml, extraCss, scripts) {
  return `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
<style>${SHARED_CSS}${extraCss}</style>
</head>
<body>
${bodyHtml}
<button id="save-highlight" type="button">Save highlight</button>
${scripts}
</body>
</html>`;
}

/* --------------------------------------------------------------- EPUB --- */
const epubJs = await bundle("src/webview/reader.ts");
const epubHtml = page(
  '<div id="viewer"></div>\n<div id="note"><div class="paper"></div></div>',
  `
  /* The page margin lives on <body> as padding, and #viewer fills body's
     CONTENT box. epub.js measures #viewer for column geometry and only gets it
     right when that element is a plain statically-positioned block whose box is
     exactly the page area; padding on it, wrapping it, or positioning it
     absolutely all make the render silently never complete. */
  body {
    box-sizing: border-box;
    padding:
      calc(var(--margin-y) + env(safe-area-inset-top))
      calc(var(--margin-x) + env(safe-area-inset-right))
      calc(var(--margin-y) + env(safe-area-inset-bottom))
      calc(var(--margin-x) + env(safe-area-inset-left));
  }
  #viewer { width: 100%; height: 100%; }
  #viewer iframe { -webkit-user-select: text; user-select: text; }
  /* An inserted blank page, laid over the book rather than in its place so
     #viewer keeps its box and epub.js its pagination. Fixed, so it takes no
     room in body's flow; the same margins as the book page. */
  #note { display: none; position: fixed; inset: 0; z-index: 5;
    box-sizing: border-box; background: var(--paper);
    padding:
      calc(var(--margin-y) + env(safe-area-inset-top))
      calc(var(--margin-x) + env(safe-area-inset-right))
      calc(var(--margin-y) + env(safe-area-inset-bottom))
      calc(var(--margin-x) + env(safe-area-inset-left)); }
  #note .paper { width: 100%; height: 100%; background: var(--note-paper);
    box-shadow: var(--shadow-floating);
    background-image: linear-gradient(to bottom,
      var(--note-rule) 1px, transparent 1px);
    background-size: 100% 2.2rem; }`,
  `<script>${epubJs}</script>`,
);

/* ---------------------------------------------------------------- PDF --- */
const pdfJs = await bundle("src/webview/pdf.ts");
// The worker ships inside the page: pdf.js parses on a real Worker where the
// platform allows one from a blob URL, and falls back to its main-thread fake
// worker from the same bytes where it does not. Either way, no network.
const workerSrc = readFileSync(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  "utf8",
).replace(/<\/script>/gi, "<\\/script>");
const pdfHtml = page(
  `<div id="scroll">
    <div id="page">
      <canvas id="canvas"></canvas>
      <div id="text" class="textLayer"></div>
      <div id="marks"></div>
    </div>
    <div id="note"><canvas id="notecanvas"></canvas><canvas id="livecanvas"></canvas></div>
  </div>`,
  `
  #scroll { position: absolute; inset: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding:
      calc(var(--margin-y) + env(safe-area-inset-top))
      calc(var(--margin-x) + env(safe-area-inset-right))
      calc(var(--margin-y) + env(safe-area-inset-bottom))
      calc(var(--margin-x) + env(safe-area-inset-left)); }
  #page { position: relative; margin: 0 auto;
    box-shadow: var(--shadow-floating); background: #fff; }
  #canvas { display: block; }
  /* pdf.js text layer. These rules are not decoration: TextLayer sets only the
     custom properties --font-height, --scale-x and --rotate on each span and
     relies on the stylesheet to turn them into a real font-size and transform.
     Without them every span lays out at the browser default 16px, unscaled, so
     the invisible text boxes are far wider than the glyphs painted on the
     canvas: selection and highlights then run past the right margin, and the
     native selection overshoots too because the boxes genuinely are that wide. */
  .textLayer { position: absolute; inset: 0; overflow: clip;
    line-height: 1; text-align: initial; text-size-adjust: none;
    forced-color-adjust: none; transform-origin: 0 0;
    -webkit-user-select: text; user-select: text; }
  .textLayer span, .textLayer br {
    position: absolute; white-space: pre; color: transparent;
    transform-origin: 0 0; cursor: text;
    font-size: calc(var(--font-height) * var(--scale-factor, 1));
    transform: scaleX(var(--scale-x, 1)) rotate(var(--rotate, 0deg)); }
  /* Marked-content wrappers carry no glyphs and must not occupy a box. */
  .textLayer span.markedContent { top: 0; height: 0; }
  .textLayer ::selection { background: var(--selection); }
  #marks { position: absolute; inset: 0; pointer-events: none; }
  #marks .mark { position: absolute; border-radius: 3px; box-sizing: border-box;
    pointer-events: auto; }
  #marks .mark.pending { border: 1.5px dashed var(--accent); }
  /* An inserted blank page. Same box as the book page so it reads as a leaf of
     the same volume, with a faint rule so it is obviously writing paper and
     not a failed render. */
  #note { display: none; position: relative; margin: 0 auto;
    background: var(--note-paper); box-shadow: var(--shadow-floating);
    background-image: linear-gradient(to bottom,
      var(--note-rule) 1px, transparent 1px);
    background-size: 100% 2.2rem; }
  /* touch-action none, or the browser claims the gesture for scrolling and the
     stroke arrives in pieces. */
  #notecanvas { display: block; touch-action: none;
    -webkit-user-select: none; user-select: none; }
  /* The in-progress stroke lives on an overlay repainted per frame. It must
     not swallow the pointer: input stays on the canvas underneath. */
  #livecanvas { position: absolute; inset: 0; pointer-events: none; }`,
  `<script>window.__PDFJS_WORKER_SRC__=${JSON.stringify(workerSrc)};</script>
<script>${pdfJs}</script>`,
);

const out =
  `// Generated by build.mjs. Do not edit.\n` +
  `export const readerHtml = ${JSON.stringify(epubHtml)};\n` +
  `export const pdfReaderHtml = ${JSON.stringify(pdfHtml)};\n`;
writeFileSync(join(dist, "index.js"), out);
writeFileSync(
  join(dist, "index.d.ts"),
  `/** Self-contained EPUB reader document: epub.js and the bridge, no network. */
export declare const readerHtml: string;
/** Self-contained PDF reader document: pdf.js, its worker, and the bridge. */
export declare const pdfReaderHtml: string;
`,
);
console.log(`epub page: ${(epubHtml.length / 1024).toFixed(0)} KB`);
console.log(`pdf page:  ${(pdfHtml.length / 1024).toFixed(0)} KB`);
