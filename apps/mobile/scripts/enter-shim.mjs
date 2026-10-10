#!/usr/bin/env node
/*
 * Regression harness for the WebView editor's Enter handling (issue #102).
 *
 * Loads the exact HTML the app ships (editorHtml() from src/editor), stubs the
 * react-native-webview bridge, mounts the editor the way WebViewEditor.tsx does
 * (an "init" message), and checks Enter, the insertParagraph shim and its
 * guards with DOM and editor-state assertions in a headless Chromium browser.
 *
 * Chromium is not iOS, so ProseMirror's iOS Enter path never runs here; the
 * iOS key sequence (keydown 229, then a cancelable beforeinput) is simulated
 * with synthetic events. The real composition timing still needs a device.
 *
 * Requirements: Node 22.18+ (imports the .ts source directly), network access
 * to esm.sh, and puppeteer-core resolvable from the current directory.
 *   cd <dir with puppeteer-core installed> && node <repo>/apps/mobile/scripts/enter-shim.mjs
 * BROWSER overrides the browser binary (default: Brave on macOS).
 * Exits non-zero if any assertion fails.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let puppeteer;
try {
  const req = createRequire(join(process.cwd(), "noop.js"));
  puppeteer = (await import(pathToFileURL(req.resolve("puppeteer-core")).href)).default;
} catch {
  console.error("puppeteer-core not found from " + process.cwd() + ". Run from a directory where it is installed.");
  process.exit(2);
}
const executablePath = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

const { editorHtml } = await import(pathToFileURL(join(here, "..", "src", "editor", "editorHtml.ts")).href);
let html = editorHtml("light");
// The only patch: expose the module-scoped BlockNote editor for assertions.
const exposeAt = "bnEditor = editor;";
if (!html.includes(exposeAt)) throw new Error("cannot find '" + exposeAt + "' in editorHtml(); update the harness");
html = html.replace(exposeAt, exposeAt + " window.__bn = editor;");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(0);
const url = "http://127.0.0.1:" + server.address().port + "/";

const browser = await puppeteer.launch({ executablePath, headless: "new", args: ["--no-first-run", "--disable-extensions"] });
const page = await browser.newPage();
await page.setViewport({ width: 820, height: 1180 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.evaluateOnNewDocument(() => {
  window.outbox = [];
  window.ReactNativeWebView = { postMessage: (s) => window.outbox.push(JSON.parse(s)) };
});
const sendIn = (msg) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) })), msg);
await page.goto(url);
await page.waitForFunction(() => window.outbox.some((m) => m.type === "ready"), { timeout: 30000 });
await sendIn({ type: "init", editable: true, theme: "light", user: { name: "T", color: "#000" } });
await page.waitForFunction(() => window.__editorMounted && window.__bn, { timeout: 30000 });

// Instrumentation from outside the bundle:
// - every insertParagraph beforeinput is logged at the document (bubble phase,
//   after the shim's capture listener) with whether it was prevented;
// - replays are counted by wrapping view.someProp: a handleKeyDown call for
//   Enter with an event that was never dispatched (target null) is a replay,
//   either the shim's or ProseMirror's own iOS fallback.
await page.evaluate(() => {
  window.__paras = [];
  document.addEventListener("beforeinput", (e) => {
    if (e.inputType === "insertParagraph") window.__paras.push({ prevented: e.defaultPrevented, cancelable: e.cancelable });
  });
  window.__replays = 0;
  const view = window.__bn._tiptapEditor.view;
  const orig = view.someProp.bind(view);
  const seen = new WeakSet(); // someProp visits every handler; count each event once
  view.someProp = (name, f) => {
    if (name === "handleKeyDown" && f) {
      return orig(name, (h) => f((v, ev) => {
        if (ev && ev.key === "Enter" && ev.target === null && !seen.has(ev)) {
          seen.add(ev);
          window.__replays++;
        }
        return h(v, ev);
      }));
    }
    return orig(name, f);
  };
});

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS " : "FAIL ") + name + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 200) : ""));
};
const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function setup(blocks, caretBlock) {
  await page.evaluate((blocks, caretBlock) => {
    const ed = window.__bn;
    ed.replaceBlocks(ed.document, blocks);
    ed.focus();
    ed.setTextCursorPosition(ed.document[caretBlock], "end");
    window.__paras = [];
    window.__replays = 0;
  }, blocks, caretBlock);
  await tick();
}

const state = () => page.evaluate(() => {
  const ed = window.__bn;
  const doc = ed.document.map((b) => ({
    type: b.type,
    text: Array.isArray(b.content) ? b.content.map((n) => n.text || "").join("") : null,
  }));
  const pos = ed.getTextCursorPosition();
  const sel = window.getSelection();
  const containers = Array.from(document.querySelectorAll(".bn-editor [data-node-type=blockContainer]"));
  const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const anchorBlock = anchorEl && anchorEl.closest("[data-node-type=blockContainer]");
  return {
    doc,
    caretBlock: ed.document.findIndex((b) => b.id === pos.block.id),
    caretOffset: ed._tiptapEditor.state.selection.$from.parentOffset,
    domAnchorBlock: anchorBlock ? containers.indexOf(anchorBlock) : -1,
    domBlockCount: containers.length,
    paras: window.__paras,
    replays: window.__replays,
    slashVisible: document.getElementById("slash").style.display !== "none",
  };
});

// Synthetic events on the caret's element. keydown keyCode 229 is what iOS
// sends for Return while autocorrect or predictive text is pending.
const keydown = (keyCode, key) => page.evaluate((keyCode, key) => {
  const n = window.getSelection().anchorNode;
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { get: () => keyCode });
  (n.nodeType === 1 ? n : n.parentElement).dispatchEvent(ev);
}, keyCode, key);
const insertParagraph = (cancelable = true) => page.evaluate((cancelable) => {
  const n = window.getSelection().anchorNode;
  const ev = new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable });
  (n.nodeType === 1 ? n : n.parentElement).dispatchEvent(ev);
  return ev.defaultPrevented;
}, cancelable);
const iosReturn = async (cancelable = true) => {
  await keydown(229, "Unidentified");
  const prevented = await insertParagraph(cancelable);
  await tick();
  return prevented;
};

const P = (t) => ({ type: "paragraph", content: t });

// 2. Shim path with no preceding keydown at all (runs first, before any key).
await setup([P("hello world"), P("after")], 0);
let prevented = await insertParagraph(true);
await tick();
let s = await state();
check("2 no keydown: event prevented, one replay", prevented && s.replays === 1, { prevented, replays: s.replays });
check("2 no keydown: split below, text kept in block 0", s.doc.length === 3 && s.doc[0].text === "hello world" && s.doc[1].text === "" && s.doc[2].text === "after", s.doc);
check("2 no keydown: caret on new block at offset 0 (editor and DOM)", s.caretBlock === 1 && s.caretOffset === 0 && s.domAnchorBlock === 1, s);

// 1. Normal Enter at end of a line (desktop keydown path).
await setup([P("first line"), P("second")], 0);
await page.keyboard.press("Enter");
await tick();
s = await state();
check("1 Enter: new empty block below, text kept", s.doc.length === 3 && s.domBlockCount === 3 && s.doc[0].text === "first line" && s.doc[1].text === "" && s.doc[2].text === "second", s.doc);
check("1 Enter: caret on new block at offset 0", s.caretBlock === 1 && s.caretOffset === 0 && s.domAnchorBlock === 1, s);
check("1 Enter: no insertParagraph, no replay", s.paras.length === 0 && s.replays === 0, { paras: s.paras, replays: s.replays });
await page.keyboard.type("typed");
s = await state();
check("1 Enter: typing lands in the new block", s.doc[1].text === "typed" && s.doc[0].text === "first line", s.doc);

// D. Desktop sequence: keydown 13 handled by ProseMirror, then a stray
// insertParagraph. The shim must not engage because the last keydown was 13.
await setup([P("desk"), P("tail")], 0);
await page.keyboard.press("Enter");
await tick();
prevented = await insertParagraph(true);
await tick();
s = await state();
check("D keydown 13 then insertParagraph: shim does not engage", !prevented && s.replays === 0, { prevented, replays: s.replays });
check("D keydown 13 then insertParagraph: exactly one split", s.doc.length === 3 && s.doc[0].text === "desk" && s.doc[1].text === "", s.doc);

// I. iOS sequence: keydown 229, then cancelable insertParagraph.
await setup([P("hello world"), P("after")], 0);
prevented = await iosReturn(true);
s = await state();
check("I ios 229: event prevented, exactly one replay", prevented && s.replays === 1, { prevented, replays: s.replays });
check("I ios 229: split below, no empty line above", s.doc.length === 3 && s.doc[0].text === "hello world" && s.doc[1].text === "" && s.doc[2].text === "after", s.doc);
check("I ios 229: caret on new block at offset 0 (editor and DOM)", s.caretBlock === 1 && s.caretOffset === 0 && s.domAnchorBlock === 1, s);
await page.keyboard.type("x");
s = await state();
check("I ios 229: typing lands in the new block", s.doc[1].text === "x", s.doc);

// I2. Mid-line iOS Return splits at the caret.
await page.evaluate(() => {
  const ed = window.__bn;
  ed.replaceBlocks(ed.document, [{ type: "paragraph", content: "abcdef" }]);
  ed.focus();
  ed.setTextCursorPosition(ed.document[0], "start");
  const t = ed._tiptapEditor;
  t.commands.setTextSelection(t.state.selection.from + 3);
  window.__replays = 0;
});
await iosReturn(true);
s = await state();
check("I2 ios 229 mid-line: splits at the caret", s.doc.length === 2 && s.doc[0].text === "abc" && s.doc[1].text === "def" && s.caretBlock === 1 && s.caretOffset === 0, s.doc);

// L. lastIOSEnter handling.
await setup([P("pending")], 0);
await page.evaluate(() => { window.__bn._tiptapEditor.view.input.lastIOSEnter = Date.now(); });
await iosReturn(true);
let lie = await page.evaluate(() => window.__bn._tiptapEditor.view.input.lastIOSEnter);
s = await state();
check("L lastIOSEnter cleared after a replay", lie === 0 && s.doc.length === 2, { lie, doc: s.doc });
await setup([P("absent")], 0);
await page.evaluate(() => { delete window.__bn._tiptapEditor.view.input.lastIOSEnter; });
prevented = await iosReturn(true);
s = await state();
const lieBack = await page.evaluate(() => "lastIOSEnter" in window.__bn._tiptapEditor.view.input);
check("L lastIOSEnter absent: no throw, split still happens, field not created", prevented && s.doc.length === 2 && s.replays === 1 && !lieBack, { prevented, doc: s.doc, lieBack });
await page.evaluate(() => { window.__bn._tiptapEditor.view.input.lastIOSEnter = 0; });

// 3a. Enter in list items.
await setup([{ type: "bulletListItem", content: "item one" }], 0);
await page.keyboard.press("Enter");
s = await state();
check("3a list Enter: next bullet item, caret on it, no replay", s.doc.length === 2 && s.doc[1].type === "bulletListItem" && s.doc[1].text === "" && s.caretBlock === 1 && s.replays === 0, s.doc);
await setup([{ type: "checkListItem", content: "todo" }], 0);
await iosReturn(true);
s = await state();
check("3a checklist via ios 229: next checklist item", s.doc.length === 2 && s.doc[1].type === "checkListItem" && s.caretBlock === 1 && s.replays === 1, s.doc);

// 3b. Slash menu. The bundle does not register "/" with addSuggestionMenu and
// its vanilla menu has no Enter handling (pre-existing, outside this harness's
// scope), so this asserts parity: Enter through the shim behaves exactly like
// keydown Enter with the menu open.
await setup([P("")], 0);
await page.keyboard.type("/");
await tick(200);
console.log("INFO slash menu opens without test registration:", (await state()).slashVisible);
await page.evaluate(async () => {
  const m = await import("https://esm.sh/@blocknote/core@0.54.0?external=yjs");
  window.__bn.getExtension(m.SuggestionMenu).addSuggestionMenu({ triggerCharacter: "/" });
});
await setup([P("")], 0);
await page.keyboard.type("/head");
await tick(200);
check("3b slash: menu visible (test-registered trigger)", (await state()).slashVisible);
await page.keyboard.press("Enter");
await tick(200);
const slashKeydownDoc = JSON.stringify((await state()).doc);
await setup([P("")], 0);
await page.keyboard.type("/head");
await tick(200);
await iosReturn(true);
await tick(200);
s = await state();
check("3b slash via ios 229: same result as keydown Enter", JSON.stringify(s.doc) === slashKeydownDoc && s.replays === 1, { shim: s.doc, keydown: slashKeydownDoc });

// 3c. Shift+Enter soft break.
await setup([P("soft")], 0);
await page.keyboard.down("Shift");
await page.keyboard.press("Enter");
await page.keyboard.up("Shift");
await page.keyboard.type("break");
s = await state();
check("3c Shift+Enter: single block with a newline", s.doc.length === 1 && s.doc[0].text === "soft\nbreak" && s.paras.length === 0, s.doc);

// 4. Non-cancelable insertParagraph falls through.
await setup([P("keep"), P("tail")], 0);
prevented = await iosReturn(false);
s = await state();
check("4 non-cancelable: not prevented, no replay", !prevented && s.replays === 0, { prevented, replays: s.replays });
check("4 non-cancelable: block count unchanged (synthetic events have no native default)", s.doc.length === 2 && s.doc[0].text === "keep", s.doc);

// 5. insertLineBreak is not the shim's business.
await setup([P("lb")], 0);
const lbPrevented = await page.evaluate(() => {
  const n = window.getSelection().anchorNode;
  const ev = new InputEvent("beforeinput", { inputType: "insertLineBreak", bubbles: true, cancelable: true });
  (n.nodeType === 1 ? n : n.parentElement).dispatchEvent(ev);
  return ev.defaultPrevented;
});
s = await state();
check("5 insertLineBreak: ignored", !lbPrevented && s.replays === 0, { lbPrevented });

// C. Mid-composition: bail out and leave WebKit alone.
await setup([P("compose")], 0);
await page.evaluate(() => { window.__bn._tiptapEditor.view.input.composing = true; });
prevented = await iosReturn(true);
await page.evaluate(() => { window.__bn._tiptapEditor.view.input.composing = false; });
s = await state();
check("C composing: shim does not engage", !prevented && s.replays === 0 && s.doc.length === 1, { prevented, doc: s.doc });

// R. Read-only note: shim does not edit.
await setup([P("readonly")], 0);
await sendIn({ type: "config", editable: false, theme: "light" });
prevented = await iosReturn(true);
await sendIn({ type: "config", editable: true, theme: "light" });
s = await state();
check("R read-only: shim does not engage", !prevented && s.replays === 0 && s.doc.length === 1, { prevented, doc: s.doc });

const errs = await page.evaluate(() => window.outbox.filter((m) => m.type === "console" && m.level === "error"));
check("no console errors from the WebView", errs.length === 0, errs);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
