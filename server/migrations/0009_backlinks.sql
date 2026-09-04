-- Backlinks & graph view.
--
-- Evolve the existing `document_links` table (introduced in 0005 for multi-note
-- context) into the authoritative note-to-note link store that powers the
-- backlinks panel and the workspace graph. Content lives in the opaque Yjs
-- `document-store` CRDT, so the editor client reports the current set of
-- outgoing links whenever content changes and the server replaces them here.
--
-- Changes vs 0005:
--   * rename src_doc_id -> source_id, dst_doc_id -> target_id (contract names)
--   * add workspace_id (denormalized from the source doc) for graph/backlinks
--     scoping and cascade on workspace delete
--   * add label: last-seen human-readable anchor text for the edge (previews)
--   * drop the src<>dst CHECK — self-links are now rejected by the API, not the
--     schema — and rebuild the supporting indexes under the new column names.

alter table document_links rename column src_doc_id to source_id;
alter table document_links rename column dst_doc_id to target_id;

alter table document_links drop constraint if exists document_links_check;

alter table document_links
    add column workspace_id uuid references workspaces(id) on delete cascade,
    add column label text;

-- Backfill workspace_id from each edge's source document, then enforce NOT NULL.
update document_links l
   set workspace_id = d.workspace_id
  from documents d
 where d.id = l.source_id;

alter table document_links alter column workspace_id set not null;

-- Backlinks lookup: "who links to target_id?"
drop index if exists document_links_dst_idx;
create index document_links_target_idx on document_links (target_id);
-- Outgoing lookup + graph edges scoped to a workspace.
drop index if exists document_links_src_idx;
create index document_links_source_idx on document_links (source_id);
create index document_links_workspace_idx on document_links (workspace_id);
