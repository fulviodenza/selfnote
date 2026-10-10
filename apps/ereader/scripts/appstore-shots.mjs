#!/usr/bin/env node
// App Store screenshots, reproducibly.
//
//   node scripts/appstore-shots.mjs all            every preset
//   node scripts/appstore-shots.mjs ipad13         one preset
//   node scripts/appstore-shots.mjs all --build    rebuild the app first
//
// Per preset: find or create the simulator, boot it, install the Release build,
// seed the app's container with the demo books and a used-looking database,
// then shoot each screen. The app is steered by Documents/.screenshot-tour.json
// (see src/tour.ts) rather than by synthetic taps, which do not reliably reach
// the Simulator. Every PNG's pixel size is checked against what App Store
// Connect accepts for the bucket; a mismatch fails the run.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const fixtures = join(here, "fixtures");
const BUNDLE = "com.fulviodenza.selfnote";
const APP = join(appRoot, "ios/build/sim/Build/Products/Release-iphonesimulator/SelfnoteeReader.app");
const DT = "com.apple.CoreSimulator.SimDeviceType.";

const PRESETS = {
  ipad13: {
    deviceTypes: [
      "iPad-Pro-13-inch-M5-12GB",
      "iPad-Pro-13-inch-M5-16GB",
      "iPad-Pro-13-inch-M4-8GB",
      "iPad-Pro-13-inch-M4-16GB",
    ],
    sizes: [
      [2064, 2752],
      [2048, 2732],
    ],
    // The note paper in points, for keeping the pasted figure's box to its
    // aspect: the screen less the reader's bars and the paper's inset.
    paper: { w: 976, h: 1184 },
  },
  "iphone-di-medium": {
    deviceTypes: ["iPhone-16-Pro", "iPhone-16", "iPhone-15-Pro"],
    sizes: [
      [1206, 2622],
      [1179, 2556],
    ],
    paper: { w: 346, h: 682 },
    // At phone width a fit-width PDF page is too small to read and leaves the
    // lower half of the screen empty, and the note page is mostly blank paper
    // whose vector ink did not paint on this simulator. The phone listing
    // carries the shelf and the reading page.
    shots: ["01-shelf", "04-epub-page"],
  },
};

// Seconds to let each screen settle before the shot. Generous on purpose: the
// first EPUB open builds its locations index, and the pencil tool picker
// animates in only after the canvas takes focus.
const SHOTS = [
  { name: "01-shelf", tour: null, wait: 8 },
  { name: "02-pdf-page", tour: (ids) => ({ open: ids.pdf, page: 2 }), wait: 12 },
  // The ink is checked for and the shot retaken until it is there: strokes
  // raised from stored vectors do not always all paint on the first load.
  { name: "03-note-page", tour: (ids) => ({ open: ids.pdf, page: 2, note: true }), wait: 16, check: hasInk },
  // Warmed by one open first: the first open of a book builds its locations
  // index, and until that is cached the reader shows 0% progress.
  { name: "04-epub-page", tour: (ids) => ({ open: ids.epub }), wait: 12, warm: (ids) => ids.epub },
];

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log("[shots]", ...a);
const fail = (msg) => {
  console.error("[shots] FAILED:", msg);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
/** For the calls whose failure is a normal state (terminate a stopped app,
 * boot a booted device). */
const simctlQuiet = (...args) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

/* ----------------------------------------------------------- simulators --- */

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(key);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] ?? 0) : -1;
}

function findOrCreateDevice(preset) {
  const { devices } = JSON.parse(simctl("list", "devices", "-j", "available"));
  for (const type of preset.deviceTypes) {
    const matches = [];
    for (const [runtime, list] of Object.entries(devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const d of list) {
        if (d.deviceTypeIdentifier === DT + type && d.isAvailable !== false) {
          matches.push({ ...d, runtime });
        }
      }
    }
    if (!matches.length) continue;
    // A booted one first, so a run does not boot a second copy; then the
    // newest runtime.
    matches.sort(
      (a, b) =>
        Number(b.state === "Booted") - Number(a.state === "Booted") ||
        runtimeVersion(b.runtime) - runtimeVersion(a.runtime),
    );
    return { udid: matches[0].udid, name: matches[0].name, runtime: matches[0].runtime };
  }
  const { runtimes } = JSON.parse(simctl("list", "runtimes", "-j", "available"));
  const ios = runtimes
    .filter((r) => r.platform === "iOS" || r.identifier.includes("iOS"))
    .sort((a, b) => runtimeVersion(b.identifier) - runtimeVersion(a.identifier));
  if (!ios.length) fail("no iOS simulator runtime installed");
  const { devicetypes } = JSON.parse(simctl("list", "devicetypes", "-j"));
  for (const type of preset.deviceTypes) {
    const dt = devicetypes.find((d) => d.identifier === DT + type);
    if (!dt) continue;
    const name = `Selfnote ${dt.name}`;
    const udid = simctl("create", name, dt.identifier, ios[0].identifier).trim();
    log(`created ${name} on ${ios[0].name}`);
    return { udid, name, runtime: ios[0].identifier };
  }
  fail(`none of these device types is installed: ${preset.deviceTypes.join(", ")}`);
}

function boot(udid) {
  simctlQuiet("boot", udid);
  simctl("bootstatus", udid, "-b");
}

/* ---------------------------------------------------------------- build --- */

function build() {
  const logFile = join(appRoot, "screenshots", "build.log");
  mkdirSync(dirname(logFile), { recursive: true });
  log(`building the Release simulator app (log: ${logFile})`);
  const fd = openSync(logFile, "w");
  const res = spawnSync(
    "xcodebuild",
    [
      "-workspace", "SelfnoteeReader.xcworkspace",
      "-scheme", "SelfnoteeReader",
      "-configuration", "Release",
      "-sdk", "iphonesimulator",
      "-arch", "arm64",
      "-derivedDataPath", "./build/sim",
      "build",
    ],
    { cwd: join(appRoot, "ios"), stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  if (res.status !== 0 || !existsSync(APP)) fail(`xcodebuild failed, see ${logFile}`);
}

/* ------------------------------------------------------------- seeding --- */

const sq = (v) =>
  v === null || v === undefined
    ? "null"
    : typeof v === "number"
      ? String(Math.round(v))
      : `'${String(v).replace(/'/g, "''")}'`;

/** A deterministic generator, so every run draws the same handwriting. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Points along an ellipse arc, angles in turns (0 is east, counterclockwise). */
function arc(cx, cy, rx, ry, a0, a1, n = 14) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = 2 * Math.PI * (a0 + ((a1 - a0) * i) / n);
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/**
 * A single-stroke print hand, just the letters the note uses. Units: x-height
 * 1, y up from the baseline; each glyph is [advance, strokes].
 */
const GLYPHS = {
  o: [0.72, [arc(0.32, 0.5, 0.32, 0.5, 0.25, 1.27)]],
  a: [0.74, [[...arc(0.3, 0.5, 0.3, 0.5, 0.08, 0.95), [0.6, 1.02], [0.6, 0.1], [0.66, 0]]]],
  e: [0.7, [[[0.04, 0.5], [0.6, 0.5], ...arc(0.32, 0.5, 0.29, 0.5, 0, 0.9)]]],
  c: [0.66, [arc(0.32, 0.5, 0.3, 0.5, 0.1, 0.88)]],
  v: [0.7, [[[0, 1], [0.3, 0], [0.62, 1]]]],
  w: [0.98, [[[0, 1], [0.22, 0], [0.45, 0.8], [0.68, 0], [0.9, 1]]]],
  r: [0.52, [[[0.02, 0], [0.02, 1], [0.02, 0.62], [0.16, 0.9], [0.34, 1], [0.48, 0.94]]]],
  f: [0.5, [[[0.56, 1.58], [0.4, 1.7], [0.24, 1.62], [0.18, 1.4], [0.18, 0]], [[0, 1], [0.44, 1]]]],
  l: [0.32, [[[0.12, 1.72], [0.12, 0.12], [0.2, 0]]]],
  t: [0.48, [[[0.18, 1.5], [0.18, 0.14], [0.28, 0], [0.42, 0.04]], [[0, 1], [0.42, 1]]]],
  i: [0.3, [[[0.1, 1], [0.1, 0]], [[0.1, 1.38], [0.13, 1.42]]]],
  n: [0.72, [[[0.02, 1], [0.02, 0], [0.02, 0.68], [0.16, 0.95], [0.36, 1.02], [0.54, 0.86], [0.58, 0.6], [0.58, 0]]]],
  k: [0.62, [[[0.04, 1.72], [0.04, 0]], [[0.52, 1], [0.06, 0.42], [0.54, 0]]]],
  p: [0.68, [[[0.04, 1], [0.04, -0.62]], [[0.04, 0.82], ...arc(0.3, 0.5, 0.28, 0.46, 0.4, -0.38), [0.04, 0.16]]]],
  6: [0.68, [[[0.52, 1.62], [0.3, 1.42], [0.12, 1.0], [0.04, 0.5], ...arc(0.32, 0.4, 0.28, 0.4, 0.5, 1.5)]]],
  " ": [0.5, []],
};

/**
 * Ink for the note page in the stored vector shape {c, w, p: [[x, y, pressure]]},
 * x and y fractions of the paper: a ring round the figure's overflow and two
 * lines of hand-printed note. Drawn in points, then
 * normalised, so the hand keeps its shape whatever the paper's aspect.
 */
function noteInk(paper, img) {
  const rand = rng(87);
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const norm = (pts) => pts.map(([x, y, p]) => [r4(x / paper.w), r4(y / paper.h), r4(p)]);
  const ix = img.x * paper.w;
  const iy = img.y * paper.h;
  const iw = img.w * paper.w;
  const ih = img.h * paper.h;
  // The hand scales with the paper: about a ruled line's height on the iPad.
  const s = Math.max(9, paper.w * 0.023);
  // One width for every stroke. Raised from vectors, a drawing that mixes
  // widths came back with only the first width's strokes visible.
  const w = s * 0.17;
  const strokes = [];

  // The ring, drawn a little past its start as a hand does.
  const cx = ix + iw * 0.885;
  const cy = iy + ih * 0.25;
  {
    const pts = arc(cx, cy, iw * 0.1, ih * 0.15, -0.06, 1.05, 44).map(([x, y], i) => [
      x + (rand() - 0.5) * s * 0.08,
      y + (rand() - 0.5) * s * 0.08,
      0.5 + 0.2 * Math.sin(i / 6),
    ]);
    strokes.push({ c: "#b8433a", w, p: norm(pts) });
  }

  // Two lines of note, slanted and a little unsteady.
  const lines = ["overflow at 6 in", "keep inlet clear"];
  const x0 = ix + iw * 0.04;
  let base = iy + ih + s * 3.2;
  for (const line of lines) {
    let x = x0;
    for (const ch of line) {
      const [adv, glyph] = GLYPHS[ch];
      const lift = (rand() - 0.5) * s * 0.12;
      for (const g of glyph) {
        const pts = g.map(([gx, gy], i) => [
          x + (gx + gy * 0.18) * s + (rand() - 0.5) * s * 0.05,
          base + lift - gy * s + (rand() - 0.5) * s * 0.05,
          0.55 + 0.2 * Math.sin((i / Math.max(1, g.length - 1)) * Math.PI),
        ]);
        strokes.push({ c: "#1f3a6b", w, p: norm(pts) });
      }
      x += (adv + 0.12) * s;
    }
    base += s * 2.9;
  }

  return strokes;
}

function seed(udid, preset) {
  const container = simctl("get_app_container", udid, BUNDLE, "data").trim();
  const docs = join(container, "Documents");
  const dbFile = join(docs, "SQLite", "ereader.db");
  if (!existsSync(dbFile)) fail(`the app did not create its database at ${dbFile}`);
  const hl = JSON.parse(readFileSync(join(fixtures, "highlights.json"), "utf8"));

  mkdirSync(join(docs, "books"), { recursive: true });
  const DAY = 86400000;
  const now = Date.now();
  const year = new Date(new Date().getFullYear(), 0, 1).getTime();
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  // Finished this year whatever the date the run happens on.
  const thisYear = (daysAgo) => Math.max(year + DAY, now - daysAgo * DAY);
  const books = [
    { id: "demo-quiet-shore", file: "demo.epub", ext: "epub", title: "The Quiet Shore", author: "Maren Ashdown", added: now - 19 * DAY, opened: now - 2 * 3600000 },
    { id: "demo-rain-gardens", file: "demo.pdf", ext: "pdf", title: "Rain Gardens: A Practical Primer for Small Yards", author: "Tomas Whitcombe", added: now - 6 * DAY, opened: now - 26 * 3600000 },
    { id: "demo-small-engines", file: "demo-small-engines.epub", ext: "epub", title: "Small Engines of Wonder", author: "Hal Petrosky", added: now - 70 * DAY, opened: thisYear(24), finished: thisYear(24) },
    { id: "demo-cartographer", file: "demo-cartographer.epub", ext: "epub", title: "The Cartographer's Notebook", author: "Ruth Oyelaran", added: now - 120 * DAY, opened: thisYear(58), finished: thisYear(58) },
    { id: "demo-slow-bread", file: "demo-slow-bread.epub", ext: "epub", title: "Letters on Slow Bread", author: "Ines Calloway", added: now - 160 * DAY, opened: thisYear(101), finished: thisYear(101) },
  ];
  for (const b of books) copyFileSync(join(fixtures, b.file), join(docs, "books", `${b.id}.${b.ext}`));

  // The pasted figure, its box kept to the image's aspect on this paper.
  const noteId = "demo-note-figure";
  const noteDir = join(docs, "notes", noteId);
  rmSync(join(docs, "notes"), { recursive: true, force: true });
  mkdirSync(noteDir, { recursive: true });
  copyFileSync(join(fixtures, "figure.png"), join(noteDir, "figure.png"));
  const [fw, fh] = ["pixelWidth", "pixelHeight"].map((k) =>
    Number(new RegExp(`${k}: (\\d+)`).exec(run("sips", ["-g", k, join(fixtures, "figure.png")]))[1]),
  );
  const imgW = 0.9;
  const img = { x: 0.05, y: 0.03, w: imgW, h: (imgW * preset.paper.w * (fh / fw)) / preset.paper.h };
  const envelope = {
    v: noteInk(preset.paper, img),
    images: [{ file: `notes/${noteId}/figure.png`, ...img }],
  };

  const sql = [
    "pragma foreign_keys = on;",
    "begin;",
    "delete from highlights; delete from note_pages; delete from reading_sessions;",
    "delete from reading_position; delete from books;",
    "delete from settings where key like 'goal.%' or key like 'fontsize:%';",
    ...books.map(
      (b) =>
        `insert into books (id, title, author, file_path, added_at, locations, finished_at, last_opened_at) values (${[
          b.id, b.title, b.author, `books/${b.id}.${b.ext}`, b.added, null, b.finished ?? null, b.opened,
        ].map(sq).join(", ")});`,
    ),
    `insert into reading_position (book_id, cfi, updated_at) values ('demo-quiet-shore', ${sq(hl.epubPosition)}, ${now - 2 * 3600000});`,
    `insert into reading_position (book_id, cfi, updated_at) values ('demo-rain-gardens', ${sq(String(hl.pdfFigurePage))}, ${now - 26 * 3600000});`,
    // 18 minutes today, in three sittings, and a few earlier days for history.
    ...[
      [Math.max(midnight + 60000, now - 4 * 3600000), 7 * 60],
      [Math.max(midnight + 1200000, now - 2 * 3600000), 5 * 60],
      [Math.max(midnight + 2400000, now - 40 * 60000), 6 * 60],
      [midnight - DAY + 20 * 3600000, 34 * 60],
      [midnight - 2 * DAY + 21 * 3600000, 27 * 60],
    ].map(
      ([at, secs]) =>
        `insert into reading_sessions (book_id, started_at, seconds) values ('demo-quiet-shore', ${at}, ${secs});`,
    ),
    "insert or replace into settings (key, value) values ('goal.daily_minutes', '30');",
    "insert or replace into settings (key, value) values ('goal.yearly_books', '12');",
    ...hl.epub.map(
      (h, i) =>
        `insert into highlights (id, book_id, text, note, color, locator, created_at, synced_at) values (${[
          `demo-hl-epub-${i}`, "demo-quiet-shore", h.text, null, "#f6d365", JSON.stringify({ cfi: h.cfi }), now - (10 - i) * DAY, null,
        ].map(sq).join(", ")});`,
    ),
    ...hl.pdf.map(
      (h, i) =>
        `insert into highlights (id, book_id, text, note, color, locator, created_at, synced_at) values (${[
          `demo-hl-pdf-${i}`, "demo-rain-gardens", h.text, null, "#f6d365", JSON.stringify(h.locator), now - (5 - i) * DAY, null,
        ].map(sq).join(", ")});`,
    ),
    `insert into note_pages (id, book_id, after_page, position, strokes, created_at, updated_at) values (${[
      noteId, "demo-rain-gardens", hl.pdfFigurePage, 0, JSON.stringify(envelope), now - 3 * DAY, now - 3 * DAY,
    ].map(sq).join(", ")});`,
    "commit;",
    // Rows left in the WAL have been lost once already when the app reopened
    // the file; fold them into the main database before it does.
    "pragma wal_checkpoint(TRUNCATE);",
  ].join("\n");
  run("sqlite3", [dbFile], { input: sql });
  const count = run("sqlite3", [dbFile, "select count(*) from books; select count(*) from highlights;"]).trim();
  log(`seeded ${container} (books, highlights: ${count.split("\n").join(", ")})`);
  return { docs, ids: { epub: "demo-quiet-shore", pdf: "demo-rain-gardens" } };
}

/* ---------------------------------------------------------------- shots --- */

const INK = [0x1f, 0x3a, 0x6b];

/** Whether the handwritten note painted: enough pixels in the note's ink
 * colour, read from a BMP copy because node has no PNG decoder. */
function hasInk(file) {
  const bmp = file.replace(/\.png$/, ".check.bmp");
  try {
    run("sips", ["-s", "format", "bmp", file, "--out", bmp]);
    const b = readFileSync(bmp);
    const offset = b.readUInt32LE(10);
    const width = b.readInt32LE(18);
    const height = Math.abs(b.readInt32LE(22));
    const bytes = b.readUInt16LE(28) / 8;
    const row = Math.ceil((width * bytes) / 4) * 4;
    let n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = offset + y * row + x * bytes;
        // BMP stores blue, green, red.
        if (
          Math.abs(b[i + 2] - INK[0]) < 28 &&
          Math.abs(b[i + 1] - INK[1]) < 28 &&
          Math.abs(b[i] - INK[2]) < 28
        ) n++;
      }
    }
    return n > 400;
  } finally {
    rmSync(bmp, { force: true });
  }
}

function pngSize(file) {
  const out = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  return [Number(/pixelWidth: (\d+)/.exec(out)[1]), Number(/pixelHeight: (\d+)/.exec(out)[1])];
}

/** Until the app has cached the book's locations index, checked in the
 * database the app writes it to. */
async function waitForLocations(dbFile, bookId) {
  for (let i = 0; i < 90; i++) {
    await sleep(1);
    const n = run("sqlite3", [dbFile, `select count(*) from books where id = '${bookId}' and locations is not null`]).trim();
    if (n === "1") return;
  }
  fail(`the app never cached the locations of ${bookId}`);
}

async function launchFresh(udid) {
  simctlQuiet("terminate", udid, BUNDLE);
  await sleep(1);
  simctl("launch", udid, BUNDLE);
}

async function runPreset(name, buildFirst) {
  const preset = PRESETS[name];
  const dev = findOrCreateDevice(preset);
  log(`${name}: ${dev.name} ${dev.udid} (${dev.runtime.split(".").pop()})`);
  boot(dev.udid);
  if (buildFirst || !existsSync(APP)) build();

  simctlQuiet("terminate", dev.udid, BUNDLE);
  simctl("install", dev.udid, APP);
  // One launch so the app creates its own schema; the seed only writes rows.
  const container = simctl("get_app_container", dev.udid, BUNDLE, "data").trim();
  const tourFile = join(container, "Documents", ".screenshot-tour.json");
  rmSync(tourFile, { force: true });
  await launchFresh(dev.udid);
  for (let i = 0; i < 30 && !existsSync(join(container, "Documents/SQLite/ereader.db")); i++) await sleep(1);
  await sleep(3);
  simctlQuiet("terminate", dev.udid, BUNDLE);
  await sleep(1);

  const { ids } = seed(dev.udid, preset);
  simctl(
    "status_bar", dev.udid, "override",
    "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
    "--dataNetwork", "wifi", "--wifiBars", "3",
  );

  const outDir = join(appRoot, "screenshots", name);
  // Fresh each run, so a shot a preset no longer takes does not linger.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const results = [];
  try {
    for (const shot of SHOTS.filter((s) => !preset.shots || preset.shots.includes(s.name))) {
      if (shot.tour) writeFileSync(tourFile, JSON.stringify(shot.tour(ids)));
      else rmSync(tourFile, { force: true });
      if (shot.warm) {
        await launchFresh(dev.udid);
        await waitForLocations(join(container, "Documents/SQLite/ereader.db"), shot.warm(ids));
      }
      const file = join(outDir, `${shot.name}.png`);
      for (let attempt = 1; ; attempt++) {
        await launchFresh(dev.udid);
        await sleep(shot.wait);
        simctl("io", dev.udid, "screenshot", "--type=png", file);
        if (!shot.check || shot.check(file)) break;
        if (attempt === 5) fail(`${shot.name}: the screen never showed what it should (${file})`);
        log(`${shot.name}: not painted yet, retaking (${attempt})`);
      }
      const [w, h] = pngSize(file);
      const ok = preset.sizes.some(([aw, ah]) => aw === w && ah === h);
      results.push({ preset: name, file, w, h, ok });
      log(`${shot.name}: ${w}x${h} ${ok ? "accepted" : "NOT ACCEPTED"}`);
    }
  } finally {
    // Leave the device usable by hand: no tour steering the next launch.
    rmSync(tourFile, { force: true });
    simctlQuiet("terminate", dev.udid, BUNDLE);
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    printTable(results);
    fail(
      `${bad.length} screenshot(s) at a size App Store Connect will not take for ${name} ` +
        `(wants ${preset.sizes.map(([w, h]) => `${w}x${h}`).join(" or ")})`,
    );
  }
  return results;
}

function printTable(rows) {
  const lines = [["preset", "file", "size", "accepted"], ...rows.map((r) => [r.preset, r.file.replace(appRoot + "/", ""), `${r.w}x${r.h}`, r.ok ? "yes" : "no"])];
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "all";
const names = target === "all" ? Object.keys(PRESETS) : [target];
for (const n of names) if (!PRESETS[n]) fail(`unknown preset ${n}; one of: all, ${Object.keys(PRESETS).join(", ")}`);
let buildFirst = args.includes("--build");
const all = [];
for (const n of names) {
  all.push(...(await runPreset(n, buildFirst)));
  buildFirst = false;
}
printTable(all);
