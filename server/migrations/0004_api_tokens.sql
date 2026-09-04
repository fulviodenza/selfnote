-- Personal access tokens: long-lived, user-named credentials for headless
-- integrations (the MCP server, scripts, the CLI). Unlike refresh tokens these
-- don't rotate and carry a human-readable name so users can audit and revoke
-- them. Only the SHA-256 hash is stored; the plaintext ("snp_…") is shown once.
create table api_tokens (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    name         text not null,
    token_hash   text not null unique,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz
);
create index api_tokens_user_idx on api_tokens (user_id);
