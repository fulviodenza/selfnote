-- Archiving/trashing a page now cascades to its subtree (see documents::update).
-- Before this, children of a shelved page stayed "active" but unreachable from
-- the tree root: they kept feeding the sidebar label chips, search, and sync
-- while the Notes tree looked empty. Bring existing rows in line by shelving
-- every active descendant of a shelved page (trash wins over archive).

with recursive sub as (
    select id as top, id from documents where trashed
    union all
    select s.top, d.id from documents d join sub s on d.parent_id = s.id
)
update documents set trashed = true, updated_at = now()
where id in (select distinct sub.id from sub where sub.id <> sub.top)
  and not trashed;

with recursive sub as (
    select id as top, id from documents where archived and not trashed
    union all
    select s.top, d.id
    from documents d join sub s on d.parent_id = s.id
    where not d.trashed
)
update documents set archived = true, updated_at = now()
where id in (select distinct sub.id from sub where sub.id <> sub.top)
  and not archived;
