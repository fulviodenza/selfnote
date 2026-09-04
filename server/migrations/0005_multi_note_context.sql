-- Multi-note context: explicit note-to-note links + a per-user recently-viewed log.

-- Directed link from one document to another (e.g. an @-mention / inline ref in
-- the editor). The editor upserts these; the AI chat reads them to offer "linked
-- notes" as extra context. Self-links are disallowed.
create table document_links (
    src_doc_id uuid not null references documents(id) on delete cascade,
    dst_doc_id uuid not null references documents(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (src_doc_id, dst_doc_id),
    check (src_doc_id <> dst_doc_id)
);
create index document_links_src_idx on document_links (src_doc_id);
create index document_links_dst_idx on document_links (dst_doc_id);

-- Per-user recently-viewed notes, one row per (user, document). Upserted on open;
-- `viewed_at` bumped each visit. Trimmed to a bounded window by the API on write.
create table recent_documents (
    user_id   uuid not null references users(id) on delete cascade,
    doc_id    uuid not null references documents(id) on delete cascade,
    viewed_at timestamptz not null default now(),
    primary key (user_id, doc_id)
);
create index recent_documents_user_idx on recent_documents (user_id, viewed_at desc);
