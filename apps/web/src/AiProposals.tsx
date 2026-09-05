/**
 * Diff-preview for AI edits (web). Any AI-originated write (remote MCP or an
 * in-app assistant "insert into note") is staged as a `pending` proposal rather
 * than mutating the note. This module surfaces those proposals:
 *
 *  - `AiProposalBanner`  — a dismissible bar above the editor: "N pending AI
 *    edit(s) — Review". Polls `listAiProposals?document_id` on doc open / after
 *    the assistant streams, and opens the diff on click.
 *  - `AiDiffPreview`     — a drawer that renders a unified before/after Markdown
 *    diff (additions green, removals red) with Accept / Reject, honoring the
 *    409-superseded drift case with an inline toast + list refresh.
 *
 * Accept applies the diff server-side; the normal sync path re-renders the note.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AiProposal } from "./api";
import { Icon } from "./Icon";

/* ------------------------------- diff engine ------------------------------- */

type DiffRow = { kind: "same" | "add" | "del"; text: string };

/**
 * Line-based LCS diff of `before` vs `after`. Emits a unified sequence of rows
 * (unchanged / added / removed) for rendering. Small, dependency-free — note
 * bodies are short and this only runs when the drawer is open.
 */
function diffLines(before: string, after: string): DiffRow[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: "del", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return rows;
}

const ORIGIN_LABEL: Record<AiProposal["origin"], string> = {
  mcp: "Remote via MCP",
  app: "In-app",
};

/* ------------------------------ pending banner ----------------------------- */

/**
 * Polls the pending proposals for `docId` and renders a review bar when there is
 * at least one. `refreshKey` lets a parent force a re-poll (e.g. right after the
 * assistant streams a reply, or an in-app insertion stages a proposal).
 */
export function AiProposalBanner({
  docId,
  refreshKey = 0,
  onReview,
}: {
  docId: string;
  refreshKey?: number;
  onReview: (proposals: AiProposal[]) => void;
}) {
  const [pending, setPending] = useState<AiProposal[]>([]);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listAiProposals(docId, "pending");
      setPending(list);
    } catch {
      /* leave the last-known list on a transient failure */
    }
  }, [docId]);

  // Re-poll on doc change and whenever the parent bumps `refreshKey`.
  useEffect(() => {
    setDismissed(false);
    void load();
  }, [load, refreshKey]);

  if (dismissed || pending.length === 0) return null;

  return (
    <div className="proposal-banner">
      <span className="proposal-banner-spark"><Icon name="sparkles" size={16} /></span>
      <span className="proposal-banner-text">
        {pending.length} pending AI edit{pending.length === 1 ? "" : "s"}
      </span>
      <div className="proposal-banner-actions">
        <button className="proposal-banner-review" onClick={() => onReview(pending)}>
          Review
        </button>
        <button
          className="icon-btn"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- diff drawer ------------------------------- */

/**
 * Reviews one or more pending proposals for a note. Renders the unified
 * before/after diff of the current proposal and gates it behind Accept / Reject.
 * `onResolved` fires after each accept/reject so the parent can re-poll the
 * banner and let the sync path re-render the note.
 */
export function AiDiffPreview({
  proposals,
  onClose,
  onResolved,
}: {
  proposals: AiProposal[];
  onClose: () => void;
  onResolved: () => void;
}) {
  // Local queue: proposals drop out as they're accepted/rejected.
  const [queue, setQueue] = useState<AiProposal[]>(proposals);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setQueue(proposals), [proposals]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const current = queue[0] ?? null;
  const rows = useMemo(
    () => (current ? diffLines(current.before_md, current.after_md) : []),
    [current],
  );

  const flash = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // Drop the head of the queue; close when nothing is left to review.
  const advance = useCallback(() => {
    setQueue((q) => {
      const rest = q.slice(1);
      if (rest.length === 0) onClose();
      return rest;
    });
  }, [onClose]);

  const accept = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await api.acceptAiProposal(current.id);
      onResolved();
      advance();
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Superseded / drifted — the edit no longer applies cleanly.
        flash("This note changed — the edit no longer applies.");
        onResolved();
        advance();
      } else {
        flash("Couldn’t accept this edit.");
      }
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await api.rejectAiProposal(current.id);
      onResolved();
      advance();
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        onResolved();
        advance();
      } else {
        flash("Couldn’t reject this edit.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!current) return null;

  const remaining = queue.length - 1;

  return (
    <div className="proposal-overlay" onClick={onClose}>
      <div className="proposal-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="proposal-drawer-head">
          <div className="proposal-drawer-title">
            <span className="proposal-drawer-spark"><Icon name="sparkles" size={16} /></span>
            Review AI edit
            {remaining > 0 ? <span className="proposal-drawer-count">+{remaining} more</span> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="proposal-meta">
          <span className={`proposal-origin ${current.origin}`}>
            {ORIGIN_LABEL[current.origin]}
          </span>
          <span className="proposal-op">{current.op === "append" ? "Append" : "Replace"}</span>
          <span className="proposal-time">{new Date(current.created_at).toLocaleString()}</span>
        </div>
        {current.summary ? <div className="proposal-summary">{current.summary}</div> : null}

        <div className="proposal-diff">
          {rows.map((r, i) => (
            <div key={i} className={`proposal-line ${r.kind}`}>
              <span className="proposal-gutter">
                {r.kind === "add" ? (
                  <Icon name="plus" size={12} />
                ) : r.kind === "del" ? (
                  <Icon name="minus" size={12} />
                ) : null}
              </span>
              <span className="proposal-line-text">{r.text || " "}</span>
            </div>
          ))}
        </div>

        {toast ? <div className="proposal-toast">{toast}</div> : null}

        <div className="proposal-drawer-foot">
          <button className="proposal-reject" onClick={reject} disabled={busy}>
            Reject
          </button>
          <button className="proposal-accept" onClick={accept} disabled={busy}>
            {busy ? "…" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}
