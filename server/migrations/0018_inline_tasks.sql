-- One task model for pages and for text inside a page.
--
-- document_tasks was a 1:1 sidecar keyed by doc_id, so a page either was a task
-- or was not. That does not match how notes get written: a meeting note is not
-- itself a task, it contains several. Tasks now have their own identity and a
-- provenance:
--
--   block_id is null      the page itself is the task (what document_tasks was)
--   block_id is not null  the task is anchored to one block inside the page
--
-- The anchor lives in the note's CRDT, as a prop on a `taskItem` block, so it
-- survives concurrent edits by construction: wherever the block ends up is
-- where the task is. block_id here is for lookup and uniqueness, not the
-- authoritative anchor. Task state stays entirely in this table, never in the
-- block, so the server never has to write into a document to change a status.
create table tasks (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    doc_id       uuid not null references documents(id) on delete cascade,
    block_id     text,
    -- Cached text of the anchored block, so the board can list tasks without
    -- opening any document. Page tasks read documents.title instead and leave
    -- this empty. Refreshed by whichever client is editing; see below.
    title        text not null default '',
    status       text not null default 'todo'
                     check (status in ('todo', 'in_progress', 'done')),
    priority     text not null default 'none'
                     check (priority in ('none', 'low', 'medium', 'high')),
    -- Due instant. When due_all_day is true only the date part is meaningful
    -- (rendered as an all-day event in ICS); the time component is ignored.
    due_at       timestamptz,
    due_all_day  boolean not null default false,
    completed_at timestamptz,
    -- Set when the anchoring block is gone from the document, which only a
    -- client can observe: the server never parses CRDT content. A detached task
    -- stays on the board wearing a badge rather than being deleted, because the
    -- block may come back through an undo, and because silently discarding
    -- someone's task is the worse failure.
    detached_at  timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- Preserves the old one-task-per-page invariant, and gives the existing
-- promote-a-page upsert something to conflict against.
create unique index tasks_page_unique
    on tasks (doc_id) where block_id is null;
-- One task per anchoring block.
create unique index tasks_block_unique
    on tasks (doc_id, block_id) where block_id is not null;

create index tasks_workspace_status_idx on tasks (workspace_id, status);
create index tasks_workspace_due_idx    on tasks (workspace_id, due_at);
-- The board filters by page and its subtree, and the editor loads one page's
-- tasks on open.
create index tasks_doc_idx              on tasks (doc_id);

-- Every existing page task becomes a task with no block. Nothing is lost and
-- nothing moves: the ICS feed keys page tasks on doc_id, so calendars that
-- already subscribed keep matching their events instead of duplicating them.
insert into tasks (workspace_id, doc_id, block_id, status, priority,
                   due_at, due_all_day, completed_at, created_at, updated_at)
select workspace_id, doc_id, null, status, priority,
       due_at, due_all_day, completed_at, created_at, updated_at
from document_tasks;

drop table document_tasks;
