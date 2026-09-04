/**
 * Obsidian vault importer (client-side).
 *
 * A vault is a folder of Markdown files (nested folders, YAML frontmatter,
 * [[wiki-links]], ![[embeds]]). This mirrors the folder hierarchy onto Selfnote's
 * page tree, uploads image assets, converts each note's Markdown to Yjs content,
 * and resolves wiki-links to internal page links.
 */
import { api } from "./api";
import { createImporter } from "@selfnote/editor";

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

const basename = (p: string) => p.split("/").pop() ?? p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const stripExt = (p: string) => p.replace(/\.md$/i, "");
const noteKey = (name: string) => stripExt(basename(name)).trim().toLowerCase();

/** Drop the shared top-level vault folder from every path. */
function stripVaultRoot(paths: string[]): (p: string) => string {
  if (paths.length === 0) return (p) => p;
  const firsts = new Set(paths.map((p) => p.split("/")[0]));
  const prefix = firsts.size === 1 ? `${[...firsts][0]}/` : "";
  return (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
}

function parseFrontmatter(text: string, fallbackTitle: string): { title: string; body: string } {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = text.slice(3, end);
      const body = text.slice(end + 4).replace(/^\r?\n/, "");
      const m = fm.match(/^\s*title\s*:\s*(.+?)\s*$/im);
      const title = m ? m[1].replace(/^["']|["']$/g, "") : fallbackTitle;
      return { title, body };
    }
  }
  return { title: fallbackTitle, body: text };
}

/** Replace ![[embed]] and ![](path) image refs with uploaded URLs. */
function replaceEmbeds(md: string, assetUrl: Map<string, string>): string {
  // Obsidian embeds: ![[image.png]] or ![[image.png|200]]
  md = md.replace(/!\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
    const name = inner.split("|")[0].trim();
    const url = assetUrl.get(name.toLowerCase()) ?? assetUrl.get(basename(name).toLowerCase());
    return url ? `![](${url})` : "";
  });
  // Standard images: ![alt](path) — swap local paths for uploaded URLs.
  md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt: string, path: string) => {
    const clean = decodeURIComponent(path.split(" ")[0]);
    const url = assetUrl.get(clean.toLowerCase()) ?? assetUrl.get(basename(clean).toLowerCase());
    return url ? `![${alt}](${url})` : m;
  });
  return md;
}

/** Resolve [[wiki-links]] to internal page links (or plain text if unknown). */
function replaceWikiLinks(md: string, noteId: Map<string, string>): string {
  return md.replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
    const [targetRaw, aliasRaw] = inner.split("|");
    const target = targetRaw.split("#")[0].trim();
    const alias = (aliasRaw ?? target).trim();
    const id = noteId.get(noteKey(target));
    // Internal note references use the `selfnote:<id>` scheme so link extraction
    // reports them to `PUT /documents/:id/links` and clicks route in-app.
    return id ? `[${alias}](selfnote:${id})` : alias;
  });
}

export async function importObsidianVault(
  fileList: File[],
  workspaceId: string,
  onProgress: (p: ImportProgress) => void,
): Promise<{ pages: number }> {
  const importer = createImporter();
  const rel = stripVaultRoot(fileList.map((f) => f.webkitRelativePath || f.name));
  const entries = fileList.map((f) => ({ file: f, path: rel(f.webkitRelativePath || f.name) }));

  const mdFiles = entries.filter((e) => /\.md$/i.test(e.path));
  const assetFiles = entries.filter((e) => IMAGE_EXT.test(e.path));
  const total = assetFiles.length + mdFiles.length * 2;
  let done = 0;
  const tick = (label: string) => onProgress({ done, total, label });

  // 1. Upload image assets.
  const assetUrl = new Map<string, string>();
  for (const a of assetFiles) {
    tick(`Uploading ${basename(a.path)}`);
    try {
      const url = await api.uploadFile(workspaceId, a.file);
      assetUrl.set(a.path.toLowerCase(), url);
      assetUrl.set(basename(a.path).toLowerCase(), url);
    } catch {
      /* skip a failed asset, keep importing */
    }
    done++;
  }

  // 2. Create a page for every folder (shallowest first) so children can attach.
  const folderPage = new Map<string, string | null>([["", null]]);
  const folders = new Set<string>();
  for (const m of mdFiles) {
    const parts = dirname(m.path) ? dirname(m.path).split("/") : [];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      folders.add(acc);
    }
  }
  for (const folder of [...folders].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const parentId = folderPage.get(dirname(folder)) ?? null;
    const doc = await api.createDocument(workspaceId, parentId, basename(folder));
    folderPage.set(folder, doc.id);
  }

  // 3. Create a page per note, remembering names for wiki-link resolution.
  const noteId = new Map<string, string>();
  const pages: { docId: string; path: string; body: string }[] = [];
  for (const m of mdFiles) {
    tick(`Creating ${basename(m.path)}`);
    const text = await m.file.text();
    const { title, body } = parseFrontmatter(text, stripExt(basename(m.path)));
    const parentId = folderPage.get(dirname(m.path)) ?? null;
    const doc = await api.createDocument(workspaceId, parentId, title);
    noteId.set(noteKey(m.path), doc.id);
    noteId.set(title.toLowerCase(), doc.id);
    pages.push({ docId: doc.id, path: m.path, body });
    done++;
  }

  // 4. Convert Markdown → Yjs content and seed each page.
  for (const p of pages) {
    tick(`Importing ${basename(p.path)}`);
    let md = replaceEmbeds(p.body, assetUrl);
    md = replaceWikiLinks(md, noteId);
    try {
      const update = await importer.toUpdateBase64(md);
      await api.setContent(p.docId, update);
    } catch {
      /* leave the page empty if conversion fails */
    }
    done++;
  }

  onProgress({ done: total, total, label: "Done" });
  return { pages: pages.length };
}
