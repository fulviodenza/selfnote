/**
 * Connections settings — manage personal access tokens used to connect the
 * Selfnote MCP server (so Claude elsewhere can file notes into this instance).
 * A freshly minted token's plaintext is shown exactly once.
 */
import { useEffect, useState } from "react";
import { api, type TokenInfo } from "./api";
import { CalendarFeedCard } from "./CalendarFeed";
import { VoiceSettingsCard } from "./VoiceSettings";

/** The instance's public origin — what the MCP server should point SELFNOTE_URL at. */
const INSTANCE_URL = window.location.origin;

export function ConnectionsModal({
  onClose,
  workspaceId,
}: {
  onClose: () => void;
  /** Current workspace — enables the calendar-feed card when present. */
  workspaceId?: string | null;
}) {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Gate the "My writing voice" card on the server having an AI provider.
  const [aiAvailable, setAiAvailable] = useState(false);

  const load = () =>
    api
      .listTokens()
      .then(setTokens)
      .catch(() => setTokens([]));

  useEffect(() => {
    void load();
    void api
      .aiStatus()
      .then((s) => setAiAvailable(s.available))
      .catch(() => setAiAvailable(false));
  }, []);

  const create = async () => {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createToken(n);
      setFresh({ name: created.name, token: created.token });
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : "Could not create token.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await api.deleteToken(id).catch(() => {});
    await load();
  };

  const snippet = fresh
    ? `claude mcp add selfnote \\
  --env SELFNOTE_URL=${INSTANCE_URL} \\
  --env SELFNOTE_TOKEN=${fresh.token} \\
  -- npx -y @selfnote/mcp`
    : "";

  return (
    <div className="conn-overlay" onClick={onClose}>
      <div className="conn-card" onClick={(e) => e.stopPropagation()}>
        <div className="conn-head">
          <h2 className="conn-title">Connections</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="conn-intro">
          Create a personal access token to connect the Selfnote MCP server, so Claude — in
          the CLI, desktop, or claude.ai — can save summaries into this instance. Treat a token
          like a password; it can read and write your notes.
        </p>

        <div className="conn-create">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. Claude on my laptop)"
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <button onClick={create} disabled={!name.trim() || creating}>
            {creating ? "Creating…" : "Generate"}
          </button>
        </div>
        {error ? <div className="conn-error">{error}</div> : null}

        {fresh ? (
          <div className="conn-fresh">
            <div className="conn-fresh-label">
              Copy your token now — it won’t be shown again.
            </div>
            <code className="conn-token">{fresh.token}</code>
            <div className="conn-fresh-actions">
              <button onClick={() => navigator.clipboard?.writeText(fresh.token)}>
                Copy token
              </button>
              <button onClick={() => setFresh(null)}>Done</button>
            </div>
            <div className="conn-snippet-label">Add it to Claude Code:</div>
            <pre className="conn-snippet">{snippet}</pre>
            <button
              className="conn-snippet-copy"
              onClick={() => navigator.clipboard?.writeText(snippet)}
            >
              Copy command
            </button>
          </div>
        ) : null}

        <div className="conn-list">
          <div className="conn-list-title">Your tokens</div>
          {tokens == null ? (
            <div className="conn-muted">Loading…</div>
          ) : tokens.length === 0 ? (
            <div className="conn-muted">No tokens yet.</div>
          ) : (
            tokens.map((t) => (
              <div key={t.id} className="conn-row">
                <div className="conn-row-main">
                  <span className="conn-row-name">{t.name}</span>
                  <span className="conn-row-meta">
                    {t.last_used_at
                      ? `Last used ${new Date(t.last_used_at).toLocaleDateString()}`
                      : "Never used"}
                  </span>
                </div>
                <button className="conn-revoke" onClick={() => revoke(t.id)}>
                  Revoke
                </button>
              </div>
            ))
          )}
        </div>

        {workspaceId ? <CalendarFeedCard workspaceId={workspaceId} /> : null}

        {aiAvailable ? <VoiceSettingsCard /> : null}
      </div>
    </div>
  );
}
