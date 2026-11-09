export function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function parse(v: string): number
export function parse(v: number): number
export function parse(v: string | number): number {
  return typeof v === 'string' ? Number(v) : v
}

export const clamp = (n: number, min: number, max: number) => (n < min ? min : n > max ? max : n)

/** Exported but never used outside this file. */
export function unused(): number {
  return round(1)
}

/** Only the tests use this one. */
export function onlyTested(): boolean {
  return true
}
