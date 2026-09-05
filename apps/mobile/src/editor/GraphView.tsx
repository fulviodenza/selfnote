/**
 * Graph view (docs/features/backlinks-graph.md §5) — the mobile parity for web's
 * GraphView, reachable from the document-list topbar (parity with the sidebar
 * "Graph" entry).
 *
 * Fetches GET /workspaces/:id/graph and renders a force-directed graph natively
 * with react-native-svg positioned by a d3-force simulation (no server-side
 * layout, matching web). Node/edge styling mirrors web: `link` edges are solid,
 * `tree` edges dashed/lighter; the currently-open document (if any) is
 * highlighted. Tapping a node opens that document. Pan + pinch-zoom via a
 * PanResponder over an SVG viewBox transform. Graph requires the network — when
 * offline (or the fetch fails) we show the standard offline placeholder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
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
} from "d3-force";
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

const NODE_R = 7;
const ACTIVE_R = 10;

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
  // Force a re-render as the simulation ticks (positions live on the sim nodes).
  const [, setTick] = useState(0);

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodes = useRef<SimNode[]>([]);
  const simLinks = useRef<SimLink[]>([]);

  // View transform (pan + zoom), applied as an SVG group transform.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

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

  // (Re)build and run the force simulation whenever the graph data changes.
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

    const sim = forceSimulation<SimNode, SimLink>(sn)
      .force(
        "link",
        forceLink<SimNode, SimLink>(sl)
          .id((d) => d.id)
          .distance(70)
          .strength(0.4),
      )
      .force("charge", forceManyBody<SimNode>().strength(-160))
      .force("center", forceCenter(width / 2, height / 2))
      .on("tick", () => setTick((t) => (t + 1) % 1000000));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, edges, width]);

  // Pan/zoom: single finger pans; two fingers pinch-zoom about the canvas center.
  const gesture = useRef({ startView: view, startDist: 0 });
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2 || _e.nativeEvent.touches.length === 2,
        onPanResponderGrant: () => {
          gesture.current.startView = viewRef.current;
          gesture.current.startDist = 0;
        },
        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;
          const start = gesture.current.startView;
          if (touches.length === 2) {
            const [a, b] = touches;
            const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            if (gesture.current.startDist === 0) {
              gesture.current.startDist = dist;
              gesture.current.startView = viewRef.current;
              return;
            }
            const k = clamp(start.k * (dist / gesture.current.startDist), 0.3, 3);
            setView({ ...start, k });
          } else {
            setView({ ...start, x: start.x + g.dx, y: start.y + g.dy });
          }
        },
      }),
    [],
  );

  // Hit-test a tap against node positions (in canvas coords) → open that doc.
  const onCanvasTap = (px: number, py: number) => {
    const v = viewRef.current;
    // Invert the group transform: screen = pos*k + translate.
    const cx = (px - v.x) / v.k;
    const cy = (py - v.y) / v.k;
    let hit: SimNode | null = null;
    let best = Infinity;
    for (const n of simNodes.current) {
      if (n.x == null || n.y == null) continue;
      const d = Math.hypot(n.x - cx, n.y - cy);
      if (d < 16 && d < best) {
        best = d;
        hit = n;
      }
    }
    if (hit) onOpenDoc(hit.id);
  };

  return (
    <View style={styles.flex}>
      <View style={[styles.topbar, { borderBottomColor: colors.hairline, backgroundColor: colors.paper }]}>
        <IconButton icon="chevron-left" label="Back to documents" onPress={onBack} />
        <Text style={[type.docTitle, styles.flex]} numberOfLines={1}>
          Graph
        </Text>
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
            <G x={view.x} y={view.y} scale={view.k}>
              {simLinks.current.map((l, i) => {
                const s = l.source as SimNode;
                const t = l.target as SimNode;
                if (s.x == null || s.y == null || t.x == null || t.y == null) return null;
                return (
                  <Line
                    key={i}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={l.kind === "tree" ? colors.inkFaint : colors.accent}
                    strokeWidth={l.kind === "tree" ? 1 : 1.5}
                    strokeOpacity={l.kind === "tree" ? 0.5 : 0.8}
                    strokeDasharray={l.kind === "tree" ? "4 4" : undefined}
                  />
                );
              })}
              {simNodes.current.map((n) => {
                if (n.x == null || n.y == null) return null;
                const isActive = n.id === activeId;
                return (
                  <G key={n.id} x={n.x} y={n.y}>
                    <Circle
                      r={isActive ? ACTIVE_R : NODE_R}
                      fill={isActive ? colors.accent : colors.surface}
                      stroke={isActive ? colors.accentPressed : colors.inkSoft}
                      strokeWidth={isActive ? 2 : 1.5}
                    />
                    <SvgText
                      x={0}
                      y={(isActive ? ACTIVE_R : NODE_R) + 12}
                      fontSize={11}
                      fill={colors.ink}
                      textAnchor="middle"
                    >
                      {truncate(n.icon ? `${n.icon} ${n.title || "Untitled"}` : n.title || "Untitled")}
                    </SvgText>
                  </G>
                );
              })}
            </G>
          </Svg>
          <Text style={[type.meta, styles.hint, { color: colors.inkFaint }]}>
            Drag to pan · pinch to zoom · tap a node to open
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
});
