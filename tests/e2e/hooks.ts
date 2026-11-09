// The viewer's test hooks (window.__archrift, set up in src/viewer/main.tsx).
export interface Hooks {
  ready(): boolean
  idle(): boolean
  select(id: string): Promise<void>
  screenPosition(id: string): { x: number; y: number } | null
  scene(): { view: string; shape: string; arcs: number; highlighted: number; highlightWidth: number; objects: Record<string, number>; decoration: Record<string, number> | null }
  state(): { selected: string | null; task: unknown; options: Record<string, unknown> }
  setOptions(patch: Record<string, unknown>): void
}
declare global {
  interface Window {
    __archrift: Hooks
  }
}
