/**
 * Graph view (docs/features/backlinks-graph.md §5) — the mobile parity for web's
 * GraphView, reachable from the document-list topbar, explorable in 2D or 3D.
 *
 * Fetches GET /workspaces/:id/graph and lays it out with d3-force-3d (the
 * d3-force API with a third dimension; no server-side layout, matching web).
 * 3D renders through a yaw/pitch orbit camera with perspective and depth cues
 * (far nodes smaller and faded, painter's ordering); 2D is the flat layout.
 * One-finger drag orbits in 3D / pans in 2D; pinch dollies the camera in 3D /
 * zooms in 2D; tapping a node opens that document. Node/edge styling mirrors
 * web: `link` edges solid accent, `tree` edges dashed mid-grey; the
 * currently-open document is highlighted. Graph requires the network — when
 * offline (or the fetch fails) we show the standard offline placeholder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, { Circle, G, Line, Text as SvgText } from "react-native-svg";
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force-3d";
import { api, type DocumentRef, type GraphEdge } from "../api";
import { spacing } from "../theme";
import { useTheme } from "../theme-context";
import { IconButton } from "../ui";

export interface GraphViewProps {
  workspaceId: string;
  /** The doc currently open in the editor (highlighted), if any. */
  activeId?: string | null;
  offline?: boolean;
  onBack: () => void;
  /** Tapping a node opens that document (and typically closes the graph). */
  onOpenDoc: (id: string) => void;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  icon: string | null;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: "link" | "tree";
}

type GraphMode = "2d" | "3d";

const NODE_R = 7;
const ACTIVE_R = 10;
const FOCAL = 600; // perspective focal length
const MIN_CAM = 220;
const MAX_CAM = 2600;

export function GraphView({
  workspaceId,
  activeId,
  offline = false,
  onBack,
  onOpenDoc,
}: GraphViewProps) {
  const { colors, type } = useTheme();
  const { width } = useWindowDimensions();
  const height = 480; // the SVG canvas height; the view fills the rest with chrome
  const [nodes, setNodes] = useState<DocumentRef[] | null>(null);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<GraphMode>("3d");
  // Force a re-render as the simulation ticks (positions live on the sim nodes).
  const [, setTick] = useState(0);

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodes = useRef<SimNode[]>([]);
  const simLinks = useRef<SimLink[]>([]);

  // 2D view transform (pan + zoom) and the 3D orbit camera. Both in state so
  // gestures re-render; the sim positions live on refs.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [camera, setCamera] = useState({ yaw: 0.6, pitch: 0.35, cam: 800 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (offline) return;
    let alive = true;
    setNodes(null);
    setError(false);
    (async () => {
      try {
        const g = await api.getGraph(workspaceId);
        if (!alive) return;
        setNodes(g.nodes);
        setEdges(g.edges);
      } catch {
        if (alive) {
          setError(true);
          setNodes(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, offline]);

  // (Re)build and run the force simulation whenever the graph data or the
  // dimensionality changes. The sim runs around the ORIGIN; projection adds
  // the screen center, so 2D and 3D share coordinates.
  useEffect(() => {
    simRef.current?.stop();
    if (!nodes || nodes.length === 0) {
      simNodes.current = [];
      simLinks.current = [];
      return;
    }
    const nodeById = new Map<string, SimNode>();
    const sn: SimNode[] = nodes.map((n) => {
      const node: SimNode = { id: n.id, title: n.title, icon: n.icon };
      nodeById.set(n.id, node);
      return node;
    });
    // Only keep edges whose endpoints are present (archived nodes are omitted
    // server-side, but guard anyway) and map to the live node objects.
    const sl: SimLink[] = edges
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
      .map((e) => ({
        source: nodeById.get(e.source)!,
        target: nodeById.get(e.target)!,
        kind: e.kind,
      }));
    simNodes.current = sn;
    simLinks.current = sl;

    // Run the simulation in coarse chunks instead of re-rendering per tick:
    // a tick-driven render pushes the whole SVG tree over the bridge ~60×/s,
    // which is what made the graph unusable on device. ~24 ticks per frame
    // settles a typical workspace in a dozen renders.
    const sim = forceSimulation<SimNode, SimLink>(sn, mode === "3d" ? 3 : 2)
      .force(
        "link",
        forceLink<SimNode, SimLink>(sl)
          .id((d) => d.id)
          .distance(70)
          .strength(0.4),
      )
      .force("charge", forceManyBody<SimNode>().strength(-160))
      .force("center", forceCenter(0, 0, 0))
      .stop();
    simRef.current = sim;

    const totalTicks = Math.ceil(
      Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()),
    );
    let done = 0;
    let raf = 0;
    const step = () => {
      const n = Math.min(24, totalTicks - done);
      sim.tick(n);
      done += n;
      setTick((t) => (t + 1) % 1000000);
      if (done < totalTicks) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      sim.stop();
    };
  }, [nodes, edges, mode]);

  // Project a sim node through the current camera into screen coordinates.
  const cx = width / 2;
  const cy = height / 2;
  const project = (n: { x?: number; y?: number; z?: number }) => {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (modeRef.current === "2d") {
      const v = viewRef.current;
      return { px: x * v.k + cx + v.x, py: y * v.k + cy + v.y, k: v.k, depth: 0 };
    }
    const z = n.z ?? 0;
    const { yaw, pitch, cam } = cameraRef.current;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const x1 = x * cosY + z * sinY;
    const z1 = -x * sinY + z * cosY;
    const y2 = y * cosP - z1 * sinP;
    const z2 = y * sinP + z1 * cosP;
    const depth = z2 + cam;
    const k = FOCAL / Math.max(depth, 50);
    const v = viewRef.current;
    return { px: x1 * k + cx + v.x, py: y2 * k + cy + v.y, k, depth };
  };

  // One finger: orbit (3D) / pan (2D). Two fingers: dolly (3D) / zoom (2D).
  // Move events fire faster than frames; committing camera state through one
  // rAF-coalesced setState per frame (instead of per event) keeps the gesture
  // from flooding renders. Labels hide while a gesture is live (interacting):
  // SVG text is the most expensive part of the scene on RN.
  const [interacting, setInteracting] = useState(false);
  const pendingCommit = useRef<(() => void) | null>(null);
  const commitFrame = useRef<number | null>(null);
  const schedule = (commit: () => void) => {
    pendingCommit.current = commit;
    if (commitFrame.current == null) {
      commitFrame.current = requestAnimationFrame(() => {
        commitFrame.current = null;
        pendingCommit.current?.();
        pendingCommit.current = null;
      });
    }
  };
  useEffect(
    () => () => {
      if (commitFrame.current != null) cancelAnimationFrame(commitFrame.current);
    },
    [],
  );

  const gesture = useRef({ startView: view, startCamera: camera, startDist: 0 });
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2 || _e.nativeEvent.touches.length === 2,
        onPanResponderGrant: () => {
          gesture.current.startView = viewRef.current;
          gesture.current.startCamera = cameraRef.current;
          gesture.current.startDist = 0;
          setInteracting(true);
        },
        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;
          if (touches.length === 2) {
            const [a, b] = touches;
            const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            if (gesture.current.startDist === 0) {
              gesture.current.startDist = dist;
              gesture.current.startView = viewRef.current;
              gesture.current.startCamera = cameraRef.current;
              return;
            }
            const ratio = dist / gesture.current.startDist;
            if (modeRef.current === "3d") {
              const cam = clamp(gesture.current.startCamera.cam / ratio, MIN_CAM, MAX_CAM);
              schedule(() => setCamera({ ...gesture.current.startCamera, cam }));
            } else {
              const k = clamp(gesture.current.startView.k * ratio, 0.3, 3);
              schedule(() => setView({ ...gesture.current.startView, k }));
            }
          } else if (modeRef.current === "3d") {
            const start = gesture.current.startCamera;
            schedule(() =>
              setCamera({
                cam: start.cam,
                yaw: start.yaw + g.dx * 0.008,
                pitch: clamp(start.pitch + g.dy * 0.008, -1.4, 1.4),
              }),
            );
          } else {
            const start = gesture.current.startView;
            schedule(() => setView({ ...start, x: start.x + g.dx, y: start.y + g.dy }));
          }
        },
        onPanResponderRelease: () => setInteracting(false),
        onPanResponderTerminate: () => setInteracting(false),
      }),
    [],
  );

  // Hit-test a tap against PROJECTED node positions → open that doc. Nearest
  // in depth wins when projections overlap.
  const onCanvasTap = (px: number, py: number) => {
    let hit: SimNode | null = null;
    let hitDepth = Infinity;
    for (const n of simNodes.current) {
      const p = project(n);
      const d = Math.hypot(p.px - px, p.py - py);
      if (d < Math.max(16, NODE_R * p.k + 6) && p.depth < hitDepth) {
        hitDepth = p.depth;
        hit = n;
      }
    }
    if (hit) onOpenDoc(hit.id);
  };

  // Far-to-near ordering so near nodes draw (and label) on top in 3D.
  const drawNodes = [...simNodes.current]
    .map((n) => ({ n, p: project(n) }))
    .sort((a, b) => b.p.depth - a.p.depth);
  const depthAlpha = (depth: number) =>
    modeRef.current === "2d"
      ? 1
      : clamp(1.35 - depth / (cameraRef.current.cam * 1.6), 0.25, 1);

  return (
    <View style={styles.flex}>
      <View style={[styles.topbar, { borderBottomColor: colors.hairline, backgroundColor: colors.paper }]}>
        <IconButton icon="chevron-left" label="Back to documents" onPress={onBack} />
        <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
          Graph
        </Text>
        <View style={[styles.modeSwitch, { borderColor: colors.hairline }]}>
          {(["2d", "3d"] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[styles.modeBtn, mode === m && { backgroundColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
            >
              <Text
                style={[
                  styles.modeText,
                  { color: mode === m ? colors.onAccent : colors.inkSoft },
                ]}
              >
                {m.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {offline ? (
        <Placeholder text="The graph is unavailable offline." />
      ) : error ? (
        <Placeholder text="Couldn't load the graph." />
      ) : nodes === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : nodes.length === 0 ? (
        <Placeholder text="No notes to graph yet." />
      ) : (
        <View
          style={[styles.canvas, { backgroundColor: colors.surface }]}
          {...panResponder.panHandlers}
          onStartShouldSetResponderCapture={() => false}
        >
          <Svg
            width={width}
            height={height}
            onPress={(e) => onCanvasTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
          >
            {simLinks.current.map((l, i) => {
              const s = project(l.source as SimNode);
              const t = project(l.target as SimNode);
              const alpha = depthAlpha((s.depth + t.depth) / 2);
              return (
                <Line
                  key={i}
                  x1={s.px}
                  y1={s.py}
                  x2={t.px}
                  y2={t.py}
                  stroke={l.kind === "tree" ? colors.inkSoft : colors.accent}
                  strokeWidth={l.kind === "tree" ? 1.25 : 2}
                  strokeOpacity={(l.kind === "tree" ? 0.7 : 1) * alpha}
                  strokeDasharray={l.kind === "tree" ? "4 4" : undefined}
                />
              );
            })}
            {drawNodes.map(({ n, p }, i) => {
              const isActive = n.id === activeId;
              const r = Math.max(2, (isActive ? ACTIVE_R : NODE_R) * p.k);
              const alpha = isActive ? 1 : depthAlpha(p.depth);
              const fontPx = 11 * p.k;
              // Labels only for the ~40 nearest nodes, and never mid-gesture.
              const showLabel =
                isActive || (!interacting && fontPx >= 6 && i >= drawNodes.length - 40);
              return (
                <G key={n.id} x={p.px} y={p.py} opacity={alpha}>
                  <Circle
                    r={r}
                    fill={isActive ? colors.accent : colors.surface}
                    stroke={isActive ? colors.accentPressed : colors.inkSoft}
                    strokeWidth={isActive ? 2 : 1.5}
                  />
                  {showLabel ? (
                    <SvgText
                      x={0}
                      y={r + 12}
                      fontSize={Math.min(13, fontPx)}
                      fill={colors.ink}
                      textAnchor="middle"
                    >
                      {truncate(n.icon ? `${n.icon} ${n.title || "Untitled"}` : n.title || "Untitled")}
                    </SvgText>
                  ) : null}
                </G>
              );
            })}
          </Svg>
          <Text style={[type.meta, styles.hint, { color: colors.inkFaint }]}>
            {mode === "3d"
              ? "Drag to orbit · pinch to zoom · tap a node to open"
              : "Drag to pan · pinch to zoom · tap a node to open"}
          </Text>
        </View>
      )}
    </View>
  );
}

function Placeholder({ text }: { text: string }) {
  const { colors, type } = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[type.body, { color: colors.inkSoft, textAlign: "center" }]}>{text}</Text>
    </View>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(s: string, max = 18) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: 56,
    borderBottomWidth: 1,
  },
  canvas: { flex: 1, overflow: "hidden" },
  hint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: spacing.lg,
    textAlign: "center",
  },
  modeSwitch: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  modeBtn: { paddingHorizontal: 10, paddingVertical: 4 },
  modeText: { fontSize: 12, fontWeight: "600" },
});
