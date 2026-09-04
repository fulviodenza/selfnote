/**
 * GraphView — a force-directed map of the workspace.
 *
 * Fetches `GET /workspaces/:id/graph` (one node per non-archived document, plus
 * `link` edges from document_links and `tree` edges from parent→child) and lays
 * it out with a small self-contained force simulation drawn on a canvas — no
 * server-side layout, no extra graph dependency. `link` edges are solid, `tree`
 * edges dashed/lighter. Clicking a node opens that document; the node for the
 * currently-open doc is highlighted. Pan by dragging, zoom with the wheel.
 *
 * Styling follows the "Ink & Paper" tokens in styles.css.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type WorkspaceGraph, type DocumentRef } from "./api";

interface SimNode {
  id: string;
  title: string;
  icon: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
}
interface SimEdge {
  source: string;
  target: string;
  kind: "link" | "tree";
}

/** Read an "Ink & Paper" CSS custom property off the document root. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function GraphView({
  workspaceId,
  activeId,
  onOpen,
  onClose,
}: {
  workspaceId: string;
  activeId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    api
      .getGraph(workspaceId)
      .then((g) => alive && setGraph(g))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  return (
    <div className="graph-view">
      <div className="graph-bar">
        <span className="graph-bar-title">Graph</span>
        <span className="graph-bar-hint">Drag to pan · scroll to zoom · click a node to open</span>
        <button className="toggle" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? (
        <div className="center-msg">{error}</div>
      ) : !graph ? (
        <div className="center-msg">Building graph…</div>
      ) : graph.nodes.length === 0 ? (
        <div className="center-msg">No notes to graph yet.</div>
      ) : (
        <GraphCanvas graph={graph} activeId={activeId} onOpen={onOpen} />
      )}
    </div>
  );
}

const REPULSION = 6000; // node-node inverse-square push
const SPRING = 0.02; // edge attraction stiffness
const SPRING_LEN = 90; // desired edge length
const CENTER_PULL = 0.008; // gravity toward the origin
const DAMPING = 0.85;
const NODE_R = 6;
const HIT_R = 16; // click tolerance around a node

function GraphCanvas({
  graph,
  activeId,
  onOpen,
}: {
  graph: WorkspaceGraph;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Build the simulation model once per graph payload. Seed positions on a
  // deterministic ring so the layout is stable across renders.
  const nodes = useMemo<SimNode[]>(() => {
    return graph.nodes.map((n: DocumentRef, i) => {
      const a = (i / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
      const radius = 40 + (i % 7) * 24;
      return {
        id: n.id,
        title: n.title,
        icon: n.icon,
        x: Math.cos(a) * radius,
        y: Math.sin(a) * radius,
        vx: 0,
        vy: 0,
      };
    });
  }, [graph]);

  const edges = useMemo<SimEdge[]>(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    // Defensive: only keep edges whose endpoints are present as nodes.
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [graph]);

  // View transform (pan/zoom), mutated imperatively during interaction.
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    let raf = 0;
    let alpha = 1; // cooling factor; sim settles as it decays

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Center the origin the first time we know our size.
      if (view.current.tx === 0 && view.current.ty === 0) {
        view.current.tx = w / 2;
        view.current.ty = h / 2;
      }
    };

    const step = () => {
      // --- physics ---
      if (alpha > 0.02) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 0.01;
            }
            const f = (REPULSION / d2) * alpha;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
          }
          // Gravity toward origin keeps disconnected nodes on screen.
          a.vx -= a.x * CENTER_PULL * alpha;
          a.vy -= a.y * CENTER_PULL * alpha;
        }
        for (const e of edges) {
          const s = byId.get(e.source);
          const t = byId.get(e.target);
          if (!s || !t) continue;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = (d - SPRING_LEN) * SPRING * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          s.vx += fx;
          s.vy += fy;
          t.vx -= fx;
          t.vy -= fy;
        }
        for (const n of nodes) {
          n.vx *= DAMPING;
          n.vy *= DAMPING;
          n.x += n.vx;
          n.y += n.vy;
        }
        alpha *= 0.985;
      }

      // --- draw ---
      const { scale, tx, ty } = view.current;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(scale, scale);

      const edgeColor = token("--border", "#e2e1dc");
      const linkColor = token("--muted", "#606670");
      const accent = token("--accent", "#2b44c7");
      const nodeColor = token("--faint", "#9a9ea6");
      const labelColor = token("--fg", "#1b1d22");

      // Edges: tree dashed/lighter, link solid.
      for (const e of edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        if (e.kind === "tree") {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth = 1;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = linkColor;
          ctx.lineWidth = 1.25;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Nodes + labels.
      ctx.font = "12px var(--font-sans, system-ui)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const active = n.id === activeId;
        ctx.beginPath();
        ctx.arc(n.x, n.y, active ? NODE_R + 2 : NODE_R, 0, Math.PI * 2);
        ctx.fillStyle = active ? accent : nodeColor;
        ctx.fill();
        if (active) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = accent;
          ctx.stroke();
        }
        const label = (n.icon ? `${n.icon} ` : "") + (n.title || "Untitled");
        ctx.fillStyle = active ? accent : labelColor;
        ctx.fillText(label.length > 28 ? `${label.slice(0, 27)}…` : label, n.x, n.y + NODE_R + 4);
      }
      ctx.restore();
      raf = requestAnimationFrame(step);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [nodes, edges, activeId]);

  // Convert a client point to world (pre-transform) coordinates.
  const toWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const { scale, tx, ty } = view.current;
    return {
      x: (clientX - rect.left - tx) / scale,
      y: (clientY - rect.top - ty) / scale,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.current.moved = true;
    view.current.tx += dx;
    view.current.ty += dy;
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // A click (no drag): open the node under the cursor, if any.
    const p = toWorld(e.clientX, e.clientY);
    let hit: SimNode | null = null;
    let best = HIT_R * HIT_R;
    for (const n of nodes) {
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= best) {
        best = d2;
        hit = n;
      }
    }
    if (hit) onOpen(hit.id);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(3, Math.max(0.2, view.current.scale * factor));
    // Zoom toward the cursor: keep the world point under the pointer fixed.
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    view.current.tx = e.clientX - rect.left - p.x * next;
    view.current.ty = e.clientY - rect.top - p.y * next;
    view.current.scale = next;
  };

  return (
    <div className="graph-canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      />
    </div>
  );
}
