#!/usr/bin/env node
// Structural check on the generated WebView editor document.
//
//   node scripts/check-editor-html.mjs
//
// src/editor/editorHtml.ts builds an ~84KB document as one template literal,
// with a whole JS program inside it. Two kinds of breakage in there are
// invisible to `tsc --noEmit`, because the result is still a valid string and
// still a valid TypeScript file:
//
//   - an unescaped backtick (easy to write in a prose comment, as in
//     "a `fixed` offset") closes the template early and silently truncates
//     everything after it, including the script's closing tag;
//   - a syntax error in the inline script, which no compiler ever parses.
//
// Both ship a blank editor. This asserts the document is whole and that its
// script parses, and deliberately asserts nothing about specific rules or
// behaviour, so it does not need updating when the editor changes.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const require = createRequire(import.meta.url);
const ts = require(join(app, "node_modules/typescript"));

const source = join(app, "src/editor/editorHtml.ts");
const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const tmp = join(app, "node_modules", ".editorHtml.check.cjs");
writeFileSync(tmp, compiled);
let editorHtml;
try {
  ({ editorHtml } = require(tmp));
} finally {
  unlinkSync(tmp);
}

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
};

for (const theme of ["light", "dark"]) {
  console.log(`\n${theme}:`);
  const html = editorHtml(theme);

  const opens = (html.match(/<script/g) || []).length;
  const closes = (html.match(/<\/script>/g) || []).length;
  check("document ends with </html>", html.trimEnd().endsWith("</html>"));
  check("<body> is closed", /<\/body>/.test(html));
  check("script tags balanced", opens === closes, `${opens} open, ${closes} closed`);
  check("theme is baked into <html>", new RegExp(`<html data-theme="${theme}"`).test(html));

  // Every script, not just the module one: the classic bootstrap script owns
  // the offline Retry fallback, and a syntax error there would take the
  // fallback down without touching the editor.
  const scripts = [...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g)]
    .map((m) => ({ attrs: m.groups.attrs.trim(), body: m.groups.body }))
    // An importmap is JSON, not a program.
    .filter((s) => !/type\s*=\s*["']importmap["']/.test(s.attrs));

  check("inline scripts present", scripts.length >= 2, `found ${scripts.length}`);
  check("module script present", scripts.some((s) => /type\s*=\s*["']module["']/.test(s.attrs)));

  for (const [i, script] of scripts.entries()) {
    const label = script.attrs ? `<script ${script.attrs}>` : "<script>";
    const parsed = ts.createSourceFile(
      `editor-webview-${i}.js`,
      script.body,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.JS,
    );
    const errors = parsed.parseDiagnostics ?? [];
    check(`${label} parses`, errors.length === 0, `${errors.length} syntax errors`);
    for (const e of errors.slice(0, 5)) {
      const { line } = parsed.getLineAndCharacterOfPosition(e.start);
      console.log(`       line ${line + 1}: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`);
    }
  }
}

console.log(failed === 0 ? "\neditorHtml OK" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
