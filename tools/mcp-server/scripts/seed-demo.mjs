#!/usr/bin/env node
// A believable demo workspace on a local Selfnote instance, for the mobile
// app's App Store screenshots (apps/mobile/scripts/appstore-shots.mjs).
//
//   node scripts/seed-demo.mjs <apiUrl> <email> <password>
//
// It lives here rather than in apps/mobile because note bodies have to be
// written the way this package writes them: Markdown to BlockNote blocks with
// the clients' callout schema, then a minimal Yjs diff through
// y-prosemirror's updateYFragment (dist/edit.js), pushed with
// POST /documents/:id/content. Everything else goes through the public REST API
// too: register or log in, workspace, pages, icons, labels, links and tasks.
//
// Reruns are safe: a page that already exists by title keeps its content and
// tasks, and labels and links are set as full replaces.
import { docToBlockOutline, markdownToBlocks, replaceBlocksDiff } from "../dist/edit.js";

const [apiUrl, email, password] = process.argv.slice(2);
if (!apiUrl || !email || !password) {
  console.error("usage: seed-demo.mjs <apiUrl> <email> <password>");
  process.exit(2);
}
const base = apiUrl.replace(/\/+$/, "");
let token = null;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? undefined : res.json();
}

/* ------------------------------------------------------------- content --- */

const DAY = 86400000;
const today = new Date();
today.setHours(0, 0, 0, 0);
/** A due date `days` from today at `hour` local time, as the API wants it. */
const due = (days, hour = 9) => new Date(today.getTime() + days * DAY + hour * 3600000).toISOString();

// Page bodies reference each other as [text](@Title); the seeder swaps in the
// app's selfnote:<id> note-reference href once every page exists.
const PAGES = [
  {
    title: "Weekly plan",
    icon: "🗓️",
    labels: ["Personal"],
    md: `## Focus this week

Ship the first round of the [website relaunch](@Website relaunch), keep the evenings for the [Lisbon trip](@Lisbon trip checklist) prep.

- [x] Book the dentist for Thursday
- [x] Review the kickoff notes from [Monday's sync](@Website relaunch kickoff)
- [ ] Draft the new pricing page copy
- [ ] Bake the [focaccia](@Focaccia) for Saturday's dinner
- [ ] Send the invoice to Studio Nord
- [ ] Call the bank about the travel card

## Habits

- Read 30 minutes before bed
- Three runs: Monday, Wednesday, Saturday
- No screens after 22:00`,
    tasks: [
      // Late in the day, so it still reads as due today whenever the run happens.
      { match: "Draft the new pricing page copy", status: "in_progress", priority: "high", due: due(0, 23.5) },
      { match: "Bake the focaccia", status: "todo", priority: "medium", due: due(1, 18) },
      { match: "Send the invoice", status: "todo", priority: "high", due: due(3) },
      { match: "Call the bank", status: "todo", priority: "low", due: due(-1, 11) },
    ],
  },
  {
    title: "Website relaunch kickoff",
    icon: "💬",
    labels: ["Work", "Meetings"],
    md: `**Attendees:** Ana, Marco, Priya, Tom

**Project:** [Website relaunch](@Website relaunch)

> [!IMPORTANT]
> Launch date is locked for November 18. Anything not ready by the 4th moves to the follow-up release.

## Decisions

- The homepage leads with the product tour, not the pricing table
- One sign-up flow for web and mobile, email first
- Blog moves to the new design in the second release

## Open questions

- Do we keep the old docs URLs or redirect everything?
- Who owns the launch email and the changelog post?

## Action items

- [ ] Priya: first homepage mockups by Wednesday
- [ ] Marco: redirect map for the docs pages
- [ ] Tom: analytics plan and the events we need
- [x] Ana: share the brand guidelines folder`,
    tasks: [
      { match: "Priya: first homepage mockups", status: "in_progress", priority: "high", due: due(2, 12) },
      { match: "Marco: redirect map", status: "todo", priority: "medium", due: due(5) },
      { match: "Tom: analytics plan", status: "todo", priority: "low", due: due(8) },
    ],
  },
  {
    title: "Website relaunch",
    icon: "🚀",
    labels: ["Work"],
    md: `A faster, calmer website that explains the product in one scroll.

## Goals

1. Halve the time to first sign-up
2. One design system shared with the apps
3. Pages that load in under a second on a phone

## Milestones

- **October 20:** homepage and pricing in review
- **November 4:** content freeze
- **November 18:** launch

## Notes

Meeting log lives in [Website relaunch kickoff](@Website relaunch kickoff). Ideas that did not make the cut go to the [ideas inbox](@Ideas inbox).`,
    tasks: [{ page: true, status: "in_progress", priority: "high", due: due(39) }],
  },
  {
    title: "Reading notes: The Quiet Shore",
    icon: "📖",
    labels: ["Reading"],
    md: `*Maren Ashdown*, read in October.

## Themes

- Coming home to a place that kept changing while you were away
- Tides as a clock the whole village lives by
- Small rituals holding a family together

## Lines worth keeping

> The sea did not wait for anyone, which is why everyone in the village had learned to.

> She kept the lamp lit long after the boats came in, out of habit, or out of hope.

## Thoughts

A slow first half that pays off. The lighthouse chapters would make a good short story on their own. Added two ideas to the [inbox](@Ideas inbox).`,
  },
  {
    title: "Focaccia",
    icon: "🍞",
    labels: ["Recipes"],
    md: `Overnight focaccia for a 30 x 40 cm tray. Serves 8.

## Ingredients

- 500 g bread flour
- 400 g water, lukewarm
- 10 g salt
- 3 g dry yeast
- 60 g olive oil, plus more for the tray
- Flaky salt, rosemary, cherry tomatoes

## Method

1. Mix flour, water and yeast. Rest 20 minutes, then add the salt.
2. Four sets of stretch and folds, 30 minutes apart.
3. Cover and refrigerate overnight, 12 to 18 hours.
4. Oil the tray generously, tip in the dough and let it rise 3 hours.
5. Dimple with oiled fingers, top, and bake at 230 °C for 22 minutes.

> [!TIP]
> Brine before baking: whisk 20 g water, 20 g oil and a pinch of salt and pour it into the dimples. That is where the crisp top comes from.`,
  },
  {
    title: "Lisbon trip checklist",
    icon: "✈️",
    labels: ["Travel", "Personal"],
    md: `November 21 to 25. Flight TP 1235, seat 14A.

## Before leaving

- [x] Book the apartment in Alfama
- [x] Flights and seat selection
- [ ] Passport photo and renewal
- [ ] Travel card and some cash
- [ ] Download offline maps

## Packing

- [ ] Rain jacket
- [ ] Walking shoes
- [ ] Charger and adapter
- [ ] Camera and a spare battery

## Places

- Miradouro da Senhora do Monte at sunset
- Pastéis in Belém, early before the queue
- Day trip to Sintra on Saturday`,
    tasks: [
      { match: "Passport photo and renewal", status: "todo", priority: "high", due: due(4) },
      { match: "Download offline maps", status: "todo", priority: "low", due: due(10) },
    ],
  },
  {
    title: "Ideas inbox",
    icon: "💡",
    labels: ["Ideas"],
    md: `Unsorted. Review on Sundays.

- A lighthouse short story, from the [reading notes](@Reading notes: The Quiet Shore)
- Weekly photo walk, one neighbourhood at a time
- A shared recipe book with the family
- Interactive pricing calculator for the [relaunch](@Website relaunch)
- Learn enough Portuguese to order dinner in [Lisbon](@Lisbon trip checklist)`,
  },
];

const LABEL_COLORS = {
  Personal: "#4f8a5b",
  Work: "#3b6fd8",
  Meetings: "#8b5cf6",
  Reading: "#c2410c",
  Recipes: "#d97706",
  Travel: "#0e7490",
  Ideas: "#db2777",
};

/* ---------------------------------------------------------------- seed --- */

async function signIn() {
  try {
    const r = await call("POST", "/auth/register", { email, password, display_name: "Demo" });
    token = r.access_token;
    console.log(`registered ${email}`);
  } catch (e) {
    if (e.status !== 409) throw e;
    token = (await call("POST", "/auth/login", { email, password })).access_token;
    console.log(`signed in as ${email}`);
  }
}

async function workspace() {
  const list = await call("GET", "/workspaces");
  if (list.length) return list[0].id;
  return (await call("POST", "/workspaces", { name: "Personal" })).id;
}

// The Markdown parser drops hrefs in schemes it does not know, so references go
// in under a placeholder https origin and are rewritten on the parsed blocks.
const PLACEHOLDER = "https://selfnote.invalid/";

/** Markdown with every [text](@Title) pointing at the page's placeholder URL. */
function resolveLinks(md, idByTitle) {
  return md.replace(/\[([^\]]+)\]\(@([^)]+)\)/g, (_, text, title) => {
    const id = idByTitle.get(title);
    if (!id) throw new Error(`link to an unknown page: ${title}`);
    return `[${text}](${PLACEHOLDER}${id})`;
  });
}

/** Placeholder links to the app's selfnote:<id> note references, in place. */
function toNoteRefs(blocks) {
  for (const b of blocks) {
    for (const c of Array.isArray(b.content) ? b.content : []) {
      if (c.type === "link" && c.href.startsWith(PLACEHOLDER)) {
        c.href = `selfnote:${c.href.slice(PLACEHOLDER.length)}`;
      }
    }
    toNoteRefs(b.children ?? []);
  }
  return blocks;
}

const linkTargets = (md) => [...md.matchAll(/\]\(@([^)]+)\)/g)].map((m) => m[1]);

async function main() {
  await signIn();
  const ws = await workspace();
  const existing = await call("GET", `/documents?workspace_id=${ws}`);
  const idByTitle = new Map();
  const fresh = new Set();
  for (const page of PAGES) {
    let doc = existing.find((d) => d.title === page.title && !d.parent_id);
    if (!doc) {
      doc = await call("POST", "/documents", { workspace_id: ws, parent_id: null, title: page.title });
      fresh.add(page.title);
    }
    if (page.icon && doc.icon !== page.icon) await call("PATCH", `/documents/${doc.id}`, { icon: page.icon });
    idByTitle.set(page.title, doc.id);
  }

  const labelIds = new Map();
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    labelIds.set(name, (await call("POST", `/workspaces/${ws}/labels`, { name, color })).id);
  }

  for (const page of PAGES) {
    const id = idByTitle.get(page.title);
    const md = resolveLinks(page.md, idByTitle);
    if (fresh.has(page.title)) {
      const { updates } = await call("GET", `/documents/${id}/content`);
      const update = replaceBlocksDiff(updates, toNoteRefs(await markdownToBlocks(md)));
      await call("POST", `/documents/${id}/content`, { update });

      const after = (await call("GET", `/documents/${id}/content`)).updates;
      const outline = await docToBlockOutline(after);
      for (const t of page.tasks ?? []) {
        const fields = { status: t.status, priority: t.priority, due_at: t.due, due_all_day: false };
        if (t.page) {
          await call("POST", `/documents/${id}/task`, fields);
          continue;
        }
        const block = outline.find((b) => b.type === "checkListItem" && b.text.startsWith(t.match));
        if (!block) throw new Error(`${page.title}: no checklist item starting "${t.match}"`);
        await call("POST", `/documents/${id}/tasks`, { block_id: block.id, title: block.text, ...fields });
      }
    }
    await call("PUT", `/documents/${id}/labels`, {
      label_ids: (page.labels ?? []).map((n) => labelIds.get(n)),
    });
    // The editor reports the same set when a page is opened; setting it here
    // gives the graph its edges before anyone has opened anything.
    const targets = [...new Set(linkTargets(page.md))];
    await call("PUT", `/documents/${id}/links`, {
      links: targets.map((title) => ({ target_id: idByTitle.get(title) })),
    });
  }
  console.log(
    `seeded ${PAGES.length} pages (${fresh.size} new) in workspace ${ws}`,
  );
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
