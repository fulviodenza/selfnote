/**
 * Calendar-feed card (workspace settings). Subscribing an external calendar
 * (Google/Apple/Outlook) to the workspace's read-only ICS feed. Mirrors the
 * PAT-token UI: enabling mints a one-time `cal_…` token embedded in a feed URL
 * shown once; the card otherwise reports only that a feed exists. Rotate
 * re-issues (invalidating the old URL); Disable revokes it.
 *
 * On desktop (Tauri) the `.ics`/`webcal://` links must open in the OS calendar,
 * not the embedded webview — we use the Tauri opener plugin when present and
 * fall back to a normal navigation in the browser.
 */
import { useEffect, useState } from "react";
import { api, apiUrl, type CalendarFeed as Feed } from "./api";

/** Open a URL in the OS default handler (Tauri) or the browser. */
async function openExternal(url: string) {
  const opener = (window as unknown as {
    __TAURI__?: { opener?: { openUrl?: (u: string) => Promise<void> } };
  }).__TAURI__?.opener;
  if (opener?.openUrl) {
    await opener.openUrl(url).catch(() => window.open(url, "_blank"));
  } else {
    window.open(url, "_blank");
  }
}

/** Turn a relative ICS path into an absolute `webcal://` subscription URL. */
function webcalUrl(icsPath: string): string {
  const abs = apiUrl(icsPath);
  // Absolute http(s) → webcal; a same-origin relative base resolves against origin.
  const full = /^https?:\/\//i.test(abs) ? abs : `${window.location.origin}${abs}`;
  return full.replace(/^https?:\/\//i, "webcal://");
}

export function CalendarFeedCard({ workspaceId }: { workspaceId: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one-time URL, only known right after issuing/rotating.
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api
      .getCalendarFeed(workspaceId)
      .then(setFeed)
      .catch(() => setFeed({ enabled: false }));

  useEffect(() => {
    setFeed(null);
    setFreshUrl(null);
    void api
      .getCalendarFeed(workspaceId)
      .then(setFeed)
      .catch(() => setFeed({ enabled: false }));
  }, [workspaceId]);

  const issue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const issued = await api.issueCalendarFeed(workspaceId);
      setFreshUrl(apiUrl(issued.url));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : "Could not enable the feed.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.revokeCalendarFeed(workspaceId);
      setFreshUrl(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : "Could not disable the feed.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
  };

  const enabled = !!feed?.enabled;

  return (
    <div className="conn-list">
      <div className="conn-list-title">Calendar feed</div>
      <p className="conn-intro" style={{ margin: "0 0 12px" }}>
        Subscribe your calendar (Google, Apple, Outlook) to a read-only feed of this workspace’s
        tasks with a due date. Tasks appear as events and update in place when you edit them.
      </p>

      {feed == null ? (
        <div className="conn-muted">Loading…</div>
      ) : !enabled ? (
        <button className="cal-enable" onClick={issue} disabled={busy}>
          {busy ? "Enabling…" : "Enable calendar feed"}
        </button>
      ) : (
        <>
          {freshUrl ? (
            <div className="conn-fresh">
              <div className="conn-fresh-label">
                Copy this feed URL now — the token in it is shown only once.
              </div>
              <code className="conn-token">{freshUrl}</code>
              <div className="conn-fresh-actions">
                <button onClick={() => copy(freshUrl)}>{copied ? "Copied" : "Copy URL"}</button>
                <button onClick={() => void openExternal(webcalUrl(feed.url ?? ""))}>
                  Add to calendar
                </button>
              </div>
            </div>
          ) : (
            <div className="conn-row" style={{ borderBottom: "none" }}>
              <div className="conn-row-main">
                <span className="conn-row-name">Feed enabled</span>
                <span className="conn-row-meta">
                  {feed.last_used_at
                    ? `Last fetched ${new Date(feed.last_used_at).toLocaleDateString()}`
                    : "Not fetched yet"}
                  {feed.created_at
                    ? ` · created ${new Date(feed.created_at).toLocaleDateString()}`
                    : ""}
                </span>
                <span className="conn-row-meta">
                  Rotate to see the URL again (the previous one stops working).
                </span>
              </div>
            </div>
          )}

          <div className="conn-fresh-actions" style={{ marginTop: 4 }}>
            <button onClick={issue} disabled={busy}>
              {busy ? "…" : "Rotate"}
            </button>
            <button className="conn-revoke" onClick={disable} disabled={busy}>
              Disable
            </button>
          </div>
        </>
      )}

      {error ? <div className="conn-error" style={{ marginTop: 8 }}>{error}</div> : null}
    </div>
  );
}
