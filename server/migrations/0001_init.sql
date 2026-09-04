-- Selfnote initial schema.
-- Metadata + auth live in normal relational tables; document *content* lives in the
-- append-only Yjs update log (doc_updates) compacted into doc_snapshots.

create extension if not exists "pgcrypto";

create table users (
    id            uuid primary key default gen_random_uuid(),
    email         text unique not null,
    password_hash text not null,
    display_name  text not null default '',
    created_at    timestamptz not null default now()
);

create table workspaces (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    owner_id   uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now()
);

create table workspace_members (
    workspace_id uuid not null references workspaces(id) on delete cascade,
    user_id      uuid not null references users(id) on delete cascade,
    role         text not null check (role in ('owner', 'admin', 'editor', 'viewer')),
    created_at   timestamptz not null default now(),
    primary key (workspace_id, user_id)
);

-- The page tree: parent_id nests pages within a workspace.
create table documents (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    parent_id    uuid references documents(id) on delete cascade,
    title        text not null default 'Untitled',
    icon         text,
    archived     boolean not null default false,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index documents_workspace_idx on documents (workspace_id);
create index documents_parent_idx on documents (parent_id);

-- Per-document permission overrides (beyond workspace membership).
create table permissions (
    doc_id  uuid not null references documents(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    role    text not null check (role in ('editor', 'viewer')),
    primary key (doc_id, user_id)
);

-- Public / link shares.
create table shares (
    id         uuid primary key default gen_random_uuid(),
    doc_id     uuid not null references documents(id) on delete cascade,
    mode       text not null check (mode in ('rw', 'ro')) default 'ro',
    expires_at timestamptz,
    created_at timestamptz not null default now()
);

-- Append-only CRDT update log.
create table doc_updates (
    id         bigserial primary key,
    doc_id     uuid not null references documents(id) on delete cascade,
    update     bytea not null,
    created_at timestamptz not null default now()
);
create index doc_updates_doc_idx on doc_updates (doc_id, id);

-- Compacted state: snapshot + the id of the last update folded into it.
create table doc_snapshots (
    doc_id         uuid primary key references documents(id) on delete cascade,
    snapshot       bytea not null,
    last_update_id bigint not null default 0,
    updated_at     timestamptz not null default now()
);

create table files (
    id           uuid primary key default gen_random_uuid(),
    doc_id       uuid references documents(id) on delete set null,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    s3_key       text not null,
    mime         text not null,
    size         bigint not null,
    created_at   timestamptz not null default now()
);

-- Hashed refresh tokens for session renewal.
create table refresh_tokens (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    token_hash text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index refresh_tokens_user_idx on refresh_tokens (user_id);
