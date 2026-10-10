#!/usr/bin/env node
// Writes sitemap.xml for the static site: every HTML page, with lastmod taken
// from the file's last commit so a page that did not change keeps its date.
//
//   node scripts/sitemap.mjs        (from apps/website; commit the result)
//
// Kept as a committed file rather than generated in the image build so the
// sitemap is reviewable in the PR that changes the pages it lists.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const SITE = "https://selfnote.fulvio.dev";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SKIP = new Set(["50x.html", "og-card.html"]);

function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["assets", "scripts", "node_modules"].includes(name)) continue;
      out.push(...pages(p));
    } else if (name.endsWith(".html") && !SKIP.has(name)) {
      out.push(p);
    }
  }
  return out;
}

const urlOf = (file) => {
  const rel = relative(root, file);
  return SITE + "/" + (rel.endsWith("index.html") ? rel.slice(0, -"index.html".length) : rel);
};

const lastmod = (file) => {
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: root })
      .toString()
      .trim();
    if (iso) return iso.slice(0, 10);
  } catch {
    /* not a checkout: fall through */
  }
  return new Date().toISOString().slice(0, 10);
};

const entries = pages(root)
  .map((f) => ({ loc: urlOf(f), lastmod: lastmod(f) }))
  .sort((a, b) => a.loc.localeCompare(b.loc));

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
writeFileSync(join(root, "sitemap.xml"), xml);
console.log(`sitemap.xml: ${entries.length} pages`);
