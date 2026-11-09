/**
 * The recall affordance: naming the tools in the checkpoint body.
 *
 * ## Why this exists
 *
 * The E2E campaign measured the failure it addresses. Under E0 the checkpoint
 * body was a bare `[EF1 L cp:...]` marker; the recall tools were available in
 * every request; and several exact-recall cells never called them. The model
 * read the workspace, did not find the value, and answered from what it could
 * see. A marker that only machines can interpret is not an affordance.
 *
 * The flag is OFF by default and costs a few tokens when on. This test fixes
 * the contract the experiment relies on: the marker's first line is unchanged,
 * the section appears only when enabled, and it names the real tool names.
 *
 * @module tests/checkpoint-recall-affordance
 */

import { describe, expect, it } from 'vitest'
import { archivedCallsFromMessages, renderStructuredCheckpoint } from '../src/checkpoint/renderer.ts'
import { resolveEfConfig } from '../src/config/policy.ts'
import { emptyCurrentState } from '../src/state/state.ts'

const ID = '11111111-2222-3333-4444-555555555555'

describe('checkpoint recall affordance', () => {
  it('is absent by default and the marker stays the first line', () => {
    const text = renderStructuredCheckpoint(emptyCurrentState(), ID)
    expect(text.split('\n')[0]).toBe(`[EF1 L cp:${ID}]`)
    expect(text).not.toContain('context_search')
    expect(text).not.toContain('Recall')
  })

  it('names both recall tools when enabled, without changing the marker', () => {
    const base = renderStructuredCheckpoint(emptyCurrentState(), ID)
    const text = renderStructuredCheckpoint(emptyCurrentState(), ID, undefined, 'leaf', {
      recallAffordance: true,
    })
    // Identity is parsed from the FIRST line; an affordance must not move it.
    expect(text.split('\n')[0]).toBe(base.split('\n')[0])
    expect(text).toContain('context_search')
    expect(text).toContain('context_recall')
    // The cost has to stay small enough to be an affordance, not a summary.
    expect(text.length - base.length).toBeLessThan(200)
  })

  it('defaults off and rejects a non-boolean, like the other experimental switches', () => {
    expect(resolveEfConfig({}).recallAffordance).toBe(false)
    expect(resolveEfConfig({ recallAffordance: true }).recallAffordance).toBe(true)
    expect(() => resolveEfConfig({ recallAffordance: 'true' as never })).toThrow(/recallAffordance/u)
  })
})

describe('checkpoint archived-call index', () => {
  const call = (name: string, args: unknown) => ({
    type: 'tool-call',
    name,
    arguments: JSON.stringify(args),
  })

  it('lists tool calls by name and addressable detail, deduplicated', () => {
    const calls = archivedCallsFromMessages([
      {
        content: [
          call('read_file', { path: 'logs/a.log' }),
          call('read_file', { path: 'logs/a.log' }),
          call('run_tests', {}),
        ],
      },
      {
        content: [
          call('context_search', { query: 'build id' }),
          call('finish', { summary: 'done' }),
        ],
      },
    ])
    expect(calls).toEqual([
      { name: 'read_file', detail: 'logs/a.log' },
      { name: 'run_tests' },
      { name: 'context_search', detail: 'build id' },
    ])
  })

  it('is bounded, so a long span cannot become a transcript', () => {
    const many = Array.from({ length: 20 }, (_, index) => call('read_file', { path: 'logs/' + index + '.log' }))
    expect(archivedCallsFromMessages([{ content: many }])).toHaveLength(8)
  })

  it('renders only when provided, and the marker stays first', () => {
    const base = renderStructuredCheckpoint(emptyCurrentState(), ID)
    const text = renderStructuredCheckpoint(emptyCurrentState(), ID, undefined, 'leaf', {
      archivedCalls: [{ name: 'read_file', detail: 'logs/a.log' }],
    })
    expect(text.split('\n')[0]).toBe(base.split('\n')[0])
    expect(text).toContain('Archived calls')
    expect(text).toContain('- read_file logs/a.log')
    expect(base).not.toContain('Archived calls')
  })

  it('is a strict boolean', () => {
    expect(resolveEfConfig({}).foldedSpanIndex).toBe(false)
    expect(resolveEfConfig({ foldedSpanIndex: true }).foldedSpanIndex).toBe(true)
    expect(() => resolveEfConfig({ foldedSpanIndex: 'true' as never })).toThrow(/foldedSpanIndex/u)
  })
})
