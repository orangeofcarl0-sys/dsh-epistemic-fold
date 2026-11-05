/**
 * R36-D3: the follow-up loop must parse the protocol the model actually uses.
 *
 * The O2 traces contained DeepSeek DSML tool invocations, not only the JSON
 * object the system prompt asked for. H0 ignored the DSML turns, so tool
 * results were empty and the model concluded the tools were broken. These
 * fixtures are copied from real traces (not invented syntax).
 *
 * @module tests/r36-tool-protocol
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_ACTIONS_PER_TURN,
  parseActions,
  parseDsmlActions,
  parseJsonActions,
} from '../eval/r33/src/tool-protocol.mjs'

describe('R36 tool protocol parser', () => {
  it('parses one JSON action', () => {
    expect(parseActions('{"tool":"read_file","path":"src/config.mjs"}')).toEqual([
      { tool: 'read_file', path: 'src/config.mjs' },
    ])
  })

  it('parses multiple JSON actions in one turn', () => {
    expect(parseActions(
      '{"tool":"read_file","path":"src/config.mjs"}\n{"tool":"run_tests"}',
    )).toEqual([
      { tool: 'read_file', path: 'src/config.mjs' },
      { tool: 'run_tests' },
    ])
  })

  it('parses a DSML invoke with a typed parameter', () => {
    const text = [
      'I will inspect the file.',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="path" string="true">src/config.mjs</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    expect(parseDsmlActions(text)).toEqual([{ tool: 'read_file', path: 'src/config.mjs' }])
    expect(parseActions(text)).toEqual([{ tool: 'read_file', path: 'src/config.mjs' }])
  })

  it('parses parallel DSML invokes', () => {
    const text = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="path">package.json</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="path">src/scheduler.mjs</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    expect(parseActions(text)).toEqual([
      { tool: 'read_file', path: 'package.json' },
      { tool: 'read_file', path: 'src/scheduler.mjs' },
    ])
  })

  it('parses a DSML write with code content and a finish summary', () => {
    const write = [
      '<｜｜DSML｜｜ invoke name="write_file">',
      '<｜｜DSML｜｜ parameter name="path">src/watcher.mjs</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="content" string="true">export function watchChanges() { return { close() {} } }</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
    ].join('\n')
    expect(parseActions(write)).toEqual([{
      tool: 'write_file',
      path: 'src/watcher.mjs',
      content: 'export function watchChanges() { return { close() {} } }',
    }])
    expect(parseActions([
      '<｜｜DSML｜｜ invoke name="finish">',
      '<｜｜DSML｜｜ parameter name="summary" string="true">done</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
    ].join('\n'))).toEqual([{ tool: 'finish', summary: 'done' }])
  })

  it('parses the short direct-attribute form and normalizes a path', () => {
    const text = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ path="tests\\config.test.mjs">',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    expect(parseActions(text)).toEqual([{ tool: 'read_file', path: 'tests/config.test.mjs' }])
  })

  it('does not mistake a JSON snippet inside a DSML parameter for a second action', () => {
    const text = [
      '<｜｜DSML｜｜ invoke name="write_file">',
      '<｜｜DSML｜｜ parameter name="path">x.mjs</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="content">const x = {"tool":"not-an-action"}</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
    ].join('\n')
    expect(parseActions(text)).toEqual([
      { tool: 'write_file', path: 'x.mjs', content: 'const x = {"tool":"not-an-action"}' },
    ])
  })

  it('returns no actions for prose or malformed input', () => {
    expect(parseActions('I will now inspect the file.')).toEqual([])
    expect(parseActions('')).toEqual([])
    expect(parseJsonActions('{"not_tool":true}')).toEqual([])
  })

  it('bounds the number of actions in one turn', () => {
    const text = Array.from(
      { length: MAX_ACTIONS_PER_TURN + 3 },
      () => `<｜｜DSML｜｜ invoke name="list_dir"></｜｜DSML｜｜ invoke>`,
    ).join('\n')
    expect(parseActions(text)).toHaveLength(MAX_ACTIONS_PER_TURN)
  })
})
