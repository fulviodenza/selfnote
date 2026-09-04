-- Staged AI edits. An AI write (MCP update_note/append_to_note, or an in-app AI
-- insertion) is recorded here as a base64 Yjs diff instead of being applied to
-- the note's content log. A human reviews the before/after in the app and either
-- accepts it (the diff is appended to doc content) or rejects it. `base_sv` is the
-- state vector the diff was computed against; if the note has moved on we mark the
-- proposal `superseded` on accept rather than corrupting the doc.
create table ai_edit_proposals (
    id            uuid primary key default gen_random_uuid(),
    document_id   uuid not null references documents(id) on delete cascade,
    workspace_id  uuid not null references workspaces(id) on delete cascade,
    -- Who/what created it. `created_by` is the user the credential belongs to.
    created_by    uuid not null references users(id) on delete cascade,
    -- 'mcp' (remote PAT), 'app' (in-app AI insertion). Free-form for future sources.
    origin        text not null,
    -- 'append' | 'replace'. Mirrors the two mutating MCP tools.
    op            text not null,
    -- Human-readable label, e.g. "Append 2 paragraphs" or the AI intent.
    summary       text not null default '',
    -- The staged change.
    diff_base64   text not null,              -- incremental Yjs update to apply on accept
    base_sv       text not null,              -- base64 state vector diff was computed from
    before_md     text not null default '',   -- note body before the edit (Markdown)
    after_md      text not null default '',   -- note body after the edit (Markdown)
    -- Lifecycle.
    status        text not null default 'pending', -- pending|applied|rejected|superseded
    created_at    timestamptz not null default now(),
    resolved_at   timestamptz,
    resolved_by   uuid references users(id) on delete set null
);

create index ai_edit_proposals_doc_idx    on ai_edit_proposals (document_id, status);
create index ai_edit_proposals_ws_pending on ai_edit_proposals (workspace_id) where status = 'pending';
