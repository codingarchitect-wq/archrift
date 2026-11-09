// A stand-in for Dexie, just enough for the shapes the plugins read.
export interface Table<T, K = string> {
  get(key: K): Promise<T | undefined>
  put(row: T): Promise<K>
}
export class Dexie {
  constructor(_name: string) {}
  version(_n: number) {
    return { stores: (_spec: Record<string, string | null>) => ({ upgrade: (_fn: () => void) => {} }) }
  }
}
