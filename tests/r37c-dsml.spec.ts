/**
 * R37-C1-A: the DSML codec preserves supported source bytes and rejects
 * ambiguous input instead of guessing.
 *
 * @module tests/r37c-dsml
 */

import { describe, expect, it } from 'vitest'
import {
  FIDELITY_SAMPLES,
  analyzeTurnStrict,
  decodeDsmlAttribute,
  encodeDirectWrite,
  encodeDsmlAttribute,
  encodeParameterWrite,
  parseDsmlStrict,
} from '../eval/r37c/src/dsml-codec.mjs'

describe('R37-C1-A: DSML byte fidelity', () => {
  it('round-trips the fidelity corpus through the direct attribute form', () => {
    for (const source of FIDELITY_SAMPLES) {
      const parsed = parseDsmlStrict(encodeDirectWrite({ path: 'src/x.mjs', content: source }))
      expect(parsed.diagnostics).toEqual([])
      expect(parsed.actions).toHaveLength(1)
      expect(parsed.actions[0].params.content).toBe(source)
    }
  })

  it('round-trips the corpus through the parameter-body form when it is unambiguous', () => {
    for (const source of FIDELITY_SAMPLES) {
      if (source.includes('</｜｜DSML｜｜ parameter>')) continue
      const parsed = parseDsmlStrict(encodeParameterWrite({ path: 'src/x.mjs', content: source }))
      expect(parsed.actions[0].params.content).toBe(source)
    }
  })

  it('preserves leading and trailing spaces, empty content, and indentation', () => {
    for (const source of ['  padded  ', '', 'def f():\n    return 1\n', 'line one\nline two']) {
      const parsed = parseDsmlStrict(encodeDirectWrite({ path: 'x', content: source }))
      expect(parsed.actions[0].params.content).toBe(source)
    }
  })

  it('encodes and decodes backslashes, backticks, ${, and quotes in one pass', () => {
    const source = 'a\\b`c${d}"e\\`f'
    expect(decodeDsmlAttribute(encodeDsmlAttribute(source))).toBe(source)
  })

  it('preserves unknown escapes rather than rewriting them', () => {
    expect(decodeDsmlAttribute('a\\nb')).toBe('a\\nb')
    expect(decodeDsmlAttribute('trailing\\')).toBe('trailing\\')
  })

  it('does not dispatch an unclosed invoke', () => {
    const parsed = parseDsmlStrict('<｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path">x')
    expect(parsed.actions).toEqual([])
    expect(parsed.diagnostics.map((entry: any) => entry.reason)).toContain('truncated-invoke')
  })

  it('does not dispatch a parameter with no closing tag', () => {
    const parsed = parseDsmlStrict('<｜｜DSML｜｜ invoke name="write_file"><｜｜DSML｜｜ parameter name="content">x</｜｜DSML｜｜ invoke>')
    expect(parsed.actions).toEqual([])
    expect(parsed.diagnostics.map((entry: any) => entry.reason)).toContain('truncated-parameter')
  })

  it('rejects a write_file without content', () => {
    const analysis = analyzeTurnStrict('<｜｜DSML｜｜ invoke name="write_file"><｜｜DSML｜｜ path="x"></｜｜DSML｜｜ invoke>')
    expect(analysis.actions).toEqual([])
    expect(analysis.invalid[0].reasons.map((reason: any) => reason.reason)).toContain('missing-parameter')
  })

  it('does not treat tool-result text as a model tool request', () => {
    const text = encodeDirectWrite({ path: 'x', content: 'source' })
    const analysis = analyzeTurnStrict(text, 'tool-result')
    expect(analysis.actions).toEqual([])
    expect(analysis.diagnostics[0].reason).toBe('untrusted-source')
  })

  it('does not treat file content as a model tool request', () => {
    const analysis = analyzeTurnStrict(encodeDirectWrite({ path: 'x', content: 'source' }), 'file-content')
    expect(analysis.actions).toEqual([])
    expect(analysis.diagnostics[0].reason).toBe('untrusted-source')
  })

  it('records a conflicting parameter form', () => {
    const text = '<｜｜DSML｜｜ invoke name="write_file">'
      + '<｜｜DSML｜｜ parameter name="content">a</｜｜DSML｜｜ parameter>'
      + '<｜｜DSML｜｜ content="b">'
      + '</｜｜DSML｜｜ invoke>'
    const parsed = parseDsmlStrict(text)
    expect(parsed.diagnostics.map((entry: any) => entry.reason)).toContain('conflicting-parameter')
    expect(parsed.actions[0].params.content).toBe('a')
  })

  it('records duplicate parameters and keeps the first', () => {
    const text = '<｜｜DSML｜｜ invoke name="write_file">'
      + '<｜｜DSML｜｜ parameter name="content">a</｜｜DSML｜｜ parameter>'
      + '<｜｜DSML｜｜ parameter name="content">b</｜｜DSML｜｜ parameter>'
      + '</｜｜DSML｜｜ invoke>'
    const parsed = parseDsmlStrict(text)
    expect(parsed.diagnostics.map((entry: any) => entry.reason)).toContain('duplicate-parameter')
    expect(parsed.actions[0].params.content).toBe('a')
  })
})
