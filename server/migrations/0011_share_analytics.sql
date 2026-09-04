-- Denormalized counters on the share for O(1) reads.
alter table shares add column view_count     bigint      not null default 0;
alter table shares add column last_viewed_at  timestamptz;

-- Append-only view log. One row per successful resolve.
create table share_views (
    id         bigserial   primary key,
    share_id   uuid        not null references shares(id) on delete cascade,
    viewed_at  timestamptz not null default now()
);
create index share_views_share_idx on share_views (share_id, viewed_at);
