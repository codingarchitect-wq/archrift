// Where a script's text is code and where it only talks about code: comments,
// strings and template literals, regular expressions.
import { describe, expect, it } from 'vitest'
import { hideSpans, isScript, keepSpans, literalSpans, proseOf } from '../../src/analyzer/ts/lexical.ts'

const spans = (text: string, jsx = false) => literalSpans(text, jsx).map(s => [s.kind, text.slice(s.start, s.end)])

describe('the literals of a script', () => {
  it('tells a regular expression from a division', () => {
    expect(spans('const a = b / c / d; const r = /a\\/b[/]c/g.test(x)')).toEqual([['regex', '/a\\/b[/]c/g']])
    expect(spans('if (/re/.test(v)) return /x/; const q = x.default / 2')).toEqual([
      ['regex', '/re/'],
      ['regex', '/x/'],
    ])
    expect(spans('const n = (a + b) / 2 / c[i] / this.k')).toEqual([])
  })

  it('follows template literals through their ${…}, nested braces and templates included', () => {
    expect(spans('const s = `x ${ {k: `in ${y}`}.k } z ${w}` + "q"')).toEqual([
      ['string', '`x ${'],
      ['string', '`in ${'],
      ['string', '}`'],
      ['string', '} z ${'],
      ['string', '}`'],
      ['string', '"q"'],
    ])
  })

  it('finds comments of both kinds', () => {
    expect(spans("// one\nconst a = 'b' /* two */\n")).toEqual([
      ['comment', '// one'],
      ['string', "'b'"],
      ['comment', '/* two */'],
    ])
  })

  it('reads TypeScript, JavaScript and their JSX flavours as scripts, nothing else', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cjs', 'a.jsx', 'a.kt', 'a.go', 'a.html', 'a.d.ts'].map(isScript)).toEqual([true, true, true, true, true, false, false, false, true])
  })
})

describe('views of a script', () => {
  const text = "const re = /alert\\(/ // alert( here\nalert('saved')\n"

  it('hides what is picked, keeping length, lines and columns', () => {
    const code = hideSpans(text, literalSpans(text), kind => kind !== 'string')
    expect(code).toHaveLength(text.length)
    expect(code.split('\n').map(l => l.length)).toEqual(text.split('\n').map(l => l.length))
    expect(code).toBe(`const re = ${' '.repeat('/alert\\(/'.length)} ${' '.repeat('// alert( here'.length)}\nalert('saved')\n`)
  })

  it('keeps only what is picked', () => {
    expect(keepSpans(text, literalSpans(text), kind => kind === 'comment')).toBe(`${' '.repeat(21)}// alert( here\n${' '.repeat(14)}\n`)
  })

  it('reads a decision id in comments and strings, never in code', () => {
    const prose = proseOf("type P2 = [number, number] // see D34\nit('M29 holds', () => {})\nconst re = /R6/\n", 'a.ts')
    expect(prose).toBe(`${' '.repeat(27)}// see D34\n   'M29 holds'${' '.repeat(', () => {})'.length)}\n${' '.repeat(15)}\n`)
  })
})
