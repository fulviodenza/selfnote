# Selfnote eReader support

Selfnote eReader is a local-first EPUB reader for iPhone and iPad. It is part of
[Selfnote](https://github.com/fulviodenza/selfnote), and its full source is in this
repository under `apps/ereader`.

## Get help

- **Something is broken, or you want a feature:**
  [open an issue](https://github.com/fulviodenza/selfnote/issues/new). Please say which
  device and iOS version you are on, and what you did just before the problem.
- **A specific book will not open:** include the book's file size and where you got it
  from. Do not attach the book itself if it is not freely redistributable.

## Frequently asked

**Which files can I read?**
EPUB only. PDFs and audiobooks are not supported. Books with DRM (anything bought from a
store that locks its files) cannot be opened by any app other than that store's own.

**How do I add a book?**
Tap "Add an EPUB" and pick the file. It can come from Files, iCloud Drive, or any other
source the iOS document picker can reach. The app copies the file into its own storage,
so the book keeps working even if you later move or delete the original.

**How do I turn pages?**
Tap the left third of the page to go back, the right third to go forward. On an iPad in
landscape you get two pages side by side.

**How do I highlight a passage?**
Select the text. The highlight is saved as soon as the selection ends. Tap an existing
highlight to see it again, with the option to remove it.

**Does it remember my place?**
Yes. Each book reopens on the page you left, and the percentage in the top bar is
measured across the whole book rather than the current chapter.

**Where is my data?**
In a SQLite database inside the app's own container on your device. Books, highlights,
and reading positions never leave it: the app makes no network requests, has no account
system, and collects no analytics. Scripts inside books are disabled, so a book cannot
run code or call home either.

**Does it sync between my devices?**
Not in this version. Highlights are stored with a sync field reserved for a future
optional Selfnote server, but nothing is sent anywhere today.

**How do I get my highlights out?**
Export is not built yet. If you want it, say so on the issue tracker.

**How do I remove a single book from my library?**
Not yet possible in this version. You can remove individual highlights by tapping them.

**How do I delete everything?**
Delete the app. Its container, including every book and highlight, goes with it. There is
no copy anywhere else.

## Privacy

Selfnote eReader collects nothing and transmits nothing. See the
[privacy policy](./ereader-privacy.md).
