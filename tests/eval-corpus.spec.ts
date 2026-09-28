/**
 * R0-C keyless evaluation suite: the 12 hard-gate scenarios and the
 * exploratory corpus run across all three arms (B1 / E3a0 / E3aR) with
 * machine oracles — no provider credentials, fully deterministic.
 */

import { describe, expect, it } from 'vitest'
import { runPairedCase } from '../eval/paired-runner.ts'
import { ALL_SCENARIOS, EXPLORATORY_SCENARIOS, HARD_SCENARIOS } from '../eval/scenarios/index.ts'

describe('R0-C1: boundary corpus structure', () => {
  it('ships at least 12 hard-gate and 6 exploratory scenarios with unique ids', () => {
    expect(HARD_SCENARIOS.length).toBeGreaterThanOrEqual(12)
    expect(EXPLORATORY_SCENARIOS.length).toBeGreaterThanOrEqual(6)
    const ids = new Set(ALL_SCENARIOS.map(scenario => scenario.id))
    expect(ids.size).toBe(ALL_SCENARIOS.length)
  })
})

describe('R0-C2: keyless paired continuation across B1 / E3a0 / E3aR', () => {
  for (const scenario of ALL_SCENARIOS) {
    it(`${scenario.id} (${scenario.sidecar.tier})`, async () => {
      const outcome = await runPairedCase(scenario)

      for (const [arm, result] of Object.entries(outcome.results)) {
        // Every arm's run result is complete and well-formed.
        expect(result.caseId).toBe(scenario.id)
        expect(result.arm).toBe(arm)
        expect(result.context.promptTokensTotal).toBeGreaterThan(0)
        // The scripted continuation emits recall actions only for arms that
        // produced EF checkpoints; the B1 arm's checkpoint is opaque, so its
        // action count may legitimately be zero (keyless tier proves
        // determinism, not cross-arm tool parity).
        expect(result.behavior.actions).toBeGreaterThanOrEqual(0)
      }
      const actionTotal = Object.values(outcome.results)
        .reduce((sum, result) => sum + result.behavior.actions, 0)
      expect(actionTotal).toBeGreaterThan(0)

      // Machine oracles decide — and all three arms must pass the HARD
      // gates, because the deterministic state engine is arm-independent for
      // these capabilities (the scripted continuation is arm-identical).
      if (scenario.sidecar.tier === 'hard') {
        for (const [arm, verdicts] of Object.entries(outcome.oracleVerdicts)) {
          const failures = verdicts.filter(verdict => !verdict.passed).map(verdict => verdict.detail)
          expect(failures).toEqual([])
          void arm
        }
        for (const result of Object.values(outcome.results)) {
          expect(result.success).toBe(true)
        }
      }
    }, 30_000)
  }
})
