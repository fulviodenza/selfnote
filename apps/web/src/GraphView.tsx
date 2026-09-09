/**
 * GraphView — a force-directed map of the workspace, explorable in 2D or 3D.
 *
 * Fetches `GET /workspaces/:id/graph` (one node per non-archived document, plus
 * `link` edges from document_links and `tree` edges from parent→child) and lays
 * it out with a small self-contained force simulation drawn on a canvas — no
 * server-side layout, no extra graph dependency. The simulation itself runs in
 * three dimensions; the 2D mode simply flattens z and projects orthographically,
 * while the 3D mode renders through a yaw/pitch orbit camera with perspective
 * and depth cues (far nodes smaller and faded, painter's-algorithm ordering).
 *
 * Interaction — 2D: drag pans, wheel zooms. 3D: drag orbits, Shift+drag pans,
 * wheel dollies the camera. Clicking a node opens that document in both modes;
 * the currently-open doc is highlighted. Styling follows the "Ink & Paper"
 * tokens in styles.css.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type WorkspaceGraph, type DocumentRef } from "./api";

interface SimNode {
  id: string;
  title: string;
  icon: string | null;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}
interface SimEdge {
  source: string;
  target: string;
  kind: "link" | "tree";
}

type GraphMode = "2d" | "3d";
const MODE_KEY = "selfnote_graph_mode";

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
  const [mode, setMode] = useState<GraphMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "2d" ? "2d" : "3d";
    } catch {
      return "3d";
    }
  });

  const switchMode = (m: GraphMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  };

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
        <span className="graph-mode">
          <button
            className={mode === "2d" ? "graph-mode-btn on" : "graph-mode-btn"}
            onClick={() => switchMode("2d")}
          >
            2D
          </button>
          <button
            className={mode === "3d" ? "graph-mode-btn on" : "graph-mode-btn"}
            onClick={() => switchMode("3d")}
          >
            3D
          </button>
        </span>
        <span className="graph-bar-hint">
          {mode === "3d"
            ? "Drag to orbit · ⇧drag to pan · scroll to zoom · click a node to open"
            : "Drag to pan · scroll to zoom · click a node to open"}
        </span>
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
        <GraphCanvas graph={graph} activeId={activeId} mode={mode} onOpen={onOpen} />
      )}
    </div>
  );
}

const REPULSION = 6000; // node-node inverse-square push
const SPRING = 0.02; // edge attraction stiffness
const SPRING_LEN = 90; // desired edge length
const CENTER_PULL = 0.008; // gravity toward the origin
const FLATTEN = 0.08; // z decay per frame in 2D mode
const DAMPING = 0.85;
const NODE_R = 6;
const HIT_R = 16; // click tolerance around a node (screen px)
const FOCAL = 700; // perspective focal length
const MIN_CAM = 250;
const MAX_CAM = 3000;

/** A node's position after camera projection, kept for hit-testing. */
interface Projected {
  id: string;
  sx: number; // screen x/y (post-transform, px)
  sy: number;
  r: number; // drawn radius (px)
  depth: number;
}

function GraphCanvas({
  graph,
  activeId,
  mode,
  onOpen,
}: {
  graph: WorkspaceGraph;
  activeId: string | null;
  mode: GraphMode;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Build the simulation model once per graph payload. Seed positions on a
  // deterministic spiral shell so the layout is stable across renders.
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
        z: ((i % 5) - 2) * 24,
        vx: 0,
        vy: 0,
        vz: 0,
      };
    });
  }, [graph]);

  const edges = useMemo<SimEdge[]>(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    // Defensive: only keep edges whose endpoints are present as nodes.
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [graph]);

  // View state, mutated imperatively during interaction. 2D uses scale/tx/ty;
  // 3D uses yaw/pitch/cam (orbit camera) plus tx/ty for panning.
  const view = useRef({ scale: 1, tx: 0, ty: 0, yaw: 0.6, pitch: 0.35, cam: 900 });
  const drag = useRef<{ x: number; y: number; moved: boolean; pan: boolean } | null>(null);
  const projected = useRef<Projected[]>([]);
  const alphaRef = useRef(1); // cooling factor; sim settles as it decays

  // Reheat the simulation when switching modes so the layout re-settles into
  // (or out of) the third dimension.
  useEffect(() => {
    alphaRef.current = 1;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    let raf = 0;

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
      // --- physics (always simulated in 3D; 2D mode flattens z) ---
      const alpha = alphaRef.current;
      if (alpha > 0.02) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let dz = a.z - b.z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              dz = Math.random() - 0.5;
              d2 = 0.01;
            }
            const f = (REPULSION / d2) * alpha;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            const fz = (dz / d) * f;
            a.vx += fx;
            a.vy += fy;
            a.vz += fz;
            b.vx -= fx;
            b.vy -= fy;
            b.vz -= fz;
          }
          // Gravity toward origin keeps disconnected nodes on screen.
          a.vx -= a.x * CENTER_PULL * alpha;
          a.vy -= a.y * CENTER_PULL * alpha;
          a.vz -= a.z * CENTER_PULL * alpha;
        }
        for (const e of edges) {
          const s = byId.get(e.source);
          const t = byId.get(e.target);
          if (!s || !t) continue;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dz = t.z - s.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
          const f = (d - SPRING_LEN) * SPRING * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          const fz = (dz / d) * f;
          s.vx += fx;
          s.vy += fy;
          s.vz += fz;
          t.vx -= fx;
          t.vy -= fy;
          t.vz -= fz;
        }
        for (const n of nodes) {
          n.vx *= DAMPING;
          n.vy *= DAMPING;
          n.vz *= DAMPING;
          n.x += n.vx;
          n.y += n.vy;
          n.z += n.vz;
          // 2D flattens the third dimension back to a plane.
          if (mode === "2d") n.z *= 1 - FLATTEN;
        }
        alphaRef.current = alpha * 0.985;
      }

      // --- project ---
      const { scale, tx, ty, yaw, pitch, cam } = view.current;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const project = (n: { x: number; y: number; z: number }) => {
        if (mode === "2d") {
          return { px: n.x * scale + tx, py: n.y * scale + ty, k: scale, depth: 0 };
        }
        // Orbit: rotate around Y (yaw) then X (pitch), then perspective.
        const x1 = n.x * cosY + n.z * sinY;
        const z1 = -n.x * sinY + n.z * cosY;
        const y2 = n.y * cosP - z1 * sinP;
        const z2 = n.y * sinP + z1 * cosP;
        const depth = z2 + cam;
        const k = FOCAL / Math.max(depth, 60);
        return { px: x1 * k + tx, py: y2 * k + ty, k, depth };
      };

      const projections = nodes.map((n) => ({ n, p: project(n) }));
      // Painter's algorithm: far nodes first so near ones draw on top.
      if (mode === "3d") projections.sort((a, b) => b.p.depth - a.p.depth);

      // --- draw ---
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Edge colors must stay clearly visible on the grey canvas: links use
      // the crisp accent, tree edges a solid mid-grey — never the near
      // -invisible border hairline.
      const edgeColor = token("--muted", "#606670");
      const accent = token("--accent", "#2b44c7");
      const linkColor = accent;
      const nodeColor = token("--faint", "#9a9ea6");
      const labelColor = token("--fg", "#1b1d22");

      const byIdProj = new Map(projections.map(({ n, p }) => [n.id, p] as const));
      const depthAlpha = (depth: number) =>
        mode === "2d" ? 1 : Math.max(0.25, Math.min(1, 1.35 - depth / (cam * 1.6)));

      // Edges: tree dashed/lighter, link solid; faded with depth in 3D.
      for (const e of edges) {
        const s = byIdProj.get(e.source);
        const t = byIdProj.get(e.target);
        if (!s || !t) continue;
        ctx.beginPath();
        ctx.moveTo(s.px, s.py);
        ctx.lineTo(t.px, t.py);
        ctx.globalAlpha = depthAlpha((s.depth + t.depth) / 2);
        if (e.kind === "tree") {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth = 1.25;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = linkColor;
          ctx.lineWidth = 1.75;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Nodes + labels (labels only when close enough to read in 3D).
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      projected.current = [];
      for (const { n, p } of projections) {
        const active = n.id === activeId;
        const r = Math.max(1.5, (active ? NODE_R + 2 : NODE_R) * (mode === "2d" ? scale : p.k));
        ctx.globalAlpha = active ? 1 : depthAlpha(p.depth);
        ctx.beginPath();
        ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
        ctx.fillStyle = active ? accent : nodeColor;
        ctx.fill();
        if (active) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = accent;
          ctx.stroke();
        }
        const fontPx = mode === "2d" ? 12 * scale : 12 * p.k;
        if (fontPx >= 7 || active) {
          ctx.font = `${Math.min(14, fontPx)}px var(--font-sans, system-ui)`;
          const label = (n.icon ? `${n.icon} ` : "") + (n.title || "Untitled");
          ctx.fillStyle = active ? accent : labelColor;
          ctx.fillText(label.length > 28 ? `${label.slice(0, 27)}…` : label, p.px, p.py + r + 4);
        }
        projected.current.push({ id: n.id, sx: p.px, sy: p.py, r, depth: p.depth });
      }
      ctx.globalAlpha = 1;
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
  }, [nodes, edges, activeId, mode]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false, pan: e.shiftKey };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.current.moved = true;
    if (mode === "3d" && !drag.current.pan) {
      // Orbit; pitch clamped so the scene never flips.
      view.current.yaw += dx * 0.006;
      view.current.pitch = Math.max(-1.4, Math.min(1.4, view.current.pitch + dy * 0.006));
    } else {
      view.current.tx += dx;
      view.current.ty += dy;
    }
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // A click (no drag): open the node under the cursor, nearest-in-depth on
    // overlap. Hit test against last frame's projected positions.
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let hit: Projected | null = null;
    for (const p of projected.current) {
      const dx = p.sx - px;
      const dy = p.sy - py;
      const tol = Math.max(HIT_R, p.r + 6);
      if (dx * dx + dy * dy <= tol * tol && (!hit || p.depth < hit.depth)) {
        hit = p;
      }
    }
    if (hit) onOpen(hit.id);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (mode === "3d") {
      // Dolly the orbit camera.
      const factor = e.deltaY < 0 ? 1 / 1.1 : 1.1;
      view.current.cam = Math.min(MAX_CAM, Math.max(MIN_CAM, view.current.cam * factor));
      return;
    }
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const { scale, tx, ty } = view.current;
    const wx = (e.clientX - rect.left - tx) / scale;
    const wy = (e.clientY - rect.top - ty) / scale;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(3, Math.max(0.2, scale * factor));
    // Zoom toward the cursor: keep the world point under the pointer fixed.
    view.current.tx = e.clientX - rect.left - wx * next;
    view.current.ty = e.clientY - rect.top - wy * next;
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
