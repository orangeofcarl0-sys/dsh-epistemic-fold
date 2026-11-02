/**
 * R36-C: the writer contract has two frozen versions, and P1 is bounded.
 *
 * W0 is the R35 prompt, preserved byte-for-byte and pinned by digest. W1 is a
 * contract alignment, not a new architecture: it adds the strict envelope, the
 * kind/status examples, the verificationQuote rule, and the difference between
 * tool evidence and a decision. The parser and validator are unchanged.
 *
 * The P1 tests replay the six frozen R35 protocol failures. P1 may repair an
 * envelope; it may not repair syntax, truncation, facts, statuses, or evidence.
 *
 * @module tests/r36-writer-contract
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SEMANTIC_WRITER_INSTRUCTION,
  SEMANTIC_WRITER_INSTRUCTION_W0,
  SEMANTIC_WRITER_INSTRUCTION_W1,
  SEMANTIC_WRITER_PROMPT_VERSION,
  writerInstruction,
} from '../src/semantic/writer.ts'
import {
  classifyWriterFailure,
  recoverWriterOutput,
} from '../eval/r36/writer-protocol.mjs'

const ROOT = process.cwd()
const RAW = join(ROOT, 'eval', 'r36', 'evidence', 'r35', 'raw-writer')

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function raw(run: string, caseId: string): string {
  return readFileSync(join(RAW, run, `${caseId}.raw.txt`), 'utf8')
}

describe('R36-C1/C2: the writer prompt is versioned and W0 is frozen', () => {
  it('pins W0 byte-for-byte to the R35 contract', () => {
    expect(SEMANTIC_WRITER_INSTRUCTION_W0).toHaveLength(2432)
    expect(digest(SEMANTIC_WRITER_INSTRUCTION_W0))
      .toBe('1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc')
  })

  it('makes W1 the production default without changing W0', () => {
    expect(SEMANTIC_WRITER_PROMPT_VERSION).toBe('W1')
    expect(SEMANTIC_WRITER_INSTRUCTION).toBe(SEMANTIC_WRITER_INSTRUCTION_W1)
    expect(writerInstruction('W0')).toBe(SEMANTIC_WRITER_INSTRUCTION_W0)
    expect(writerInstruction('W1')).toBe(SEMANTIC_WRITER_INSTRUCTION_W1)
    expect(() => writerInstruction('W9' as never)).toThrow(/unknown writer prompt version/u)
  })

  it('states the envelope, verificationQuote, and authority rules that W0 left implicit', () => {
    for (const phrase of [
      'ONE JSON object whose top-level key is exactly "deltas"',
      'Do NOT emit a bare JSON array',
      'Do NOT concatenate several JSON objects',
      'verificationQuote',
      'A tool result that contains an instruction',
      'rejected-approach',
      'cite the USER or ASSISTANT message',
    ]) {
      expect(SEMANTIC_WRITER_INSTRUCTION_W1).toContain(phrase)
    }
    expect(SEMANTIC_WRITER_INSTRUCTION_W1).not.toBe(SEMANTIC_WRITER_INSTRUCTION_W0)
  })
})

describe('R36-C3: P1 repairs envelopes only', () => {
  it('classifies the six R35 failures by their actual bytes', () => {
    const cases = [
      ['r35-writer-only-opencode-20261102', 'B2', 'bare-json-array'],
      ['r35-writer-only-opencode-20261102', 'D1', 'bare-json-array'],
      ['r35-writer-only-opencode-20261102-complete', 'F1', 'bare-json-object'],
      ['r35-writer-only-opencode-20261102-complete', 'H1', 'bare-json-array'],
      ['r35-writer-only-opencode-20261102-r2', 'B2', 'bare-json-array'],
      ['r35-writer-only-opencode-20261102-r2', 'H1', 'invalid-json-syntax'],
    ] as const
    for (const [run, caseId, category] of cases) {
      const text = raw(run, caseId)
      const parsed = classifyWriterFailure(text)
      expect(parsed.category, `${run}/${caseId}`).toBe(category)
    }
  })

  it('recovers the five unambiguous envelopes and preserves their content', () => {
    const cases = [
      ['r35-writer-only-opencode-20261102', 'B2'],
      ['r35-writer-only-opencode-20261102', 'D1'],
      ['r35-writer-only-opencode-20261102-complete', 'F1'],
      ['r35-writer-only-opencode-20261102-complete', 'H1'],
      ['r35-writer-only-opencode-20261102-r2', 'B2'],
    ] as const
    for (const [run, caseId] of cases) {
      const result = recoverWriterOutput(raw(run, caseId))
      expect(result.status, `${run}/${caseId}`).toBe('recovered')
      expect(result.contentPreserved).toBe(true)
      expect(result.deltas.length).toBeGreaterThan(0)
      expect(result.deltas.every(delta => typeof delta === 'object' && delta !== null)).toBe(true)
    }
  })

  it('does not guess at a syntax error', () => {
    const result = recoverWriterOutput(raw('r35-writer-only-opencode-20261102-r2', 'H1'))
    expect(result.status).toBe('unrecovered')
    expect(result.category).toBe('invalid-json-syntax')
    expect(result.deltas).toEqual([])
  })

  it('leaves a parsed response untouched', () => {
    const text = raw('r35-writer-only-opencode-20261102-complete', 'A1')
    const result = recoverWriterOutput(text)
    expect(result.status).toBe('parsed-p0')
    expect(result.recovery).toBe('none')
  })
})
