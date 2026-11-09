export interface Shape {
  area(): number
  readonly name: string
}

export type Point = { x: number; y: number }

// value and type with one name: a single node
export const Color = { red: '#f00', blue: '#00f' } as const
export type Color = (typeof Color)[keyof typeof Color]

export enum Unit {
  Px,
  Em,
}
