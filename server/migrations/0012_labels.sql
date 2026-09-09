-- Labels: workspace-scoped tags for documents, plus the document↔label join.
-- Powers manual labeling, AI label suggestions, and the search modal's Labels
-- category. Names are unique per workspace case-insensitively.

create table labels (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references workspaces(id) on delete cascade,
    name         text not null,
    color        text not null default '#2B44C7',
    created_at   timestamptz not null default now()
);
create unique index labels_workspace_name_idx on labels (workspace_id, lower(name));

create table document_labels (
    document_id uuid not null references documents(id) on delete cascade,
    label_id    uuid not null references labels(id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (document_id, label_id)
);
create index document_labels_label_idx on document_labels (label_id);
