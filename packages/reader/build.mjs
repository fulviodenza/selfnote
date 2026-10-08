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

const SHARED_CSS = `
  :root { --paper: #faf5ef; --ink: #1b1b1b; --margin-x: 7vw; --margin-y: 4.5vh; }
  html[data-theme="dark"] { --paper: #14110e; --ink: #e8e4dc; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--paper); color: var(--ink); -webkit-text-size-adjust: 100%; }
  body { -webkit-user-select: none; user-select: none; }
  /* The commit affordance for a selection: floats above everything and stays
     tappable no matter what the content does with events. Amber because that
     is the colour the saved mark will be. */
  #save-highlight {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(26px + env(safe-area-inset-bottom));
    display: none; align-items: center;
    padding: 14px 28px; border: 0; border-radius: 999px;
    background: #f2c94c; color: #1b1b1b;
    font: 600 16px -apple-system, system-ui, sans-serif;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18);
    z-index: 10; cursor: pointer;
  }`;

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
  '<div id="viewer"></div>',
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
  #viewer iframe { -webkit-user-select: text; user-select: text; }`,
  `<script>${epubJs}</script>`,
);

/* ---------------------------------------------------------------- PDF --- */
const pdfJs = await bundle("src/webview/pdf.ts");
// The worker ships inside the page: pdf.js parses on a real Worker where the
// platform allows one from a blob URL, and falls back to its main-thread fake
// worker from the same bytes where it does not. Either way, no network.
const workerSrc = readFileSync(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  "utf8",
).replace(/<\/script>/gi, "<\\/script>");
const pdfHtml = page(
  `<div id="scroll"><div id="page">
    <canvas id="canvas"></canvas>
    <div id="text" class="textLayer"></div>
    <div id="marks"></div>
  </div></div>`,
  `
  #scroll { position: absolute; inset: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding:
      calc(var(--margin-y) + env(safe-area-inset-top))
      calc(var(--margin-x) + env(safe-area-inset-right))
      calc(var(--margin-y) + env(safe-area-inset-bottom))
      calc(var(--margin-x) + env(safe-area-inset-left)); }
  #page { position: relative; margin: 0 auto;
    box-shadow: 0 2px 14px rgba(0,0,0,0.10); background: #fff; }
  #canvas { display: block; }
  /* pdf.js text layer: real, transparent text over the canvas is what makes
     selection work on a drawn page. */
  .textLayer { position: absolute; inset: 0; overflow: hidden;
    line-height: 1; -webkit-user-select: text; user-select: text; }
  .textLayer span, .textLayer br {
    position: absolute; white-space: pre; color: transparent;
    transform-origin: 0 0; cursor: text; }
  .textLayer ::selection { background: rgba(55, 48, 196, 0.28); }
  #marks { position: absolute; inset: 0; pointer-events: none; }
  #marks .mark { position: absolute; opacity: 0.38; border-radius: 3px;
    pointer-events: auto; }`,
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
