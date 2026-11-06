/**
 * R37-D WP5: native lifecycle extension results.
 *
 * These assertions read the committed native artifact. They do not re-run the
 * native host; the artifact is the evidence.
 *
 * @module tests/r37d-native
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const native = JSON.parse(readFileSync(join(ROOT, 'eval', 'r37d', 'out', 'native-extended.json'), 'utf8'))

describe('R37-D N3: multiple tool calls', () => {
  it('executes five tool calls in model order with five results', () => {
    expect(native.n3.status).toBe('passed')
    expect(native.n3.counts.toolCalls).toBe(5)
    expect(native.n3.counts.toolResults).toBe(5)
    expect(native.n3.paired).toBe(true)
    expect(native.n3.adapterCalls).toBe(2)
  })

  it('writes before the test observes the workspace', () => {
    expect(native.n3.sawWritten).toBe(true)
  })

  it('persists a thrown tool error and continues', () => {
    expect(native.n3.counts.errors).toBe(1)
    expect(native.n3.failResult.code).toBe('tool-threw')
    expect(native.n3.failResult.message).toMatch(/intentional tool failure/u)
    expect(native.n3.duplicateResults).toBe(2)
  })
})

describe('R37-D N4: interrupted session recovery', () => {
  it('uses the runtime real repair codes, not invented states', () => {
    expect(native.n4.status).toBe('passed')
    expect(native.n4.notStarted.expectedCode).toBe('TOOL_NOT_STARTED')
    expect(native.n4.started.expectedCode).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(native.n4.notStarted.codes).toContain('TOOL_NOT_STARTED')
    expect(native.n4.started.codes).toContain('TOOL_OUTCOME_UNKNOWN')
  })

  it('persists the interrupted session before recovery', () => {
    expect(native.n4.notStarted.persistence.files).toBeGreaterThan(0)
    expect(native.n4.notStarted.persistence.bytes).toBeGreaterThan(0)
    expect(native.n4.started.persistence.files).toBeGreaterThan(0)
    expect(native.n4.started.persistence.bytes).toBeGreaterThan(0)
  })

  it('synthesizes a result for both interruption points', () => {
    expect(native.n4.notStarted.syntheticResults).toHaveLength(1)
    expect(native.n4.started.syntheticResults).toHaveLength(1)
    expect(native.n4.notStarted.recoveryError).toBe(null)
    expect(native.n4.started.recoveryError).toBe(null)
  })
})

describe('R37-D N5: repeated EF folds', () => {
  it('folds twice and commits two journal receipts', () => {
    expect(native.n5.status).toBe('passed')
    expect(native.n5.foldError).toBe(null)
    expect(native.n5.journal.journalFound).toBe(true)
    expect(native.n5.journal.packets).toBe(2)
    expect(native.n5.journal.receipts).toBe(2)
    expect(native.n5.journal.committedPackets).toBe(2)
    expect(native.n5.journal.proofValid).toBe(true)
  })

  it('does not revive the superseded in-memory decision', () => {
    expect(native.n5.firstHasOld).toBe(true)
    expect(native.n5.finalHasNew).toBe(true)
    expect(native.n5.finalHasOld).toBe(false)
    expect(native.n5.oldActive).toBe(false)
    expect(native.n5.newActive).toBe(true)
    expect(native.n5.staleRejectionActive).toBe(false)
  })

  it('leaves only the revised constraint active', () => {
    expect(native.n5.journal.anchors).toHaveLength(1)
    expect(native.n5.journal.anchors[0].value).toMatch(/durable outbox/u)
    expect(native.n5.finalOps.some((op: any) => op.op === 'retire')).toBe(true)
  })

  it('runs a native tool call on the final checkpoint', () => {
    expect(native.n5.native.counts.toolCalls).toBe(1)
    expect(native.n5.native.counts.toolResults).toBe(1)
    expect(native.n5.native.errorCodes).toEqual([])
  })
})
