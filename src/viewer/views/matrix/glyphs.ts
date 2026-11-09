// The glyph atlas the Matrix view writes its rain and headers with, drawn once
// on a canvas: printable ASCII (for file names), an ellipsis, and half-width
// katakana mirrored as in the film. White on transparent, 16×16 slots; the
// shaders tint it.
import * as THREE from 'three'

export const ATLAS_GRID = 16
const SLOT = 64
const ELLIPSIS = 95
/** Slots of the digits and of the katakana (the rain's alphabet). */
export const DIGITS = { first: 16, count: 10 }
export const KATAKANA = { first: 96, count: 56 }

/** A character's slot ('?' for what the atlas lacks). */
export function glyphIndex(ch: string): number {
  const code = ch.charCodeAt(0)
  if (code >= 32 && code < 127) return code - 32
  if (ch === '…') return ELLIPSIS
  return 31
}

export function glyphAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SLOT * ATLAS_GRID
  const g = canvas.getContext('2d')!
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const draw = (ch: string, slot: number, font: string, mirror: boolean) => {
    g.save()
    g.translate(((slot % ATLAS_GRID) + 0.5) * SLOT, (Math.floor(slot / ATLAS_GRID) + 0.5) * SLOT)
    if (mirror) g.scale(-1, 1)
    g.font = font
    g.fillText(ch, 0, 2)
    g.restore()
  }
  const mono = '600 50px Menlo, "SF Mono", ui-monospace, Consolas, monospace'
  for (let code = 32; code < 127; code++) draw(String.fromCharCode(code), code - 32, mono, false)
  draw('…', ELLIPSIS, mono, false)
  const kana = '600 48px "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "MS Gothic", "Noto Sans CJK JP", sans-serif'
  for (let k = 0; k < KATAKANA.count; k++) draw(String.fromCharCode(0xff66 + k), KATAKANA.first + k, kana, true)
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4
  return texture
}
