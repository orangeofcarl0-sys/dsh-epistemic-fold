/**
 * R37-A3: layered DSML parsing, provenance, and rejection diagnostics.
 *
 * The fixtures cover the forms observed in R36 and the failure modes the
 * protocol must not guess around. The experimental P4 layer is tested but is
 * not described as production behavior.
 *
 * @module tests/r37-protocol
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeTurn,
  decodeDsmlAttribute,
  parseJsonLayer,
  scanEmitted,
} from '../eval/r37/src/tool-protocol-r37.mjs'

const D = '｜｜DSML｜｜'

function invoke(tool: string, body: string): string {
  return `<${D} invoke name="${tool}">\n${body}\n</${D} invoke>`
}

const readParameter = invoke('read_file', `<${D} parameter name="path">src/config.mjs</${D} parameter>`)
const readShort = invoke('read_file', `<${D} path="src/config.mjs">`)

describe('R37-A3: DSML layers', () => {
  it('P0 parses only JSON, P1 adds the parameter form', () => {
    expect(analyzeTurn(readParameter, 'P0').actions).toEqual([])
    const p1 = analyzeTurn(readParameter, 'P1')
    expect(p1.actions).toHaveLength(1)
    expect(p1.actions[0].tool).toBe('read_file')
    expect(p1.actions[0].params.path).toBe('src/config.mjs')
  })

  it('P1 does not recognize the short-attribute form; P2 does', () => {
    expect(analyzeTurn(readShort, 'P1').actions).toEqual([])
    const p2 = analyzeTurn(readShort, 'P2')
    expect(p2.actions).toHaveLength(1)
    expect(p2.actions[0].params.path).toBe('src/config.mjs')
  })

  it('P2 parses one action; P3 parses multiple actions in one turn', () => {
    const text = [
      invoke('read_file', `<${D} path="src/config.mjs">`),
      invoke('read_file', `<${D} path="tests/config.test.mjs">`),
    ].join('\n')
    expect(analyzeTurn(text, 'P2').actions).toHaveLength(1)
    expect(analyzeTurn(text, 'P3').actions).toHaveLength(2)
  })

  it('P3 keeps escaped attribute bytes; P3e decodes them', () => {
    const text = invoke('write_file', [
      `<${D} path="src/scheduler.mjs">`,
      `<${D} content="throw new Error(\\\`full \\\${size}\\\`)">`,
    ].join('\n'))
    const p3 = analyzeTurn(text, 'P3')
    const p3e = analyzeTurn(text, 'P3e')
    expect(p3.invalid).toEqual([])
    expect(p3e.invalid).toEqual([])
    expect(p3.actions[0].params.content).toContain('\\`')
    expect(p3.actions[0].params.content).toContain('\\${')
    expect(p3e.actions[0].params.content).toContain('`')
    expect(p3e.actions[0].params.content).toContain('${')
    expect(decodeDsmlAttribute('a\\`b\\${c}')).toBe('a`b${c}')
  })

  it('rejects an unclosed invoke instead of guessing', () => {
    const result = analyzeTurn(`<${D} invoke name="write_file">\n<${D} path="src/a.mjs">\ncode`, 'P3')
    expect(result.actions).toEqual([])
    expect(result.diagnostics.some((entry: any) => entry.reason === 'truncated-invoke')).toBe(true)
  })

  it('rejects a bare short attribute with no enclosing invoke', () => {
    const result = analyzeTurn(`<${D} path="src/config.mjs">`, 'P3')
    expect(result.actions).toEqual([])
  })
})

describe('R37-A3: validation and ambiguity', () => {
  it('rejects an unknown tool', () => {
    const result = analyzeTurn(invoke('delete_everything', `<${D} path="src/config.mjs">`), 'P3')
    expect(result.actions).toEqual([])
    expect(result.invalid[0].reasons[0].reason).toBe('unknown-tool')
  })

  it('rejects a missing required parameter', () => {
    const result = analyzeTurn(invoke('write_file', `<${D} path="src/config.mjs">`), 'P3')
    expect(result.actions).toEqual([])
    expect(result.invalid[0].reasons.some((reason: any) => reason.reason === 'missing-parameter')).toBe(true)
  })

  it('rejects a parameter of the wrong type', () => {
    const result = analyzeTurn('{"tool":"read_file","path":42}', 'P3')
    expect(result.actions).toEqual([])
    expect(result.invalid[0].reasons.some((reason: any) => reason.reason === 'parameter-type')).toBe(true)
  })

  it('rejects a path that escapes the workspace', () => {
    const result = analyzeTurn(invoke('read_file', `<${D} path="../secret.txt">`), 'P3')
    expect(result.actions).toEqual([])
    expect(result.invalid[0].reasons.some((reason: any) => reason.reason === 'path-escape')).toBe(true)
  })

  it('keeps duplicate requests but records the diagnostic', () => {
    const text = [
      invoke('read_file', `<${D} path="src/config.mjs">`),
      invoke('read_file', `<${D} path="src/config.mjs">`),
    ].join('\n')
    const result = analyzeTurn(text, 'P3')
    expect(result.actions).toHaveLength(2)
    expect(result.actions[0].duplicate).toBe(false)
    expect(result.actions[1].duplicate).toBe(true)
    expect(result.diagnostics.some((entry: any) => entry.reason === 'duplicate-action')).toBe(true)
  })

  it('does not dispatch a tool result or file text as an action', () => {
    for (const source of ['tool-result', 'file-content', 'user-message']) {
      const result = analyzeTurn(readParameter, 'P3', source)
      expect(result.actions).toEqual([])
      expect(result.diagnostics[0].reason).toBe('untrusted-source')
    }
  })

  it('counts emitted constructs independently of recognition', () => {
    const scan = scanEmitted(`${readParameter}\n{"tool":"run_tests"}`)
    expect(scan.dsmlInvokes).toBe(1)
    expect(scan.jsonActions).toBe(1)
    expect(scan.emitted).toBe(2)
  })
})

describe('R37-A3: experimental raw-body layer', () => {
  it('P3e does not infer raw-body content; P4 does, and labels it', () => {
    const text = invoke('write_file', [
      `<${D} path="src/new.mjs">`,
      'export const value = 1',
    ].join('\n'))
    expect(analyzeTurn(text, 'P3e').actions).toEqual([])
    const p4 = analyzeTurn(text, 'P4')
    expect(p4.actions).toHaveLength(1)
    expect(p4.actions[0].params.content).toBe('export const value = 1')
    expect(p4.actions[0].params.__rawBody).toBe(true)
  })
})

describe('R37-A3: JSON layer behavior', () => {
  it('P0/P1/P2 take the first JSON action, P3 takes all', () => {
    const text = '{"tool":"read_file","path":"a"}\n{"tool":"read_file","path":"b"}'
    expect(parseJsonLayer(text, false)).toHaveLength(1)
    expect(parseJsonLayer(text, true)).toHaveLength(2)
  })

  it('does not parse a JSON object without a tool string', () => {
    expect(parseJsonLayer('{"path":"a"}', true)).toEqual([])
  })
})
