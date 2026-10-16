/**
 * Component showcase: every web primitive and the feature pieces built on them,
 * in light and dark. Open /showcase.html. Without a ?theme it shows both themes
 * side by side, each in its own frame, since the tokens hang off <html>.
 *
 * Renders the real classes from styles.css, so a change there shows up here.
 * Keep it in step with apps/mobile/src/screens/ShowcaseScreen.tsx.
 */
import "../fonts";
import "../styles.css";
import "./showcase.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import tokens from "@selfnote/core/tokens.json";
import { Icon } from "../Icon";
import { PRIORITY_LABEL, PRIORITY_MARK } from "../tasks";

const theme = new URLSearchParams(location.search).get("theme");

/** Both themes side by side, each frame sized to its content. */
function Frames() {
  return (
    <div className="sc-frames">
      <Frame theme="light" />
      <Frame theme="dark" />
    </div>
  );
}

function Frame({ theme }: { theme: "light" | "dark" }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1200);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && typeof e.data?.scHeight === "number") {
        setHeight(e.data.scHeight);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={ref}
      title={`${theme} theme`}
      src={`?theme=${theme}`}
      className="sc-frame"
      style={{ height }}
    />
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sc-section">
      <h2 className="sc-title">{title}</h2>
      {note ? <p className="sc-note">{note}</p> : null}
      {children}
    </section>
  );
}

const Row = ({ children }: { children: ReactNode }) => <div className="sc-row">{children}</div>;

const COLOR_VARS: Array<[string, string]> = [
  ["--paper", "paper"],
  ["--bg", "surface"],
  ["--hover", "surface sunken"],
  ["--fg", "ink"],
  ["--muted", "ink soft"],
  ["--faint", "ink faint"],
  ["--border", "hairline"],
  ["--accent", "accent"],
  ["--accent-press", "accent pressed"],
  ["--accent-wash", "accent wash"],
  ["--live", "live (sync only)"],
  ["--warn", "warn (sync only)"],
  ["--danger", "danger"],
];

const CALLOUTS: Array<[string, string, string]> = [
  ["note", "Note", "Context worth knowing."],
  ["tip", "Tip", "A better way to do it."],
  ["important", "Important", "Do not skip this."],
  ["warning", "Warning", "This can go wrong."],
  ["caution", "Caution", "This loses data."],
];

const CALLOUT_ICON: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  note: "help-circle",
  tip: "sparkles",
  important: "check-square",
  warning: "clock",
  caution: "x",
};

function Gallery() {
  useEffect(() => {
    // Report height to the side-by-side parent, if any.
    const post = () => parent.postMessage({ scHeight: document.documentElement.scrollHeight }, "*");
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);

  return (
    <main className="sc-page">
      <header className="sc-head">
        <h1 className="sc-h1">Selfnote components</h1>
        <p className="sc-note">
          Ink and Paper: warm paper, slate ink, one cobalt accent. Live, warn and danger mean sync
          state and destructive actions, never decoration. {theme === "dark" ? "Dark" : "Light"} theme.
        </p>
      </header>

      <Section title="Colour" note="From packages/core/tokens.json. Every client copy is checked against it.">
        <div className="sc-swatches">
          {COLOR_VARS.map(([v, name]) => (
            <div key={v} className="sc-swatch">
              <span className="sc-chipcolor" style={{ background: `var(${v})` }} />
              <span className="sc-swatch-name">{name}</span>
              <code className="sc-code">{v}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type" note="Serif for what you wrote, sans for the instrument around it.">
        <div className="sc-type">
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 28, fontWeight: 600 }}>Screen title, serif 28</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 500 }}>Page title, serif 18</div>
          <div style={{ fontSize: 16 }}>Body text, sans 16</div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Label, sans 14</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Meta, sans 13, ink soft</div>
        </div>
      </Section>

      <Section title="Radius and elevation" note="Hairlines separate; one soft shadow for things that float.">
        <Row>
          {(["sm", "md", "lg"] as const).map((r) => (
            <div key={r} className="sc-box" style={{ borderRadius: `var(--radius-${r})` }}>
              {r} {tokens.radius[r]}
            </div>
          ))}
          <div className="sc-box" style={{ boxShadow: "var(--shadow-floating)", border: "none" }}>
            floating
          </div>
        </Row>
      </Section>

      <Section title="Buttons" note="One primary per screen. Secondary for the rest; ghost for inline navigation.">
        <Row>
          <button className="btn btn-primary">Create page</button>
          <button className="btn btn-secondary">Cancel</button>
          <button className="btn btn-ghost">Need an account?</button>
          <button className="btn btn-danger">Delete</button>
        </Row>
        <Row>
          <button className="btn btn-primary btn-lg">Sign in</button>
          <button className="btn btn-secondary btn-sm">Small</button>
          <button className="btn btn-primary" disabled>
            Disabled
          </button>
          <button className="btn btn-secondary btn-icon" aria-label="Settings">
            <Icon name="settings" size={16} />
          </button>
          <button className="btn btn-primary">
            <Icon name="plus" size={16} /> New page
          </button>
        </Row>
      </Section>

      <Section title="Chips" note="Filters and labels. Selected is the accent wash, never a solid fill.">
        <Row>
          <span className="chip on">All</span>
          <span className="chip">To do</span>
          <span className="chip">In progress</span>
          <span className="chip">Done</span>
        </Row>
        <Row>
          <span className="label-chip">reading</span>
          <span className="label-chip">projects</span>
          <span className="label-chip suggestion">+ suggested</span>
        </Row>
      </Section>

      <Section title="Tasks" note="Status from the mark and the weight; priority from ink marks.">
        <Row>
          <span className="task-pill status-todo">
            <span className="task-pill-mark"><Icon name="circle" size={14} /></span>To do
          </span>
          <span className="task-pill status-in_progress">
            <span className="task-pill-mark"><Icon name="clock" size={14} /></span>In progress
          </span>
          <span className="task-pill status-done">
            <span className="task-pill-mark"><Icon name="check" size={14} /></span>Done
          </span>
        </Row>
        <Row>
          {(["high", "medium", "low"] as const).map((p) => (
            <span key={p} className="sc-prio">
              <span className={`task-prio prio-${p}`}>{PRIORITY_MARK[p]}</span>
              {PRIORITY_LABEL[p]}
            </span>
          ))}
        </Row>
      </Section>

      <Section title="Inputs">
        <Row>
          <input className="input" placeholder="Search pages" />
          <input className="input" defaultValue="Focused" autoFocus={theme === "light"} />
        </Row>
      </Section>

      <Section title="Callouts" note="Note takes the accent; tip and important are ink; warning and caution keep their meaning.">
        <div className="sc-stack">
          {CALLOUTS.map(([kind, label, text]) => (
            <div key={kind} className={`callout callout-${kind}`}>
              <div className="callout-icon-wrap">
                <Icon name={CALLOUT_ICON[kind]} size={18} />
              </div>
              <div className="callout-body">
                <strong>{label}.</strong> {text}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Status" note="The one place live, warn and danger appear: sync state.">
        <Row>
          {(
            [
              ["--live", "Live"],
              ["--warn", "Syncing"],
              ["--danger", "Offline"],
            ] as const
          ).map(([v, word]) => (
            <span key={v} className="sc-status">
              <span className="sc-dot" style={{ background: `var(${v})` }} />
              {word}
            </span>
          ))}
        </Row>
        <Row>
          <span className="history-badge">auto</span>
          <span className="history-badge manual">manual</span>
          <span className="history-badge restore">restore</span>
        </Row>
        <Row>
          {tokens.presence.map((c, i) => (
            <span key={c} className="presence-chip" style={{ color: c }}>
              {["Ada", "Linus", "Grace", "Alan", "Ken"][i]}
            </span>
          ))}
        </Row>
      </Section>

      <Section title="Feedback" note="Toasts for confirmations; banners for state that stays.">
        <Row>
          <span className="toast">
            Link copied <button className="toast-action">Undo</button>
          </span>
        </Row>
        <div className="editor-toast sc-banner">This page changed on the server. Showing the latest version.</div>
      </Section>

      <Section title="Empty state" note="Never a bare blank: a serif line and one action.">
        <div className="sc-box sc-wide">
          <div className="empty-state">
            <p className="empty-state-title">Nothing here yet.</p>
            <span>Pages you write show up in this list.</span>
            <button className="btn btn-primary">Create your first page</button>
          </div>
        </div>
      </Section>

      <Section title="Sheet" note="A card on the scrim, for dialogs.">
        <div className="sc-scrim">
          <div className="sheet sc-sheet">
            <h3 className="sc-sheet-title">Rename label</h3>
            <input className="input" defaultValue="reading" />
            <div className="sc-row sc-end">
              <button className="btn btn-secondary">Cancel</button>
              <button className="btn btn-primary">Save</button>
            </div>
          </div>
        </div>
      </Section>
    </main>
  );
}

if (theme === "light" || theme === "dark") {
  document.documentElement.dataset.theme = theme;
  createRoot(document.getElementById("root")!).render(<Gallery />);
} else {
  document.body.classList.add("sc-host");
  createRoot(document.getElementById("root")!).render(<Frames />);
}
