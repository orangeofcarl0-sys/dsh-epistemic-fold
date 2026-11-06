/**
 * R38-M0 WP6: native context delivery smoke.
 *
 * The test runs the real DSH agent loop with a scripted adapter. The overlay is
 * registered through the system-prompt CONTEXT channel, so the loop emits it as
 * a logged `runtime-context` user message — not as a system-prompt section and
 * not as a second agent loop.
 *
 * @module tests/r38-native-context
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSmoke } from '../eval/r38/native-context-smoke.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const report = await runSmoke()

describe('R38-WP6: native context delivery', () => {
  it('passes every native check', () => {
    expect(report.status).toBe('passed')
    expect(report.summary.passed).toBe(report.summary.checks)
    expect(report.modelCalls).toBe(0)
    expect(report.providerCalls).toBe(0)
  })

  it('delivers the overlay through the runtime-context channel only', () => {
    expect(report.observations.n0First.overlayDelivered).toBe(true)
    expect(report.observations.n0First.systemHasOverlay).toBe(false)
    expect(report.observations.n0First.systemText).not.toContain('[EF context overlay]')
  })

  it('keeps one snapshot for identical input and a stable prefix', () => {
    expect(report.observations.n0Second.contextEvents).toBe(1)
    expect(report.observations.n0Second.digestStable).toBe(true)
    expect(report.observations.n0Second.prefixStable).toBe(true)
  })

  it('emits a new snapshot when the task changes', () => {
    expect(report.observations.n1.contextEvents).toBe(2)
    expect(report.observations.n1.newSelectionDelivered).toBe(true)
    expect(report.observations.n1.digestChanged).toBe(true)
    expect(report.observations.n1.prefixStable).toBe(true)
  })

  it('marks the old decision unsafe to assert under a recent tail', () => {
    expect(report.observations.n2.warningPresent).toBe(true)
    expect(report.observations.n2.unsafeLinePresent).toBe(true)
  })

  it('survives a real JSONL restart with the same overlay digest', () => {
    expect(report.observations.n3.resumeError).toBeNull()
    expect(report.observations.n3.overlayDelivered).toBe(true)
    expect(report.observations.n3.selectionDigestDelivered).toBe(true)
    expect(report.observations.n3.digestStable).toBe(true)
  })

  it('carries integrity warnings and archive source refs', () => {
    expect(report.observations.n4.integrityWarningDelivered).toBe(true)
    expect(report.observations.n5.recoveredDelivered).toBe(true)
    expect(report.observations.n5.sourceRefDelivered).toBe(true)
  })

  it('does not rewrite the journal or the checkpoint', () => {
    expect(report.journalModified).toBe(false)
    expect(report.checkpointRewritten).toBe(false)
  })

  it('uses the context channel, not a system-prompt section or a second loop', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'native-context-smoke.mjs'), 'utf8')
    expect(source).toContain('systemPrompt.context(')
    expect(source).not.toContain('systemPrompt.section(')
    expect(source).not.toMatch(/new AgentLoop\(.*\n.*new AgentLoop\(/u)
  })
})
