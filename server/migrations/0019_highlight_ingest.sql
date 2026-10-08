-- Highlight ingest for external clients (an e-reader, a Kobo script, a share
-- extension). They send structured highlights; the server turns them into page
-- content, because producing a Yjs update requires BlockNote and Yjs and no such
-- client should have to carry an editor to append a sentence.
--
-- Neither table stores the highlight text. The page is the single source of truth
-- for anything a human can edit, and a second copy would drift the moment someone
-- rewrites a quote in the editor. These exist to answer two questions only: which
-- page belongs to which book, and which highlights already landed.
create table ingested_books (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    document_id  uuid not null references documents(id) on delete cascade,
    -- Client-chosen identity: an ISBN, or a hash of the file for a sideloaded
    -- EPUB. The server never sees the book, so it cannot derive this itself.
    source_key   text not null,
    title        text not null,
    author       text,
    created_at   timestamptz not null default now(),
    unique (workspace_id, source_key)
);

-- The idempotency ledger. CRDT appends are not idempotent, so a client retrying
-- after a dropped response would otherwise duplicate the whole batch. The unique
-- constraint is what makes this hold under concurrent requests; a check-then-insert
-- would not.
create table ingested_highlights (
    id         uuid primary key default gen_random_uuid(),
    book_id    uuid not null references ingested_books(id) on delete cascade,
    -- Generated once by the client and stable for the life of the highlight. A
    -- client that re-derives this per sync (from a content hash, say) defeats the
    -- ledger and duplicates everything the first time a note is edited.
    client_id  text not null,
    -- Opaque here: {cfi, spine} for EPUB, {page, quads} for PDF later. The server
    -- never parses it, so a new locator format needs no migration.
    locator    jsonb,
    created_at timestamptz not null default now(),
    unique (book_id, client_id)
);

create index ingested_highlights_book_idx on ingested_highlights (book_id);
