-- Store small uploaded files (e.g. imported Obsidian images) inline in Postgres.
-- MinIO/S3 remains the production path; this keeps the homelab trial self-contained.
alter table files add column if not exists data bytea;
alter table files alter column s3_key drop not null;
