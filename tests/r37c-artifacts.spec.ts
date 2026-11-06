/**
 * R37-C: the executed audit artifacts answer the ten closure questions.
 *
 * These assertions read outputs produced by the real R37-B archive, not
 * hand-written constants. They are intentionally narrow: a changed result must
 * be a deliberate new run, not a silent edit.
 *
 * @module tests/r37c-artifacts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (name: string): any => JSON.parse(readFileSync(join(ROOT, 'eval', 'r37c', 'out', name), 'utf8'))

const integrity = read('evidence-integrity.json')
const funnel = read('semantic-funnel-audit.json')
const measurement = read('measurement-vs-pipeline.json')
const statistics = read('statistics-audit.json')
const protocol = read('protocol-admission.json')
const native = read('native-smoke.json')
const trajectories = read('r37c-c2-trajectories.json')

describe('R37-C0-A: evidence integrity', () => {
  it('covers the expected cell matrix without a secret', () => {
    expect(integrity.status).toBe('passed')
    expect(integrity.cellMatrix.missing).toEqual([])
    expect(integrity.cellMatrix.unexpected).toEqual([])
    expect(integrity.cellMatrix.expectedUnique).toBe(360)
    expect(integrity.cellMatrix.uniqueObserved).toBe(360)
    expect(integrity.secrets.findings).toBe(0)
  })

  it('records the two true transport-invalid rows and nine fold refusals', () => {
    expect(integrity.stage2.invalidRows).toBe(11)
    expect(integrity.stage2.invalidByOutcome).toEqual({
      'provider-transport-error': 2,
      'fold-invalid': 9,
    })
  })
})

describe('R37-C0-B: writer funnel', () => {
  it('separates accepted-fact recall from committed-fact recall', () => {
    expect(funnel.byPrompt.W1.oldAcceptedRecall).toBeCloseTo(0.7222222222222222, 12)
    expect(funnel.byPrompt.W1.funnel.byStage.committed).toBeCloseTo(0.5138888888888888, 12)
    expect(funnel.byPrompt.W1.funnel.byStage.committed).toBeLessThan(funnel.byPrompt.W1.oldAcceptedRecall)
  })

  it('reports accepted-but-not-committed rows', () => {
    expect(funnel.acceptedButNotCommitted.rows).toBe(14)
  })

  it('shows strictCriticalRecall is a true exact-statement zero, not a missing field', () => {
    expect(funnel.overall.criticalRecallField.present).toBe(72)
    expect(funnel.overall.criticalRecallField.missing).toBe(0)
    expect(funnel.overall.criticalRecallField.nullValue).toBe(18)
    expect(funnel.overall.criticalRecallField.zeroValue).toBe(54)
    expect(funnel.overall.criticalRecallField.nonzeroValue).toBe(0)
    expect(funnel.discrepancies.count).toBe(0)
  })
})

describe('R37-C0-C: measurement classification', () => {
  it('recomputes 11 invalid rows as 2 provider-invalid and 9 fold refusals', () => {
    expect(measurement.recomputed.providerInvalid).toBe(2)
    expect(measurement.recomputed.foldRefused).toBe(9)
    expect(measurement.recomputed.byMeasurement.valid).toBe(9)
  })

  it('keeps fold refusals in the assigned-arm denominator', () => {
    expect(measurement.assignedArm.S.rows).toBeGreaterThan(0)
    expect(measurement.assignedArm.S.pipeline['fold-refused']).toBeGreaterThan(0)
  })
})

describe('R37-C0-D: statistics', () => {
  it('preserves the original exact McNemar result', () => {
    expect(statistics.contract.mcnemar.p).toBeCloseTo(0.021484375, 12)
    expect(statistics.contract.rescue).toBe(1)
    expect(statistics.contract.damage).toBe(9)
  })

  it('reports five negative cases and one flat case', () => {
    expect(statistics.contract.caseDirection).toEqual({ negative: 5, positive: 0, flat: 1 })
    expect(statistics.contract.signTest.p).toBeCloseTo(0.0625, 12)
  })

  it('shows the leave-one-case-out sensitivity range', () => {
    expect(statistics.interpretation.leaveOneCaseOutPRange[0]).toBeCloseTo(0.0078125, 12)
    expect(statistics.interpretation.leaveOneCaseOutPRange[1]).toBeCloseTo(0.0703125, 12)
  })
})

describe('R37-C0-D/C1-B: protocol admission', () => {
  it('uses model calls, not completed steps, as the Stage 2 denominator', () => {
    expect(protocol.stage2.totals.turns).toBe(903)
    expect(protocol.stage2.totals.storedModelCalls).toBe(903)
    expect(protocol.stage2.totals.completedSteps).toBe(819)
  })

  it('marks the Stage 1 admission gate not verifiable', () => {
    expect(protocol.stage1.admission.status).toBe('gate-not-verifiable')
    expect(protocol.stage1.metricAssessment.reasons.join(' ')).toMatch(/unparsedTurnRate/u)
  })

  it('classifies no-valid-action turns instead of calling all of them parser bugs', () => {
    expect(protocol.stage2.noAction.byClass['normal-text-only']).toBeGreaterThan(0)
    expect(protocol.stage2.noAction.byClass['truncated-output']).toBeGreaterThan(0)
    expect(protocol.stage2.noAction.byClass['missing-parameter']).toBeGreaterThan(0)
  })
})

describe('R37-C1-C: native lifecycle', () => {
  it('passes N0, N1, and N2 with no synthetic repair', () => {
    expect(native.n0.status).toBe('passed')
    expect(native.n1.status).toBe('passed')
    expect(native.n2.status).toBe('passed')
    for (const phase of [native.n0, native.n1.first, native.n1.second, native.n2.native]) {
      expect(phase.counts.toolCalls).toBe(1)
      expect(phase.counts.toolResults).toBe(1)
      expect(phase.counts.repairs).toBe(0)
    }
  })

  it('records the configuration root cause instead of blaming the tool runtime', () => {
    expect(native.rootCause.symptom).toBe('TOOL_NOT_STARTED')
    expect(native.rootCause.fix).toMatch(/createVolatile/u)
  })
})

describe('R37-C2: trajectory attribution', () => {
  it('shows the guard had no opportunity in any contract failure', () => {
    expect(trajectories.summary.contractFailures).toBe(5)
    expect(trajectories.summary.contractFailuresNoFinish).toBe(5)
    expect(trajectories.summary.contractFailuresGuardTriggered).toBe(0)
  })

  it('separates finish-with-test from protocol-stall trajectories', () => {
    expect(trajectories.byArchetype['finish-with-test']).toBe(9)
    expect(trajectories.byArchetype['test-no-finish']).toBe(8)
    expect(trajectories.byArchetype['protocol-stall-no-test']).toBe(3)
  })

  it('does not attribute the intention-to-treat difference to a guard that never fired', () => {
    expect(trajectories.summary.guardTriggered).toBe(4)
    expect(trajectories.summary.guardAssisted).toBe(1)
    expect(trajectories.conclusions.join(' ')).toMatch(/guard had no opportunity/u)
  })
})
