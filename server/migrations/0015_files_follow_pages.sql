-- Assets follow their page: deleting a page forever also deletes the files
-- uploaded into it (previously the FK nulled doc_id and the rows lingered in
-- the Assets view). Files uploaded with no page (doc_id null) are unaffected.
alter table files drop constraint if exists files_doc_id_fkey;
alter table files
    add constraint files_doc_id_fkey
    foreign key (doc_id) references documents(id) on delete cascade;
