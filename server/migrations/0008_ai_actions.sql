-- 0008_ai_actions.sql
--
-- Note-level AI actions (Summarize / Rewrite in my voice / Extract action items).
-- The action itself is stateless — the client sends the note text and the output
-- is transient AI text. Two tables persist the only durable bits: a per-user
-- writing "voice" sample that grounds "Rewrite in my voice", and lightweight
-- usage telemetry that never stores note content.

-- Per-user writing "voice" sample used to ground the "Rewrite in my voice" action.
create table ai_voice_profiles (
    user_id     uuid primary key references users(id) on delete cascade,
    sample      text        not null default '',
    updated_at  timestamptz not null default now()
);

-- Optional usage log so we can see which actions land. Never stores note content.
create table ai_action_events (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    doc_id      uuid references documents(id) on delete set null,
    action      text not null,            -- 'summarize' | 'rewrite' | 'action_items'
    scope       text not null,            -- 'note' | 'selection'
    created_at  timestamptz not null default now()
);

create index ai_action_events_user_idx on ai_action_events(user_id, created_at desc);
