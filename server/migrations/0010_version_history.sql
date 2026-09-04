-- Immutable point-in-time snapshots of a document's CRDT state, powering the
-- version-history / time-travel UI. Independent of doc_snapshots (which is a
-- single mutable compaction row) so history survives log pruning.
create table doc_checkpoints (
    id           uuid primary key default gen_random_uuid(),
    doc_id       uuid not null references documents(id) on delete cascade,
    -- Full document state as a single merged v1 Yjs update (bytea).
    snapshot     bytea not null,
    -- Size of the snapshot in bytes (denormalized for cheap listing).
    size_bytes   bigint not null,
    -- 'manual' = user pressed "Save version"; 'auto' = periodic/on-drop capture;
    -- 'restore' = checkpoint captured immediately before a restore was applied.
    kind         text not null check (kind in ('manual', 'auto', 'restore')),
    -- Optional user-supplied name; null for auto checkpoints.
    label        text,
    -- Author of the change/checkpoint; null for system-generated auto captures.
    created_by   uuid references users(id) on delete set null,
    created_at   timestamptz not null default now()
);
-- List newest-first per document.
create index doc_checkpoints_doc_idx on doc_checkpoints (doc_id, created_at desc);
