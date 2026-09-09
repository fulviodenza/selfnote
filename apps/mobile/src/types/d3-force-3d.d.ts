/**
 * Minimal typings for d3-force-3d (no official @types package). API-compatible
 * with d3-force plus a third dimension: nodes gain z/vz and forceSimulation
 * takes numDimensions(1|2|3). Only the surface the GraphView uses is typed.
 */
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<N extends SimulationNodeDatum> {
    source: N | string | number;
    target: N | string | number;
    index?: number;
  }

  export interface Simulation<N extends SimulationNodeDatum, L> {
    numDimensions(n: 1 | 2 | 3): this;
    force(name: string, force?: unknown): this;
    on(name: string, listener: () => void): this;
    stop(): this;
    restart(): this;
    tick(iterations?: number): this;
    alpha(a?: number): this;
    alphaMin(): number;
    alphaDecay(): number;
  }

  export function forceSimulation<N extends SimulationNodeDatum, L = undefined>(
    nodes?: N[],
    numDimensions?: 1 | 2 | 3,
  ): Simulation<N, L>;

  export function forceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(
    links?: L[],
  ): {
    id(fn: (d: N) => string): ReturnType<typeof forceLink<N, L>>;
    distance(d: number): ReturnType<typeof forceLink<N, L>>;
    strength(s: number): ReturnType<typeof forceLink<N, L>>;
  };

  export function forceManyBody<N extends SimulationNodeDatum>(): {
    strength(s: number): ReturnType<typeof forceManyBody<N>>;
  };

  export function forceCenter(x?: number, y?: number, z?: number): unknown;
}
