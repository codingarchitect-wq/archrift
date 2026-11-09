// Stand-ins for React and Dexie, just enough for the shapes the plugins read.
export function createContext<T>(value: T) {
  return { value, Provider: (_props: { value: T; children?: unknown }) => null }
}
export function useContext<T>(context: { value: T }): T {
  return context.value
}
export class Dexie {
  constructor(_name: string) {}
}
export interface Table<T> {
  where(index: string): { toArray(): Promise<T[]> }
  put(row: T): Promise<string>
}
export function Link(_props: { href: string; children?: unknown }) {
  return null
}
export function useRouter() {
  return { push: (_href: string) => {} }
}
