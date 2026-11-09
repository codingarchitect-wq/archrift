// The part of d3-force-3d (which ships no types) the galaxy layout uses.
declare module 'd3-force-3d' {
  type Accessor<T, R> = R | ((d: T, i: number, all: T[]) => R)

  export interface Force<N> {
    (alpha: number): void
    initialize?: (nodes: N[], ...rest: unknown[]) => void
  }

  export interface Simulation<N> {
    tick(iterations?: number): this
    stop(): this
    alpha(a: number): this
    alphaDecay(d: number): this
    randomSource(f: () => number): this
    force(name: string, force: Force<N> | ((alpha: number) => void) | null): this
    nodes(): N[]
  }

  export function forceSimulation<N>(nodes: N[], numDimensions?: 1 | 2 | 3): Simulation<N>

  export interface LinkForce<N, L> extends Force<N> {
    id(f: (d: N) => string): this
    distance(d: Accessor<L, number>): this
    strength(s: Accessor<L, number>): this
  }
  export function forceLink<N, L>(links: L[]): LinkForce<N, L>

  export interface ManyBodyForce<N> extends Force<N> {
    strength(s: Accessor<N, number>): this
    theta(t: number): this
    distanceMax(d: number): this
  }
  export function forceManyBody<N>(): ManyBodyForce<N>

  export function forceCenter<N>(x?: number, y?: number, z?: number): Force<N>
}
