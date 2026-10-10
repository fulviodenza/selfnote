#!/usr/bin/env node
// Builds the demo books the App Store screenshots read from: the EPUBs, the PDF,
// the figure image a note page shows, and highlights.json with each highlight's
// locator worked out from the same layout that wrote the text. Run it after
// editing content.mjs; the outputs are committed so the shot script needs
// nothing but this folder. macOS only for figure.png (Quick Look renders it).
import { copyFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { shore, finished, primer, shoreHighlights, primerHighlights } from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ zip --- */

/** A stored (uncompressed) zip. EPUB requires mimetype first and uncompressed,
 * and storing everything keeps the writer to a page. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const fname = Buffer.from(name);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fname, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fname);
    offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ----------------------------------------------------------------- epub --- */

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Typographic apostrophes in the book; one UTF-16 unit each, so CFI offsets
// computed on the source string still hold.
const curl = (s) => s.replace(/'/g, "’");

const CSS = `body { font-family: Georgia, serif; line-height: 1.55; margin: 0 4%; }
h1 { font-weight: normal; font-size: 1.7em; margin: 0.2em 0 1.2em; line-height: 1.2; }
p { margin: 0 0 0.9em; text-align: justify; hyphens: auto; }
p.label { text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.75em; color: #7a6a58; margin-top: 2.5em; }
.title { text-align: center; margin-top: 30%; }
.title h1 { font-size: 2.4em; margin-bottom: 0.3em; }
.title .sub { font-style: italic; text-align: center; }
.title .by { text-align: center; margin-top: 3em; letter-spacing: 0.08em; }
`;

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

const NUMBERS = ["One", "Two", "Three", "Four", "Five", "Six"];

/** chapters: [{title, paras}]. Spine: title page, then one file per chapter,
 * so chapter n (1-based) is spine step (n + 1) * 2. Inside a chapter the body
 * holds the label, the heading, then the paragraphs: paragraph i is /4/(6 + 2i). */
function epub({ id, title, subtitle, author, chapters }) {
  const files = [];
  files.push([
    "OEBPS/title.xhtml",
    xhtml(
      title,
      `<div class="title"><h1>${esc(title)}</h1>${
        subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ""
      }<p class="by">${esc(author)}</p></div>`,
    ),
  ]);
  chapters.forEach((c, i) => {
    files.push([
      `OEBPS/c${i + 1}.xhtml`,
      xhtml(
        c.title,
        `<p class="label">Chapter ${NUMBERS[i]}</p><h1>${esc(curl(c.title))}</h1>${c.paras
          .map((p) => `<p>${esc(curl(p))}</p>`)
          .join("")}`,
      ),
    ]);
  });
  const nav = xhtml(
    "Contents",
    `<nav epub:type="toc"><h1>Contents</h1><ol>${chapters
      .map((c, i) => `<li><a href="c${i + 1}.xhtml">${esc(curl(c.title))}</a></li>`)
      .join("")}</ol></nav>`,
  );
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:selfnote-demo:${id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(author)}</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("\n")}
</manifest>
<spine>
<itemref idref="title"/>
${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("\n")}
</spine>
</package>`;
  return zip([
    ["mimetype", "application/epub+zip"],
    [
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ],
    ["OEBPS/content.opf", opf],
    ["OEBPS/nav.xhtml", nav],
    ["OEBPS/style.css", CSS],
    ...files,
  ]);
}

function shoreCfi({ chapter, para, phrase }) {
  const text = curl(shore.chapters[chapter - 1].paras[para]);
  const want = curl(phrase);
  const at = text.indexOf(want);
  if (at < 0) throw new Error(`phrase not in chapter ${chapter} paragraph ${para}: ${phrase}`);
  return {
    text: want,
    cfi: `epubcfi(/6/${(chapter + 1) * 2}!/4/${6 + 2 * para},/1:${at},/1:${at + want.length})`,
  };
}

/* ------------------------------------------------------------------ pdf --- */

// Advance widths in 1/1000 em from the standard 14 font metrics, for the
// characters the primer uses. Text is set with them so justification is exact
// and a highlight's rectangles land on its words.
const W = {
  times: {
    " ": 250, "!": 333, "%": 833, "(": 333, ")": 333, ",": 250, "-": 333, ".": 250, "/": 278,
    ":": 278, ";": 278, "?": 444, "’": 333,
    digits: 500,
    A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722,
    L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722,
    W: 944, X: 722, Y: 722, Z: 611,
    a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500,
    l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500,
    w: 722, x: 500, y: 500, z: 444,
  },
  helv: {
    " ": 278, "!": 278, "%": 889, "(": 333, ")": 333, ",": 278, "-": 333, ".": 278, "/": 278,
    ":": 278, ";": 278, "’": 222, "+": 584,
    digits: 556,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667,
    L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667,
    W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500,
    l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500,
    w: 722, x: 500, y: 500, z: 500,
  },
  helvBold: {
    " ": 278, ".": 278, ",": 278, "-": 333, ":": 333, "(": 333, ")": 333, "%": 889, "+": 584,
    digits: 556,
    A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722,
    L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667,
    W: 944, X: 667, Y: 667, Z: 611,
    a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556,
    l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556,
    w: 778, x: 556, y: 556, z: 500,
  },
};

function width(font, s, size) {
  const t = W[font];
  let n = 0;
  for (const ch of s) {
    const w = /[0-9]/.test(ch) ? t.digits : t[ch];
    if (w === undefined) throw new Error(`no width for ${JSON.stringify(ch)} in ${font}`);
    n += w;
  }
  return (n * size) / 1000;
}

/** A PDF string in WinAnsi: the typographic apostrophe is byte 0x92. */
function pstr(s) {
  let out = "(";
  for (const ch of s) {
    if (ch === "’") out += "\\222";
    else if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out + ")";
}

const FONT = { times: "F1", timesItalic: "F2", helv: "F3", helvBold: "F4" };
const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 72;
const MEASURE = PAGE_W - 2 * LEFT;
const BODY = 12;
const LEAD = 17;

/** Greedy line breaking, justified except for each paragraph's last line.
 * Returns lines with their character span and word spacing, for highlights. */
function setParagraph(ops, text, y, font = "times", size = BODY, lead = LEAD, measure = MEASURE) {
  const words = text.split(" ");
  const lines = [];
  let cur = [];
  let start = 0;
  let pos = 0;
  for (const w of words) {
    const trial = [...cur, w].join(" ");
    if (cur.length && width(font, trial, size) > measure) {
      lines.push({ text: cur.join(" "), start });
      start = pos;
      cur = [w];
    } else cur.push(w);
    pos += w.length + 1;
  }
  lines.push({ text: cur.join(" "), start, last: true });
  for (const line of lines) {
    const gaps = line.text.split(" ").length - 1;
    line.tw = line.last || !gaps ? 0 : (measure - width(font, line.text, size)) / gaps;
    line.y = y;
    ops.push(
      `BT /${FONT[font]} ${size} Tf ${line.tw.toFixed(3)} Tw ${LEFT} ${y.toFixed(2)} Td ${pstr(line.text)} Tj ET`,
    );
    y -= lead;
  }
  return { y, lines, font, size };
}

/** The rectangles covering `phrase` in a set paragraph, as fractions of the
 * page with the origin top left: the locator shape the PDF reader draws. */
function rectsFor(set, text, phrase) {
  const at = text.indexOf(phrase);
  if (at < 0) throw new Error(`phrase not on its page: ${phrase}`);
  const end = at + phrase.length;
  const rects = [];
  for (const line of set.lines) {
    const ls = line.start;
    const le = ls + line.text.length;
    const a = Math.max(at, ls);
    const b = Math.min(end, le);
    if (a >= b) continue;
    const xOf = (i) => {
      const prefix = line.text.slice(0, i - ls);
      return LEFT + width(set.font, prefix, set.size) + (prefix.split(" ").length - 1) * line.tw;
    };
    const x0 = xOf(a);
    const x1 = xOf(b);
    const top = line.y + set.size * 0.8;
    const h = set.size * 1.08;
    const r4 = (n) => Math.round(n * 10000) / 10000;
    rects.push({
      x: r4(x0 / PAGE_W),
      y: r4((PAGE_H - top) / PAGE_H),
      w: r4((x1 - x0) / PAGE_W),
      h: r4(h / PAGE_H),
    });
  }
  return rects;
}

const rgb = (hex) =>
  [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
const fill = (hex) => `${rgb(hex)} rg`;
const stroke = (hex) => `${rgb(hex)} RG`;
const text = (font, size, x, y, s, color = "#1f2a24") =>
  `BT ${fill(color)} /${FONT[font]} ${size} Tf 0 Tw ${x.toFixed(2)} ${y.toFixed(2)} Td ${pstr(s)} Tj ET`;
const poly = (pts) =>
  pts.map(([x, y], i) => `${x.toFixed(2)} ${y.toFixed(2)} ${i ? "l" : "m"}`).join(" ") + " h";

/** Figure 1, a rain garden in section, in a 468 x 250 box with its origin at
 * the bottom left. Drawn with vector ops only. */
const FIG_W = 468;
const FIG_H = 250;
function figureOps() {
  const o = [];
  const G = 170; // ground level
  const slopeL = (y) => 135 - (y - 130) * (35 / 40);
  const slopeR = (y) => 365 + (y - 130) * (35 / 40);
  const digL = (y) => 150 - (y - 40) * (15 / 90);
  const digR = (y) => 350 + (y - 40) * (15 / 90);
  // sky and native subsoil
  o.push(fill("#f7f4ec"), `0 0 ${FIG_W} ${FIG_H} re f`);
  o.push(fill("#d8c7a8"), `0 8 ${FIG_W} ${G - 8} re f`);
  o.push(fill("#c9b590"));
  for (let i = 0; i < 70; i++) {
    const x = (i * 73.3) % FIG_W;
    const y = 14 + ((i * 37.7) % (G - 22));
    if (x > digL(y) - 6 && x < digR(y) + 6 && y > 36) continue;
    o.push(`${x.toFixed(1)} ${y.toFixed(1)} 2.2 1.4 re f`);
  }
  // the basin, cut out of the ground
  o.push(fill("#f7f4ec"), poly([[100, G], [135, 130], [365, 130], [400, G]]), "f");
  // ponding water
  o.push(fill("#cfe3f2"), poly([[slopeL(149), 149], [slopeL(130), 130], [slopeR(130), 130], [slopeR(149), 149]]), "f");
  o.push(stroke("#7fa9cc"), "0.8 w", `${slopeL(149).toFixed(2)} 149 m ${slopeR(149).toFixed(2)} 149 l S`);
  // gravel, soil mix, mulch
  const band = (y0, y1, color) =>
    o.push(fill(color), poly([[digL(y1), y1], [digL(y0), y0], [digR(y0), y0], [digR(y1), y1]]), "f");
  band(40, 70, "#b9b7ad");
  band(70, 120, "#9a7656");
  band(120, 130, "#5e4330");
  o.push(fill("#8f8c82"));
  for (let i = 0; i < 48; i++) {
    const x = digL(55) + 6 + ((i * 41.3) % (digR(55) - digL(55) - 12));
    const y = 44 + ((i * 17.9) % 22);
    const r = 2 + (i % 3);
    o.push(`${x.toFixed(1)} ${(y + r).toFixed(1)} m ${(x + r).toFixed(1)} ${y.toFixed(1)} ${(x).toFixed(1)} ${(y - r).toFixed(1)} ${(x - r).toFixed(1)} ${y.toFixed(1)} c ${(x - r).toFixed(1)} ${y.toFixed(1)} ${(x).toFixed(1)} ${(y + r).toFixed(1)} ${(x).toFixed(1)} ${(y + r).toFixed(1)} c f`);
  }
  // outline of the excavation
  o.push(stroke("#4a3a2c"), "0.9 w", poly([[digL(130), 130], [digL(40), 40], [digR(40), 40], [digR(130), 130]]), "S");
  o.push(stroke("#4a3a2c"), "1.2 w", `0 ${G} m 100 ${G} l 135 130 l 365 130 l 400 ${G} l ${FIG_W} ${G} l S`);
  // grass on the lawn either side
  o.push(stroke("#5f8a4a"), "1 w");
  for (const [a, b] of [[4, 96], [404, 464]]) {
    for (let x = a; x < b; x += 7) o.push(`${x} ${G} m ${x + 2} ${G + 6} l ${x + 4} ${G} m ${x + 5} ${G + 4} l S`);
  }
  // plants with roots
  for (const [x, h] of [[175, 74], [250, 92], [322, 66]]) {
    o.push(stroke("#6b4e38"), "0.6 w");
    for (const dx of [-14, -6, 4, 12]) o.push(`${x} 128 m ${x + dx} ${128 - 30 - Math.abs(dx)} ${x + dx * 1.6} ${84 - Math.abs(dx)} ${x + dx * 0.8} 76 c S`);
    o.push(stroke("#3f6b35"), "1.6 w", `${x} 130 m ${x} ${130 + h} l S`);
    o.push(fill("#5e9450"));
    for (let k = 0; k < 4; k++) {
      const y = 140 + k * (h / 4.4);
      const s = k % 2 ? 1 : -1;
      const len = 22 - k * 3;
      o.push(`${x} ${y} m ${x + s * len * 0.5} ${y + 9} ${x + s * len} ${y + 8} ${x + s * len} ${y + 10} c ${x + s * len * 0.6} ${y + 2} ${x + s * 4} ${y - 1} ${x} ${y} c f`);
    }
    const cy = 133 + h;
    o.push(fill("#c86b8a"), `${x + 3.5} ${cy} m ${x + 3.5} ${cy + 2} ${x + 2} ${cy + 3.5} ${x} ${cy + 3.5} c ${x - 2} ${cy + 3.5} ${x - 3.5} ${cy + 2} ${x - 3.5} ${cy} c ${x - 3.5} ${cy - 2} ${x - 2} ${cy - 3.5} ${x} ${cy - 3.5} c ${x + 2} ${cy - 3.5} ${x + 3.5} ${cy - 2} ${x + 3.5} ${cy} c f`);
  }
  // the house wall and downspout
  o.push(fill("#e8e1d6"), `0 ${G} 40 ${FIG_H - G} re f`);
  o.push(stroke("#9c9488"), "0.8 w", `40 ${G} m 40 ${FIG_H} l S`);
  o.push(stroke("#7d8590"), "5 w", "1 J 1 j", `40 236 m 54 236 l 54 178 l 92 176 l S`, "0 J 0 j");
  // inflow and overflow
  const arrow = (path, tip, dir) => {
    o.push(stroke("#3d7fb8"), "1.6 w", path + " S");
    const [tx, ty] = tip;
    const [dx, dy] = dir;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    o.push(fill("#3d7fb8"), poly([[tx, ty], [tx - 7 * ux - 3.5 * uy, ty - 7 * uy + 3.5 * ux], [tx - 7 * ux + 3.5 * uy, ty - 7 * uy - 3.5 * ux]]), "f");
  };
  arrow("96 176 m 108 172 114 164 120 152 c", [121, 150], [0.45, -1]);
  arrow("372 152 m 392 160 404 184 436 186 c", [440, 186], [1, 0]);
  // rain
  o.push(stroke("#8fb6d6"), "0.9 w");
  for (let i = 0; i < 26; i++) {
    const x = 110 + ((i * 53.7) % 270);
    const y = 206 + ((i * 23.3) % 36);
    o.push(`${x.toFixed(1)} ${y.toFixed(1)} m ${(x - 3).toFixed(1)} ${(y - 8).toFixed(1)} l S`);
  }
  // labels with leaders
  const label = (lines, x, y, from, to) => {
    if (from) o.push(stroke("#4d4d48"), "0.5 w", `${from[0]} ${from[1]} m ${to[0]} ${to[1]} l S`);
    lines.forEach((s, i) => o.push(text("helv", 8, x, y - i * 9.5, s, "#2b2b28")));
  };
  label(["Ponding zone", "6 to 12 in"], 58, 146, [116, 140], [127, 140]);
  label(["Mulch, 3 in"], 381, 122, [363, 125], [378, 125]);
  label(["Soil mix, 18 in"], 381, 95, [358, 98], [378, 98]);
  label(["Gravel, 12 in"], 381, 52, [353, 55], [378, 55]);
  label(["Native subsoil"], 12, 24);
  label(["Inflow from", "downspout"], 62, 198);
  label(["Overflow"], 404, 196);
  return o;
}

function pdf() {
  const pages = [];
  const marks = [];
  const sets = new Map();
  for (const sec of primer.sections) {
    const ops = [];
    let y;
    if (sec.page === 1) {
      ops.push(text("helv", 9, LEFT, 736, "A FIELD SERIES PRIMER", "#5f8a4a"));
      ops.push(text("helvBold", 34, LEFT, 694, primer.title, "#1c2b22"));
      ops.push(text("helv", 15, LEFT, 670, primer.subtitle, "#55605a"));
      ops.push(text("timesItalic", 12, LEFT, 644, `By ${primer.author}`, "#3d4440"));
      ops.push(fill("#5f8a4a"), `${LEFT} 626 64 2.5 re f`);
      y = 588;
    } else {
      ops.push(text("helv", 8, LEFT, 752, "RAIN GARDENS", "#8a918c"));
      ops.push(stroke("#d6d2c8"), "0.5 w", `${LEFT} 745 m ${PAGE_W - LEFT} 745 l S`);
      y = 712;
    }
    ops.push(text("helvBold", 15, LEFT, y, sec.heading, "#1c2b22"));
    y -= 26;
    const paras = (list) => {
      for (const p of list) {
        ops.push(fill("#1f2a24"));
        const set = setParagraph(ops, curl(p), y);
        sets.set(p, set);
        y = set.y - 8;
      }
    };
    paras(sec.paras);
    if (sec.figure) {
      y -= 6;
      const fy = y - FIG_H;
      ops.push("q", `1 0 0 1 ${LEFT} ${fy} cm`, ...figureOps(), "Q");
      ops.push(stroke("#cfc9bd"), "0.6 w", `${LEFT} ${fy} ${FIG_W} ${FIG_H} re S`);
      y = fy - 16;
      ops.push(fill("#3d4440"));
      const cap = setParagraph(
        ops,
        "Figure 1. A rain garden in section. Roof water enters from the left, pools above the mulch and soaks down through the soil mix and gravel; anything beyond the ponding depth leaves by the overflow.",
        y,
        "times",
        10,
        13,
      );
      ops.splice(ops.length - cap.lines.length, cap.lines.length, ...cap.lines.map((l) =>
        `BT /${FONT.timesItalic} 10 Tf ${l.tw.toFixed(3)} Tw ${LEFT} ${l.y.toFixed(2)} Td ${pstr(l.text)} Tj ET`));
      y = cap.y - 14;
    }
    if (sec.table) {
      y -= 4;
      const cols = [LEFT, LEFT + 120, LEFT + 250, LEFT + 370];
      const rows = [
        ["Soil", "Drains per hour", "Basin size", "Gravel depth"],
        ["Sand", "2 in or more", "20% of area", "None to 6 in"],
        ["Sandy loam", "1 to 2 in", "25% of area", "6 in"],
        ["Silt loam", "0.5 to 1 in", "35% of area", "12 in"],
        ["Clay", "Under 0.5 in", "45% or more", "18 in"],
      ];
      ops.push(fill("#e9efe4"), `${LEFT} ${y - 8} ${MEASURE} 24 re f`);
      rows.forEach((r, i) => {
        const ry = y - i * 24;
        r.forEach((cell, c) =>
          ops.push(text(i === 0 ? "helvBold" : "helv", 10, cols[c] + 8, ry, cell, i === 0 ? "#1c2b22" : "#2f3632")),
        );
        ops.push(stroke("#cfd6c8"), "0.5 w", `${LEFT} ${ry - 8} m ${PAGE_W - LEFT} ${ry - 8} l S`);
      });
      ops.push(text("timesItalic", 10, LEFT, y - rows.length * 24 - 6, "Table 1. Starting points for basin size and gravel depth by soil.", "#3d4440"));
      y = y - rows.length * 24 - 34;
    }
    if (sec.after) paras(sec.after);
    if (sec.page === 4) {
      y -= 10;
      const items = [
        "Spring: pull weeds and top up thin mulch.",
        "Summer: water new plants weekly in the first year.",
        "Autumn: clear leaves from the inlet and overflow.",
        "After big storms: check the basin drains within a day.",
      ];
      const boxH = 34 + items.length * 18;
      ops.push(fill("#eef2ea"), `${LEFT} ${y - boxH} ${MEASURE} ${boxH} re f`);
      ops.push(fill("#5f8a4a"), `${LEFT} ${y - boxH} 3 ${boxH} re f`);
      ops.push(text("helvBold", 11, LEFT + 18, y - 22, "A year of care, at a glance", "#1c2b22"));
      items.forEach((s, i) => {
        const iy = y - 44 - i * 18;
        ops.push(fill("#5f8a4a"), `${LEFT + 20} ${iy + 2} 4 4 re f`);
        ops.push(text("times", 11, LEFT + 32, iy, s));
      });
    }
    const n = String(sec.page);
    ops.push(text("helv", 9, PAGE_W / 2 - width("helv", n, 9) / 2, 40, n, "#8a918c"));
    pages.push(ops.join("\n"));
  }
  for (const h of primerHighlights) {
    const sec = primer.sections.find((s) => s.page === h.page);
    const p = [...sec.paras, ...(sec.after ?? [])].find((t) => t.includes(h.phrase));
    if (!p) throw new Error(`phrase not on page ${h.page}: ${h.phrase}`);
    marks.push({
      text: curl(h.phrase),
      locator: { page: h.page, rects: rectsFor(sets.get(p), curl(p), curl(h.phrase)) },
    });
  }
  return { file: buildPdf(pages, [PAGE_W, PAGE_H], { Title: `${primer.title}: ${primer.subtitle}`, Author: primer.author }), marks };
}

function buildPdf(pageStreams, [w, h], info) {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const fonts = {
    F1: "Times-Roman",
    F2: "Times-Italic",
    F3: "Helvetica",
    F4: "Helvetica-Bold",
  };
  const fontRefs = Object.entries(fonts).map(
    ([k, base]) => [k, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`)],
  );
  const res = `<< /Font << ${fontRefs.map(([k, n]) => `/${k} ${n} 0 R`).join(" ")} >> >>`;
  const pagesId = objs.length + 1;
  objs.push(null);
  const kids = [];
  for (const s of pageStreams) {
    const content = add(`<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${w} ${h}] /Resources ${res} /Contents ${content} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = add(`<< ${Object.entries(info).map(([k, v]) => `/${k} ${pstr(v)}`).join(" ")} /Producer (selfnote fixtures) >>`);
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/* ----------------------------------------------------------------- main --- */

writeFileSync(join(here, "demo.epub"), epub(shore));
for (const b of finished) {
  writeFileSync(
    join(here, `${b.id}.epub`),
    epub({ id: b.id, title: b.title, author: b.author, chapters: [{ title: b.chapter, paras: b.paras }] }),
  );
}
const { file, marks } = pdf();
writeFileSync(join(here, "demo.pdf"), file);

// The figure alone, rasterised, stands in for a region copied off page 2.
const tmp = mkdtempSync(join(tmpdir(), "fixtures-"));
try {
  const figPdf = join(tmp, "figure.pdf");
  writeFileSync(figPdf, buildPdf([figureOps().join("\n")], [FIG_W, FIG_H], { Title: "Figure 1" }));
  // Quick Look renders the vectors at the asked size; sips would rasterise at
  // 72 dpi and scale up.
  execFileSync("qlmanage", ["-t", "-s", String(FIG_W * 3), "-o", tmp, figPdf], { stdio: "ignore" });
  copyFileSync(join(tmp, "figure.pdf.png"), join(here, "figure.png"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

writeFileSync(
  join(here, "highlights.json"),
  JSON.stringify(
    {
      epub: shoreHighlights.map(shoreCfi),
      // Where the shelf says the EPUB was left: the start of the paragraph the
      // first visible highlights sit in.
      epubPosition: `epubcfi(/6/6!/4/${6 + 2 * 2}/1:0)`,
      pdf: marks,
      pdfFigurePage: 2,
    },
    null,
    2,
  ) + "\n",
);
console.log("fixtures written to", here);
