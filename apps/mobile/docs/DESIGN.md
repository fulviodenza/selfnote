# Selfnote Mobile — Design System & Feel

> Requirement document for the mobile UI. Implementation must treat this as the
> spec. Companion: `FEATURES.md` (what we build), this file (how it looks & feels).

## 1. What this app is, and how it should feel

Selfnote is a **private, self-hosted thinking space** — your documents, on your
own server, syncing live. The mobile client is where you capture a thought on the
move and where you read back what you (or you-on-the-laptop) wrote. It is not a
team SaaS dashboard and should not feel like one.

The feel we are after, in three words: **calm, tactile, yours.**

- **Calm** — the content is the interface. Chrome recedes; the page you're writing
  is the brightest, most present thing on screen. No decorative gradients, no
  cards-within-cards, nothing competing with the words.
- **Tactile** — every control is unmistakably pressable and answers the finger.
  Generous, consistent hit areas; a real press state (the surface depresses/tints
  the instant you touch it); nothing that makes you aim.
- **Yours** — a quiet confidence that this is a personal instrument, not a rented
  one. The one place we spend personality is **typography** — this is a writing
  tool, so the lettering is authored, not stock.

Anti-goals (things this design explicitly avoids): the SaaS card kit (everything
chopped into identical rounded cards with the same soft shadow), all-caps eyebrow
labels, gradient washes as decoration, a `→` glued onto button text, and the
warm-cream/terracotta/serif look that reads as generated.

## 2. Signature idea — spend boldness on the page and the type

One bold move, everything else disciplined:

**The document is the hero, and typography carries the identity.** Document titles
and the reading surface are set in a real text serif (authored, book-like); the
controls and metadata are a clean, slightly technical sans (the "instrument"
around the writing). That contrast — warm serif content inside cool sans chrome —
is the whole personality. We do not also add an accent-color gimmick, decorative
motion, or ornamental structure. Chanel's rule: take one thing off.

## 3. Design tokens

### 3.1 Color — "Ink & Paper"

A near-neutral system so the writing is the color. One confident interactive hue;
everything else is ink, paper, and hairlines. Semantic status colors are reserved
strictly for sync state (a core concept), never for decoration.

| Token            | Hex       | Role |
|------------------|-----------|------|
| `paper`          | `#F3F3F0` | App background. Warm-neutral, a hair off pure grey — calm, not clinical. Deliberately **not** cream (`#F4F1EA`). |
| `surface`        | `#FFFFFF` | The editor and any sheet the user reads/writes on — the brightest plane. |
| `surfaceSunken`  | `#ECECE8` | Pressed row background, input wells. |
| `ink`            | `#1B1D22` | Primary text — an intentional slate "ink", warmer and softer on paper than pure black. |
| `inkSoft`        | `#606670` | Secondary text, metadata, placeholder. |
| `inkFaint`       | `#9A9EA6` | Disabled text, tertiary hints. |
| `hairline`       | `#E2E1DC` | 1px dividers and borders. Warm, low-contrast. |
| `accent`         | `#2B44C7` | The single interactive hue: primary buttons, focus ring, active nav, links, cursor. Confident cobalt-indigo. |
| `accentPressed`  | `#22369E` | Accent, pressed. |
| `accentWash`     | `#EAEDFB` | Accent at ~8% — selected row, subtle highlight behind active items. |
| `live`           | `#1F9E6A` | Sync status: connected. Semantic only. |
| `warn`           | `#C1841E` | Sync status: connecting. |
| `danger`         | `#C4392B` | Sync status: disconnected; destructive actions. |

Dark mode (Phase 2 of the design rollout): `paper #17181C`, `surface #202228`,
`ink #ECECEA`, `hairline #2E3037`, `accent #7C8CF8`, statuses lightened one step.
Tokens are defined once so dark mode is a value swap, not a rewrite.

### 3.2 Typography

Two families, clearly distinct, each doing one job:

- **Content / titles — `Newsreader`** (or `Source Serif 4` as fallback): a text
  serif designed for screens. Used for document titles, the doc-list entries, and
  (where we control it) the editor body. This is the "authored" voice.
- **Controls / UI — `Inter Tight`** (or system sans fallback): a compact,
  slightly technical grotesk for buttons, labels, metadata, settings. The
  "instrument" voice. (Plain `Inter` is a tell; `Inter Tight`'s tighter set and
  narrower forms read as a deliberate UI face.)

Implementation may ship system fonts first and adopt the bundled pair via
`expo-font`; the *roles and scale* below are binding regardless of the exact face.

Type scale (Elements-of-Typographic-Style-derived; sizes in px, RN `fontSize`):

| Role            | Family        | Size / Line | Weight | Notes |
|-----------------|---------------|-------------|--------|-------|
| Screen title    | Newsreader    | 28 / 34     | 600    | e.g. the "selfnote" wordmark, section headers |
| Doc title (row) | Newsreader    | 18 / 24     | 500    | list entries, editor topbar title |
| Body            | Inter Tight   | 16 / 24     | 400    | default UI text, inputs |
| Button          | Inter Tight   | 16 / 20     | 600    | never smaller than 16 |
| Label           | Inter Tight   | 14 / 18     | 500    | field labels (sentence case, never ALL CAPS) |
| Meta            | Inter Tight   | 13 / 16     | 400    | timestamps, server URL, counts — `inkSoft` |

Rules: sentence case everywhere (no ALL-CAPS labels). Body/line length in the
editor capped for readability. Don't accent a single word in a heading. No
mono face for labels.

### 3.3 Spacing, radius, elevation, motion

- **Spacing scale** (px): `4, 8, 12, 16, 20, 24, 32, 48`. Screen gutter = 20.
  Vertical rhythm between stacked controls = 12; between sections = 24.
- **Radius**: `sm 8` (inputs, small chips), `md 12` (buttons, sheets), `lg 20`
  (FAB, large sheets), `full 999` (status dot, avatar). One radius does **not**
  fit all — hierarchy comes partly from radius.
- **Elevation**: avoid the uniform grey drop-shadow on everything. Use **hairline
  borders** to separate, not shadows. Reserve a single soft shadow for genuinely
  floating things (FAB, active sheet): `y2 blur12 rgba(20,22,28,0.10)`.
- **Motion**: only in response to the user. Press-state tint/scale is instant
  (≤100ms). Sheet open/close: 220ms ease-out. No autoplay entrances on lists.
  Respect reduce-motion (no scale animations when enabled).

## 4. Touch targets & control sizing (the load-bearing section)

Buttons must be **large enough to hit without aiming, without being oversized
and childish.** Concrete, binding rules:

- **Minimum touch target: 48×48 px** for any interactive element (Apple HIG says
  44, Material says 48 — we take the larger). If the *visual* control is smaller
  (e.g. a 24px icon), it still gets a 48px hit slop.
- **Primary button height: 52 px.** Full-width within the 20px gutter. Radius
  `md 12`. Text 16/600. This is the comfortable-thumb size — substantial, not
  bulky.
- **Secondary / row-level button height: 48 px.**
- **Icon button: 44px visual circle inside a 48px hit area.** Gear, back, add.
- **List/tree row min height: 56 px** (a full document row is a primary target;
  it should feel like a generous line to tap). Row press tints the whole row
  `surfaceSunken`.
- **FAB (new document): 56 px tall pill**, floating above the list with the one
  allowed shadow, inset 20 from edges and 24 from bottom (respecting the safe
  area / gesture bar).
- **Input height: 52 px**, 16px inner padding, radius `sm 8`, 1px `hairline`
  border that becomes 1.5px `accent` on focus (visible keyboard focus is part of
  the quality floor).
- **Spacing between adjacent targets: ≥ 8 px** so fingers don't hit two things.
- **Text never below 13px**; interactive text never below 16px.

Every pressable uses a real press state (opacity is not enough): background tint
to `surfaceSunken` (neutral controls) or `accentPressed` (accent buttons), applied
on `pressIn` with no delay. Disabled = `inkFaint` text on flat surface, no border.

## 5. Component specs

**Buttons**
- *Primary* — accent fill, white text, 52h, radius 12, full-width. One per screen
  (the main action). Label is the literal outcome: "Sign in", "Create page".
- *Secondary* — `surface` fill, 1px `hairline`, `ink` text, 48h. For secondary
  actions ("Cancel", "Log out").
- *Ghost / link* — accent text, no fill, 48h hit area. Inline navigational
  actions ("Need an account? Register").
- *Icon* — 44 circle / 48 hit. Neutral by default; accent when active.
- *Destructive* — `danger` text (ghost) or `danger` fill only for irreversible
  confirmed actions.

**Document row (list & tree)**
- 56h min, 20 gutter, title in Newsreader 18/500.
- Hierarchy: indent 20px per depth level; a parent shows a small chevron
  (`▸` collapsed / `▾` expanded) as a **28px tap target** that toggles collapse
  without opening the page. Tapping the title opens the page.
- Trailing `＋` (icon button, 48 hit) creates a subpage.
- Selected/open row: `accentWash` background, accent left-edge bar 3px.

**Topbar (editor)**
- 56h. Back as an icon+label ghost button on the left ("‹ Docs"), document title
  centered/left in Newsreader, sync status dot on the right.
- **Sync status**: a `full` 10px dot + a 13px `inkSoft` word ("Live", "Syncing…",
  "Offline"). Color from the semantic tokens. The word matters — a bare dot is a
  puzzle; label it.

**Inputs** — 52h, label above in 14/500 sentence case, `inkSoft` placeholder,
focus ring as described. Errors: 13px `danger` text below the field, plus the
border turns `danger`; the message says what to do ("Enter a valid email").

**Sheets / modals (Settings)** — slide up from bottom, `surface`, radius `lg 20`
top corners, grabber affordance, one soft shadow. Close is an icon button
top-right (48 hit).

**Empty & error states** — never a bare blank. Empty doc list: a short serif line
("Nothing here yet.") + one primary action ("Create your first page"). Errors are
directive and in the app's voice, never an apology or a raw code.

**Toast** — bottom, above the FAB, `ink` surface, white text, 3s auto-dismiss;
used for confirmations that don't need a modal ("Copied link", "Saved offline").

## 6. Screen application

- **Auth** — wordmark "selfnote" in Newsreader 28 as the hero (the one bold type
  moment), one calm sentence of orientation, two inputs, one primary button, one
  ghost toggle, the server URL as quiet meta at the bottom, a gear to Settings.
  Centered vertically, left-aligned fields.
- **Document list** — the topbar is minimal ("Documents", gear, "Log out" as a
  ghost). The list is the page: generous 56h rows, the serif titles doing the
  work, tree indentation, the FAB floating. This screen should feel like opening a
  notebook's table of contents.
- **Editor** — chrome shrinks to the 56h topbar; the WebView writing surface is
  `surface` and fills everything. This is the brightest, calmest screen.
- **Settings** — a bottom sheet: two labelled inputs (API URL, Sync URL), a
  primary "Save", the defaults shown as meta. Plain, honest, quick.

## 7. Quality floor (non-negotiable)

Responsive to small phones; visible keyboard/focus states; reduce-motion
respected; color contrast AA for text (`ink`/`inkSoft` on `paper`/`surface` all
pass); every interactive element has an accessibilityLabel and ≥48px target;
loading states never block the whole screen with a bare spinner where a skeleton
or inline indicator would keep context.

## 8. Implementation notes

- Centralize tokens in `apps/mobile/src/theme.ts` (colors, spacing, radius, type,
  and a `hitSlop` helper). No hard-coded hex or magic numbers in components —
  everything references the theme. This is what makes dark mode and future tuning
  a value change, not a refactor.
- Add a small set of primitives — `Button`, `IconButton`, `Input`, `Row`,
  `Screen`, `StatusDot` — so sizing/press-state rules are enforced in one place
  and every screen composes them. This is the mechanism that makes "buttons are
  the right size" true everywhere by construction.
- Press feedback via `Pressable`'s `style`/`children` callback reading `pressed`;
  never rely on default opacity alone.
- Fonts: begin with system fallbacks mapped to the two roles; adopt `Newsreader`
  + `Inter Tight` via `expo-font` once the primitives land.
