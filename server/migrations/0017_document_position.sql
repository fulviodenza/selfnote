-- Sibling ordering for the page tree.
--
-- The tree was ordered by created_at, so siblings appeared in creation order
-- and nothing could change it. `position` makes the order explicit.
--
-- A float, not an integer rank: dropping a page between two siblings is then a
-- single-row update to the midpoint of its neighbours, where integer ranks
-- would mean renumbering every following sibling on every move. That is more
-- writes, and a worse story when two devices reorder at the same time.
alter table documents
    add column position double precision not null default 0;

-- Backfill in the order the tree already displayed, so nothing appears to move
-- when this ships. row_number() is per sibling group, matching how the tree
-- renders: the ordering only ever matters among children of the same parent.
--
-- PARTITION BY groups NULLs together, so every top-level page shares one
-- partition and they rank 1, 2, 3 among themselves. A join on `parent_id = ...`
-- would not: NULL = NULL is NULL, and each root page would land in a partition
-- of its own and get position 1.
with ranked as (
    select id,
           row_number() over (
               partition by workspace_id, parent_id
               order by created_at, id
           )::double precision as rn
    from documents
)
update documents d
set position = ranked.rn
from ranked
where d.id = ranked.id;

-- Matches how the tree is actually fetched: `list` selects a whole workspace
-- and orders by (position, created_at), assembling the hierarchy client-side.
-- It does not filter by parent_id, so an index led by parent_id could not serve
-- that sort; this one can.
create index documents_workspace_order_idx
    on documents (workspace_id, position, created_at);
