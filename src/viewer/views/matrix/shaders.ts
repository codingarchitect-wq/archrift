// GLSL for the Matrix view: cells, header glyphs, column ticks and the digital
// rain, each one instanced quad per item so a family costs one draw call.
// Per-row color and state live in a small texture (uUnits): rgb = the row's
// color (as its strip), a = 1 selected, 2/3 related, 1/3 nothing selected, 0 ghosted.

/** Width of the per-row texture (rows wrap onto more lines). */
export const UNITS_WIDTH = 1024

const units = /* glsl */ `
uniform sampler2D uUnits;
vec4 unitAt(float i) {
  return texelFetch(uUnits, ivec2(int(mod(i, ${UNITS_WIDTH}.0)), int(floor(i / ${UNITS_WIDTH}.0))), 0);
}
`

/** A glyph of the atlas at uv (0–1 in its box, y up); the window is the part of the slot a glyph covers. */
const glyph = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uWindow;
float glyphAt(float index, vec2 uv, vec2 dx, vec2 dy) {
  vec2 slot = vec2(mod(index, 16.0), 15.0 - floor(index / 16.0));
  vec2 scale = vec2(uWindow, 0.96) / 16.0;
  vec2 p = (slot + vec2(0.5 - uWindow * 0.5, 0.02)) / 16.0 + uv * scale;
  // gradients from the continuous coordinates: no seams where the glyph changes
  return textureGrad(uAtlas, p, dx * scale, dy * scale).a;
}
`

export const cellsVertex = /* glsl */ `
attribute vec2 aCell;
attribute vec4 aStyle;
uniform float uCell;
uniform float uSide;
uniform float uSelMode;
uniform float uCellPixels;
uniform float uDimmed;
${units}
varying vec3 vColor;
varying vec2 vUv;
varying float vKind;
varying float vDim;
void main() {
  float kind = aStyle.w;
  float grow = kind > 4.5 ? 0.9 : kind > 2.5 ? 0.98 : 0.8;
  // small on screen: fill the cell, and never shrink below about a pixel and a half
  grow = max(mix(1.0, grow, smoothstep(3.0, 8.0, uCellPixels)), 1.5 / max(uCellPixels, 0.01));
  vec2 center = vec2((aCell.x + 0.5) * uCell, uSide - (aCell.y + 0.5) * uCell);
  float rs = unitAt(aCell.y).a;
  float cs = unitAt(aCell.x).a;
  float on = 1.0;
  if (uSelMode > 1.5) on = rs > 0.5 && cs > 0.5 ? 1.0 : 0.0;
  else if (uSelMode > 0.5) on = rs > 0.9 || cs > 0.9 ? 1.0 : 0.0;
  vDim = kind > 4.5 ? 1.0 : mix(uDimmed, 1.0, on);
  vColor = aStyle.rgb;
  vKind = kind;
  vUv = position.xy + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(center + position.xy * uCell * grow, 0.0, 1.0);
}
`

export const cellsFragment = /* glsl */ `
uniform vec3 uBackground;
uniform float uFade;
varying vec3 vColor;
varying vec2 vUv;
varying float vKind;
varying float vDim;
void main() {
  vec2 d = abs(vUv - 0.5) * 2.0;
  float edge = max(d.x, d.y);
  float px = fwidth(vUv.x);
  float aa = min(px * 2.0, 0.25);
  float body = 1.0 - smoothstep(1.0 - aa, 1.0, edge);
  // big enough on screen to show more than a dot
  float detail = 1.0 - smoothstep(0.06, 0.2, px);
  vec3 color = vColor * mix(1.0, 1.18 - 0.36 * edge, detail);
  if (vKind > 1.5 && vKind < 2.5) body *= mix(1.0, smoothstep(0.38, 0.38 + aa + 0.02, edge), detail); // cycle: a ring
  if (vKind > 2.5 && vKind < 4.5) color = mix(color, vec3(1.0), 0.6 * smoothstep(0.7, 0.84, edge) * detail); // rule: a rim
  if (vKind > 4.5) body *= mix(1.0, smoothstep(0.8, 0.8 + aa + 0.02, edge), detail); // the diagonal: an outline
  if (body < 0.01) discard;
  gl_FragColor = vec4(mix(uBackground, color, vDim), body * uFade);
  #include <colorspace_fragment>
}
`

export const textVertex = /* glsl */ `
attribute vec3 aGlyph;
attribute vec2 aUnit;
uniform vec2 uGlyphSize;
${units}
varying vec2 vUv;
varying float vIndex;
varying float vState;
void main() {
  vec2 c = position.xy;
  // column names read upward: the glyph turned a quarter to the left
  vec2 offset = aUnit.y > 0.5 ? vec2(-c.y * uGlyphSize.y, c.x * uGlyphSize.x) : c * uGlyphSize;
  vUv = c + 0.5;
  vIndex = aGlyph.z;
  vState = unitAt(aUnit.x).a;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aGlyph.xy + offset, 0.0, 1.0);
}
`

export const textFragment = /* glsl */ `
uniform vec3 uText;
uniform vec3 uTextHi;
uniform float uHasSel;
uniform float uFade;
${glyph}
varying vec2 vUv;
varying float vIndex;
varying float vState;
void main() {
  vec2 dx = dFdx(vUv);
  vec2 dy = dFdy(vUv);
  float a = glyphAt(vIndex, vUv, dx, dy);
  // glyph height on screen: names fade in once they can be read
  float px = 1.0 / max(length(vec2(dx.y, dy.y)), 1e-4);
  float legible = smoothstep(5.0, 9.0, px);
  float strength = uHasSel > 0.5 ? (vState > 0.5 ? 1.0 : 0.3) : 0.75;
  float alpha = a * legible * strength * uFade;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(vState > 0.9 ? uTextHi : uText, alpha);
  #include <colorspace_fragment>
}
`

/** A strip per row (left of the matrix) or a tick per column (above it), in the row's color. */
export const ticksVertex = /* glsl */ `
attribute float aIndex;
uniform float uCell;
uniform float uSide;
uniform float uRows;
uniform float uAt;
uniform float uThickness;
${units}
varying vec3 vColor;
void main() {
  vColor = unitAt(aIndex).rgb;
  float along = (aIndex + 0.5) * uCell;
  vec2 center = uRows > 0.5 ? vec2(uAt, uSide - along) : vec2(along, uAt);
  vec2 extent = uRows > 0.5 ? vec2(uThickness, uCell * 0.8) : vec2(uCell * 0.8, uThickness);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(center + position.xy * extent, 0.0, 1.0);
}
`

export const ticksFragment = /* glsl */ `
uniform float uFade;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor * 0.9, uFade);
  #include <colorspace_fragment>
}
`

export const rainVertex = /* glsl */ `
attribute float aColumn;
attribute vec4 aDrop;
attribute float aStart;
uniform float uTime;
uniform float uCell;
uniform float uSide;
uniform float uGlyphH;
uniform float uStatic;
varying float vY;
varying float vHead;
varying float vTrail;
varying float vX;
varying float vColumn;
varying float vAge;
void main() {
  vAge = 0.0;
  if (aStart < -1.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // an idle burst
    return;
  }
  float travel;
  if (aStart < -0.5) travel = mod(uTime * aDrop.x + aDrop.w * aDrop.z, aDrop.z);
  else {
    vAge = uTime - aStart;
    travel = vAge * aDrop.x;
  }
  float head = uSide - travel;
  float lo = clamp(head - uGlyphH, 0.0, uSide);
  float hi = clamp(head + aDrop.y, 0.0, uSide);
  if (uStatic > 0.5) {
    // reduced motion: a burst lights its whole column, fading, instead of falling
    lo = 0.0;
    hi = vAge < 2.0 ? uSide : 0.0;
  }
  float y = mix(lo, hi, position.y + 0.5);
  vY = y;
  vHead = head;
  vTrail = aDrop.y;
  vX = position.x + 0.5;
  vColumn = aColumn;
  gl_Position = projectionMatrix * modelViewMatrix * vec4((aColumn + 0.5 + position.x) * uCell, y, 0.0, 1.0);
}
`

export const rainFragment = /* glsl */ `
uniform float uTime;
uniform float uSide;
uniform float uGlyphH;
uniform float uStatic;
uniform sampler2D uNames;
uniform vec3 uHead;
uniform vec3 uTrail;
uniform float uHeadAlpha;
uniform float uTrailAlpha;
uniform float uGlow;
uniform float uFade;
${glyph}
varying float vY;
varying float vHead;
varying float vTrail;
varying float vX;
varying float vColumn;
varying float vAge;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  float rows = (uSide - vY) / uGlyphH;
  float cell = floor(rows);
  vec2 guv = vec2(vX, 1.0 - fract(rows));
  vec2 dx = vec2(dFdx(vX), -dFdx(rows));
  vec2 dy = vec2(dFdy(vX), -dFdy(rows));
  float px = 1.0 / max(length(vec2(dx.y, dy.y)), 1e-4);
  float k = floor((uSide - vHead) / uGlyphH) - cell; // 0 = the head's glyph, counting up the trail
  if (uStatic > 0.5) {
    float a = uTrailAlpha * clamp(1.0 - vAge / 2.0, 0.0, 1.0) * uFade;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uTrail, a);
    #include <colorspace_fragment>
    return;
  }
  if (k < 0.0) discard;
  float t = k * uGlyphH / max(vTrail, uGlyphH);
  if (t > 1.0) discard;
  // each glyph changes now and then, at its own pace; some spell the column's file name
  float seed = hash(vec2(vColumn, cell));
  float tick = floor(uTime * (0.4 + 2.5 * seed) + seed * 17.0);
  float pick = hash(vec2(vColumn * 1.37 + cell, tick));
  int column = int(vColumn);
  float nameLength = floor(texelFetch(uNames, ivec2(0, column), 0).r * 255.0 + 0.5);
  float index = 96.0 + floor(hash(vec2(pick, 7.7)) * 56.0);
  if (nameLength > 0.5 && pick < 0.3) index = floor(texelFetch(uNames, ivec2(int(mod(cell, nameLength)) + 1, column), 0).r * 255.0 + 0.5);
  else if (pick < 0.42) index = 16.0 + floor(hash(vec2(pick, 3.1)) * 10.0);
  float g = glyphAt(index, guv, dx, dy);
  // too small to read: a soft streak rather than flickering specks
  float streak = 0.5 * (1.0 - smoothstep(0.25, 0.5, abs(vX - 0.5)));
  float glyphs = mix(streak, g, smoothstep(4.0, 8.0, px));
  // a burst's trail glows green as a band, fading behind the head; its glyphs brighter on it
  float band = uGlow * (1.0 - t);
  float head = k < 0.5 ? 1.0 : 0.0;
  float alpha = mix(uTrailAlpha * pow(1.0 - t, 1.5), uHeadAlpha, head) * max(glyphs, band) * uFade;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(mix(uTrail, uHead, head * step(band, glyphs)), alpha);
  #include <colorspace_fragment>
}
`
