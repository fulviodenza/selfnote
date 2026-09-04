-- Full-text search index over document titles.
create index documents_title_fts_idx
    on documents using gin (to_tsvector('english', title));
