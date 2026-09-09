-- Body-text search cache. Note content is an opaque Yjs CRDT, so full-text
-- search needs an extracted plain-text copy. Rows are refreshed lazily at
-- search time (bounded per query) whenever documents.updated_at moves past
-- document_texts.rendered_at — see labels/search handlers.

create table document_texts (
    document_id  uuid primary key references documents(id) on delete cascade,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    text         text not null default '',
    rendered_at  timestamptz not null default now()
);
create index document_texts_workspace_idx on document_texts (workspace_id);
create index document_texts_fts_idx
    on document_texts using gin (to_tsvector('english', text));
