#!/usr/bin/env node
/*
 * Checks every client's copy of the Ink and Paper tokens against
 * packages/core/tokens.json. The copies exist because the runtimes (Vite CSS,
 * Metro, two WebViews) cannot share one import; this check is what keeps them
 * from drifting. Run from the repo root: node scripts/check-tokens.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "packages/core/tokens.json"), "utf8"));

/** Text of the first `{ ... }` block after `start` (blocks here are flat). */
function block(src, start, file) {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`${file}: block not found: ${start}`);
  const open = src.indexOf("{", at + start.length - 1);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}

/** CSS custom property value, or a TS object key's string value. */
function read(body, name, style) {
  const re =
    style === "css"
      ? new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;]+);`)
      : new RegExp(`(?:^|[\\s,{])${name}\\s*:\\s*"([^"]+)"`);
  const m = re.exec(body);
  return m ? m[1].trim() : undefined;
}

const norm = (v) => String(v).toLowerCase().replace(/\s+/g, "");

// Copy name -> token key, per naming convention.
const CSS_WEB = {
  "--paper": "paper",
  "--bg": "surface",
  "--hover": "surfaceSunken",
  "--fg": "ink",
  "--muted": "inkSoft",
  "--faint": "inkFaint",
  "--border": "hairline",
  "--accent": "accent",
  "--accent-press": "accentPressed",
  "--accent-wash": "accentWash",
  "--live": "live",
  "--live-wash": "liveWash",
  "--warn": "warn",
  "--danger": "danger",
  "--danger-wash": "dangerWash",
  "--on-accent": "onAccent",
};
const CSS_EDITOR = {
  "--paper": "paper",
  "--surface": "surface",
  "--ink": "ink",
  "--ink-soft": "inkSoft",
  "--ink-faint": "inkFaint",
  "--hairline": "hairline",
  "--accent": "accent",
  "--accent-wash": "accentWash",
  "--warn": "warn",
  "--danger": "danger",
  "--danger-wash": "dangerWash",
  "--surface-sunken": "surfaceSunken",
};
const TS_KEYS = Object.fromEntries(Object.keys(tokens.light).map((k) => [k, k]));

const COPIES = [
  {
    file: "apps/web/src/styles.css",
    style: "css",
    blocks: [
      { start: ":root {", theme: "light", map: CSS_WEB },
      { start: ':root[data-theme="dark"] {', theme: "dark", map: CSS_WEB },
    ],
    extra: [{ start: ":root {", name: "--scrim", value: tokens.scrim }, { start: ":root {", name: "--shadow-floating", value: tokens.shadowFloating }],
  },
  {
    file: "apps/mobile/src/theme.ts",
    style: "ts",
    blocks: [
      { start: "export const colors = {", theme: "light", map: TS_KEYS },
      { start: "export const darkColors: Palette = {", theme: "dark", map: TS_KEYS },
    ],
  },
  {
    file: "apps/mobile/src/editor/editorHtml.ts",
    style: "css",
    blocks: [
      { start: ":root {", theme: "light", map: CSS_EDITOR },
      { start: ':root[data-theme="dark"] {', theme: "dark", map: CSS_EDITOR },
    ],
  },
  {
    file: "apps/ereader/src/theme.ts",
    style: "ts",
    blocks: [
      { start: "export const colors = {", theme: "light", map: TS_KEYS },
      { start: "export const darkColors: Palette = {", theme: "dark", map: TS_KEYS },
    ],
  },
];

// Single values that live outside a token block. packages/reader/build.mjs
// reads tokens.json itself, so it needs no entry here.
const L = tokens.light;
const D = tokens.dark;
const LITERALS = [
  { file: "apps/mobile/src/theme.ts", re: /export const scrim = "([^"]+)"/, want: tokens.scrim },
  { file: "apps/ereader/src/theme.ts", re: /export const scrim = "([^"]+)"/, want: tokens.scrim },
  { file: "apps/mobile/src/editor/editorHtml.ts", re: /name: "Guest", color: "([^"]+)"/, want: tokens.presence[0] },
  { file: "packages/reader/src/webview/reader.ts", re: /themes\.override\("color", dark \? "([^"]+)"/, want: D.ink },
  { file: "packages/reader/src/webview/reader.ts", re: /themes\.override\("color", dark \? "[^"]+" : "([^"]+)"/, want: L.ink },
  { file: "packages/reader/src/webview/reader.ts", re: /themes\.override\("background", dark \? "([^"]+)"/, want: D.paper },
  { file: "packages/reader/src/webview/reader.ts", re: /themes\.override\("background", dark \? "[^"]+" : "([^"]+)"/, want: L.paper },
];

let failures = 0;
for (const copy of COPIES) {
  let src;
  try {
    src = readFileSync(join(root, copy.file), "utf8");
  } catch {
    console.error(`FAIL ${copy.file}: file not found`);
    failures++;
    continue;
  }
  for (const b of copy.blocks) {
    let body;
    try {
      body = block(src, b.start, copy.file);
    } catch (e) {
      console.error(`FAIL ${e.message}`);
      failures++;
      continue;
    }
    for (const [name, key] of Object.entries(b.map)) {
      const want = tokens[b.theme][key];
      const got = read(body, name, copy.style);
      if (got === undefined) {
        console.error(`FAIL ${copy.file} (${b.theme}): ${name} missing, want ${want}`);
        failures++;
      } else if (norm(got) !== norm(want)) {
        console.error(`FAIL ${copy.file} (${b.theme}): ${name} is ${got}, want ${want} (${key})`);
        failures++;
      }
    }
  }
  for (const x of copy.extra ?? []) {
    let got;
    try {
      got = read(block(src, x.start, copy.file), x.name, copy.style);
    } catch (e) {
      got = undefined;
    }
    if (got === undefined || norm(got) !== norm(x.value)) {
      console.error(`FAIL ${copy.file}: ${x.name} is ${got}, want ${x.value}`);
      failures++;
    }
  }
}

for (const lit of LITERALS) {
  let got;
  try {
    got = lit.re.exec(readFileSync(join(root, lit.file), "utf8"))?.[1];
  } catch {
    got = undefined;
  }
  if (got === undefined || norm(got) !== norm(lit.want)) {
    console.error(`FAIL ${lit.file}: ${lit.re} found ${got}, want ${lit.want}`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} token mismatch(es). packages/core/tokens.json is the source of truth.`);
  process.exit(1);
}
console.log(`tokens OK (${COPIES.length} copies, ${LITERALS.length} single values)`);
