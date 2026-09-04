# Enabling AI Assist (server-side) — deploy checkpoint

The mobile app's **Assist** feature (F4) is fully implemented and ships in the APK,
but it stays **hidden** until the API server exposes `/ai/status` reporting an
available provider. Turning it on is a deliberate server-side step — it was **not**
done automatically, because it means rebuilding + redeploying the `selfnote-api`
image and (optionally) wiring an AI backend that spends compute or an API key.

## What's already done

- `server/api/src/ai.rs` — `GET /ai/status` + `POST /ai/complete`, routed in
  `main.rs`. `cargo check` passes. Deps added: `reqwest` (rustls), `tokio` `process`.
- Mobile: `api.aiStatus()`/`aiComplete()`, editor `getText`/`insert` bridge, and the
  Assist drawer (shown only when `available`). Verified to degrade gracefully — with
  no `/ai` endpoint, the app simply shows no Assist button and no errors.

## To turn it on

1. **Build & push the API image** with the new code, then roll the deployment
   (`selfnote-api` in the `selfnote` namespace). Standard image bump — reversible
   via rollback.
2. **Choose a provider** by setting env on the `selfnote-api` deployment. Detection
   order (first match wins):

   | Provider | Env to set | Notes |
   |---|---|---|
   | Local CLI | `SELFNOTE_AI_CMD` (default `claude`) on the pod's `PATH` | Data stays on the server. Needs the CLI in the image + any auth it requires. `SELFNOTE_AI_ARGS` (default `-p`) controls invocation; prompt is piped on stdin. |
   | Anthropic API | `ANTHROPIC_API_KEY` | Calls `api.anthropic.com`. Set `SELFNOTE_AI_MODEL` (default `claude-sonnet-4-5`). |
   | Ollama | `OLLAMA_HOST` (e.g. `http://ollama:11434`) | Local open-weights. `SELFNOTE_AI_MODEL` default `llama3`. |

   Optional for all: `SELFNOTE_AI_MODEL` overrides the model label/id.

3. **Verify**: `GET https://selfnote.example.com/api/ai/status` (with a bearer
   token) should return `{"available":true,"provider":"…","model":"…"}`. Then the
   `✦` Assist button appears in the editor topbar on mobile.

## Security notes

- `/ai/*` require auth, and `/ai/complete` verifies the caller is a member of the
  referenced document's workspace before dispatching to the AI.
- The CLI provider spawns a process per request; keep it sandboxed and rate-limited.
- Prefer the local CLI or Ollama if you want document text to never leave your box.
