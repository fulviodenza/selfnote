-- Trash for pages (soft-delete distinct from Archive; hard delete empties it)
-- and display names for uploaded files, shown in the sidebar Assets view.
alter table documents add column if not exists trashed boolean not null default false;
alter table files add column if not exists name text;
