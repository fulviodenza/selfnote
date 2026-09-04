-- Task metadata for documents promoted to tasks (1:1 with documents).
-- A document is a "task" iff a row exists here; deleting the row demotes it.
create table document_tasks (
    doc_id       uuid primary key references documents(id) on delete cascade,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    status       text not null default 'todo'
                     check (status in ('todo', 'in_progress', 'done')),
    priority     text not null default 'none'
                     check (priority in ('none', 'low', 'medium', 'high')),
    -- Due instant. When due_all_day is true only the date part is meaningful
    -- (rendered as an all-day event in ICS); the time component is ignored.
    due_at       timestamptz,
    due_all_day  boolean not null default false,
    completed_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index document_tasks_workspace_due_idx
    on document_tasks (workspace_id, due_at);
create index document_tasks_workspace_status_idx
    on document_tasks (workspace_id, status);

-- Opaque bearer token that lets an external calendar client pull a workspace's
-- ICS feed without a login. Only the SHA-256 hash is stored; the plaintext
-- ("cal_…") is embedded in the returned feed URL and shown once. Rotating =
-- delete + re-create (invalidates the old URL).
create table calendar_feed_tokens (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    token_hash   text not null unique,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz
);
create index calendar_feed_tokens_workspace_idx
    on calendar_feed_tokens (workspace_id);
