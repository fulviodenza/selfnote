# Enabling AI Assist

AI is **off by default** and **server-owned**: the clients (web, desktop, mobile)
show the **✦ Assist** panel only when your API server reports an available provider
via `GET /ai/status`. You enable it by giving the `selfnote-api` deployment the
credentials for **one** provider. Nothing leaves your instance unless you choose a
cloud provider.

The examples below assume the `selfnote` namespace — adjust as needed.

## Which provider?

| Provider | You need | Notes |
|---|---|---|
| **Claude subscription (local CLI)** | a token from `claude setup-token` | The `selfnote-api` image bundles the Claude Code CLI. Runs on your server — **document text never leaves your box**. Uses your Claude Pro/Max plan, no per-request billing. |
| **Anthropic API** | `ANTHROPIC_API_KEY` | Pay-per-use. Calls `api.anthropic.com`. |
| **Ollama** | a reachable `OLLAMA_HOST` | Local open-weights models; fully self-hosted. |

Detection order: `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → `OLLAMA_HOST`.
Set exactly one.

---

## Option 1 — Claude subscription (local CLI) — recommended

The image already contains the `claude` CLI; you only supply a subscription token.

**1. Generate a long-lived token** on any machine where you're signed into Claude:

```bash
claude setup-token          # prints an sk-ant-oat… token — copy it (valid ~1 year)
```

**2. Store it as a secret** (paste at the silent prompt so it stays out of shell history):

```bash
read -rs TOKEN && kubectl create secret generic selfnote-ai -n selfnote \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" && unset TOKEN
```

**3. Wire it to the API and restart:**

```bash
kubectl set env deployment/selfnote-api -n selfnote --from=secret/selfnote-ai
kubectl rollout restart deployment/selfnote-api -n selfnote
```

Rotate anytime by re-running `claude setup-token` and updating the secret
(`kubectl create secret … --dry-run=client -o yaml | kubectl apply -f -`), then
restart the deployment.

## Option 2 — Anthropic API key

```bash
kubectl create secret generic selfnote-ai -n selfnote \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-…
kubectl set env deployment/selfnote-api -n selfnote --from=secret/selfnote-ai
kubectl rollout restart deployment/selfnote-api -n selfnote
```

Optional: `SELFNOTE_AI_MODEL` (default `claude-sonnet-4-5`).

## Option 3 — Ollama

Run Ollama somewhere the cluster can reach, then:

```bash
kubectl set env deployment/selfnote-api -n selfnote \
  OLLAMA_HOST=http://ollama.ollama.svc:11434 SELFNOTE_AI_MODEL=llama3
kubectl rollout restart deployment/selfnote-api -n selfnote
```

---

## Verify

```bash
# grab an access token by logging in, then:
curl -H "authorization: Bearer <access-token>" https://<your-host>/api/ai/status
# → {"available":true,"provider":"claude-cli","model":"…","features":[…]}
```

Once `available` is `true`, the **✦ Assist** button appears in the editor topbar on
every client automatically — no client update needed.

## Helm

The chart has a first-class `ai:` block — set it in your values instead of running
the `kubectl` commands above. Pick a provider and give it a credential.

**Recommended — reference a secret you created out-of-band** (so the token never
lives in `values.yaml` / git):

```bash
kubectl create secret generic selfnote-ai -n selfnote \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

```yaml
# values.yaml
ai:
  enabled: true
  provider: claude-cli        # claude-cli | anthropic | ollama
  existingSecret: selfnote-ai # keys: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
```

**Simple — let the chart manage the secret** (fine for dev; the token lands in
your values, so keep them out of git or pass with `--set`):

```yaml
ai:
  enabled: true
  provider: claude-cli
  claudeCodeOauthToken: sk-ant-oat-…   # or: provider: anthropic + anthropicApiKey
```

**Ollama** needs no secret — just a reachable host:

```yaml
ai:
  enabled: true
  provider: ollama
  ollamaHost: http://ollama.ollama.svc:11434
  model: llama3
```

Optional: `ai.model` (→ `SELFNOTE_AI_MODEL`), `ai.cmd`, `ai.args`. After `helm
upgrade`, the api picks up the new env on its next rollout.

## Notes & security

- `/ai/*` require auth; `/ai/complete` verifies the caller is a member of the
  referenced document's workspace.
- The CLI provider spawns a `claude -p` process per request (`SELFNOTE_AI_ARGS`,
  default `-p`, controls invocation; the prompt is piped on stdin) with a 30s
  timeout. Keep it rate-limited if you expose it to untrusted users.
- Prefer the **local CLI** or **Ollama** if you want document text to never leave
  your infrastructure.
