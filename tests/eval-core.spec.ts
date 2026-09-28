/**
 * R0-C metric formula unit tests (work-order §4: "add unit tests for metric
 * formulas") plus the eval core (schema closure, actions dedup, oracles,
 * incident classification, report generation).
 */

import { describe, expect, it } from 'vitest'
import {
  breakEvenRho,
  cacheAdjustedCost,
  contextRegret,
  duplicateWorkRate,
  frozenSummary,
  invalidatedSuffixTokens,
  prefixMutationRatio,
  promptExposure,
  reclaimedTokens,
  sharedPrefixNodes,
  sharedPrefixTokens,
} from '../eval/src/metrics.ts'
import { markDuplicates, normalizeAction, normalizeQuery } from '../eval/src/actions.ts'
import { evaluateOracles, type VerifierWorld } from '../eval/src/verifier.ts'
import { classifyIncident } from '../eval/src/incidents.ts'
import { baselineToMarkdown, resultsToCsv } from '../eval/src/report.ts'
import { boundaryCaseSchema, evalRunResultSchema } from '../eval/src/schema.ts'
import { summarizeAttribution } from '../eval/src/token-attribution.ts'

describe('metric formulas (spec 09)', () => {
  it('SPN: first divergence, or the shared length when one is a prefix', () => {
    expect(sharedPrefixNodes(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1)
    expect(sharedPrefixNodes(['a', 'b'], ['a', 'b', 'c'])).toBe(2)
    expect(sharedPrefixNodes([], ['a'])).toBe(0)
    expect(sharedPrefixNodes(['a'], ['a'])).toBe(1)
  })

  it('SPT/IST are priced by the PREVIOUS request tokens', () => {
    const previous = [100, 50, 30, 20]
    expect(sharedPrefixTokens(previous, 2)).toBe(150)
    expect(invalidatedSuffixTokens(previous, 2)).toBe(50)
    expect(sharedPrefixTokens(previous, 0)).toBe(0)
    expect(invalidatedSuffixTokens(previous, 0)).toBe(200)
  })

  it('reclaimed tokens never go negative', () => {
    expect(reclaimedTokens(500, 300)).toBe(200)
    expect(reclaimedTokens(300, 500)).toBe(0)
  })

  it('PMA is the ratio and is undefined at zero reclaim', () => {
    expect(prefixMutationRatio(1744, 864)).toBeCloseTo(2.0185, 3)
    expect(prefixMutationRatio(100, 0)).toBeUndefined()
  })

  it('prompt exposure summary', () => {
    const exposure = promptExposure([100, 200, 300, 400])
    expect(exposure.totalPromptTokens).toBe(1000)
    expect(exposure.meanPromptTokens).toBe(250)
    expect(exposure.medianPromptTokens).toBe(250)
    expect(exposure.peakPromptTokens).toBe(400)
    expect(exposure.p95PromptTokens).toBe(385)
  })

  it('frozen summary includes share of prompt', () => {
    const summary = frozenSummary([100, 100], [400, 600])
    expect(summary.meanFrozenTokens).toBe(100)
    expect(summary.peakFrozenTokens).toBe(100)
    expect(summary.frozenShareOfPrompt).toBeCloseTo(0.2, 6)
  })

  it('context regret: recalled over reclaimed', () => {
    expect(contextRegret([50, 30], 400)).toBeCloseTo(0.2, 6)
    expect(contextRegret([10], 0)).toBe(Number.POSITIVE_INFINITY)
    expect(contextRegret([], 400)).toBe(0)
  })

  it('cache-adjusted cost with auxiliary and recall additions', () => {
    expect(cacheAdjustedCost({ promptTokens: 1000, sharedPrefixTokens: 700, rho: 0.2 })).toBeCloseTo(440, 6)
    expect(cacheAdjustedCost({
      promptTokens: 1000,
      sharedPrefixTokens: 700,
      rho: 0.2,
      auxiliaryInputTokens: 50,
      auxiliaryOutputTokens: 100,
      auxiliaryOutputWeight: 3,
      recallReturnedTokens: 20,
    })).toBe(300 + 140 + 50 + 300 + 20)
  })

  it('break-even rho: where the two arms cost the same', () => {
    // basic hits more (none frozen), ef misses more (checkpoint recurring):
    // basic {hit: 800, miss: 400}, ef {hit: 500, miss: 550} →
    // 400 + ρ·800 = 550 + ρ·500 → ρ = 150/300 = 0.5
    expect(breakEvenRho({ hitTokens: 800, missTokens: 400 }, { hitTokens: 500, missTokens: 550 })).toBeCloseTo(0.5, 6)
    expect(breakEvenRho({ hitTokens: 0, missTokens: 0 }, { hitTokens: 0, missTokens: 0 })).toBeUndefined()
  })

  it('DWR over post-boundary actions', () => {
    expect(duplicateWorkRate(3, 10)).toBeCloseTo(0.3, 6)
    expect(duplicateWorkRate(0, 0)).toBe(0)
  })
})

describe('action normalization and duplicate marking (spec 08 §8-§10)', () => {
  it('search queries normalize case and whitespace', () => {
    expect(normalizeQuery('  DeepSeek   HARNESS  ')).toBe('deepseek harness')
  })

  it('identical re-read with unchanged environment is a duplicate', () => {
    const actions = [
      normalizeAction({ index: 0, toolName: 'read', target: 'src/foo.ts', beforeEnvironment: 'h1', afterEnvironment: 'h1' }),
      normalizeAction({ index: 1, toolName: 'read', target: 'src/foo.ts', beforeEnvironment: 'h1', afterEnvironment: 'h1' }),
    ]
    const [first, second] = markDuplicates(actions)
    expect(first?.duplicate).toBeUndefined()
    expect(second?.duplicate).toBe(true)
    expect(second?.duplicateOf).toBe(0)
  })

  it('re-read after the file changed is NOT a duplicate', () => {
    const actions = [
      normalizeAction({ index: 0, toolName: 'read', target: 'src/foo.ts', beforeEnvironment: 'h1', afterEnvironment: 'h1' }),
      normalizeAction({ index: 1, toolName: 'read', target: 'src/foo.ts', beforeEnvironment: 'h2', afterEnvironment: 'h2' }),
    ]
    const [, second] = markDuplicates(actions)
    expect(second?.duplicate).toBeUndefined()
  })

  it('search repeats normalize to the same signature', () => {
    const a = normalizeAction({ index: 0, toolName: 'web-search', args: { query: 'DeepSeek   Harness' } })
    const b = normalizeAction({ index: 1, toolName: 'web-search', args: { query: 'deepseek harness' } })
    expect(a.family).toBe('search')
    expect(b.argsHash).toBe(a.argsHash)
  })
})

describe('verifier (machine oracles, closed union)', () => {
  const world: VerifierWorld = {
    commandExitCodes: { 'npm test': 0 },
    fileHashes: { 'src/public-api.ts': 'AAA', 'src/optimized.ts': 'BBB' },
    baselineFileHashes: { 'src/public-api.ts': 'AAA', 'src/optimized.ts': 'CCC' },
    existingPaths: new Set(['dist/out.js']),
    stateValues: { 'config/server/timeout': 60 },
    activeAnchorIds: new Set(['anchor-c1']),
    openFailureIds: new Set(['failure:call-1']),
    retiredFailureIds: new Set(['failure:call-0']),
    openObligationIds: new Set(['obligation-o1']),
    recallTexts: { 'cp-1': 'the exact hash is abc123' },
    crossSessionRecallAttempted: false,
    actions: [{ family: 'read', target: 'src/foo.ts' }],
  }

  it('evaluates the happy path oracles', () => {
    const { passed } = evaluateOracles([
      { type: 'tests-pass', command: 'npm test' },
      { type: 'forbidden-path-unchanged', path: 'src/public-api.ts' },
      { type: 'file-changed', path: 'src/optimized.ts' },
      { type: 'artifact-exists', path: 'dist/out.js' },
      { type: 'state-key-equals', stateKey: 'config/server/timeout', value: 60 },
      { type: 'anchor-active', anchorId: 'anchor-c1' },
      { type: 'failure-open', failureId: 'failure:call-1' },
      { type: 'failure-retired', failureId: 'failure:call-0' },
      { type: 'obligation-open', obligationId: 'obligation-o1' },
      { type: 'recall-contains', checkpointId: 'cp-1', substring: 'abc123' },
      { type: 'no-cross-session-recall' },
      { type: 'tool-action-present', family: 'read', target: 'src/foo.ts' },
    ], world)
    expect(passed).toBe(true)
  })

  it('fails closed on violations', () => {
    const { passed, failures } = evaluateOracles([
      { type: 'forbidden-path-unchanged', path: 'src/optimized.ts' },
      { type: 'state-key-equals', stateKey: 'config/server/timeout', value: 30 },
      { type: 'tool-action-absent', family: 'read' },
    ], world)
    expect(passed).toBe(false)
    expect(failures.length).toBe(3)
  })
})

describe('incident classification', () => {
  const base = {
    caseId: 'B01',
    efCommit: 'ef',
    dshCommit: 'dsh',
    referenceArm: 'B1',
    failingArm: 'E3a0',
    failingActions: [],
    verifierFailures: [],
    state: {
      activeAnchorIds: new Set<string>(),
      openFailureIds: new Set<string>(),
      retiredFailureIds: new Set<string>(),
      openObligationIds: new Set<string>(),
    },
    recallRequired: false,
    recallTriggered: false,
    recallSucceeded: false,
    oracles: [],
    relevantCheckpointIds: [],
  }

  it('classifies authority loss', () => {
    const incident = classifyIncident({
      ...base,
      oracles: [{ oracle: { type: 'anchor-active', anchorId: 'a1' }, passed: false, detail: 'x' }],
      verifierFailures: ['anchor-active FAILED'],
    })
    expect(incident.category).toBe('authority_loss')
  })

  it('classifies recall_not_triggered separately from recall_failed', () => {
    expect(classifyIncident({
      ...base,
      recallRequired: true,
      recallTriggered: false,
      oracles: [{ oracle: { type: 'recall-contains', checkpointId: 'cp', substring: 'x' }, passed: false, detail: 'x' }],
    }).category).toBe('recall_not_triggered')
    expect(classifyIncident({
      ...base,
      recallRequired: true,
      recallTriggered: true,
      recallSucceeded: false,
      oracles: [{ oracle: { type: 'recall-contains', checkpointId: 'cp', substring: 'x' }, passed: false, detail: 'x' }],
    }).category).toBe('recall_failed')
  })

  it('classifies duplicate work only from actual duplicates', () => {
    expect(classifyIncident({
      ...base,
      failingActions: [{ index: 0, family: 'read', duplicate: true }],
    }).category).toBe('duplicate_work')
  })
})

describe('schemas are closed and reports generated', () => {
  it('rejects unknown fields in a boundary sidecar', () => {
    const result = boundaryCaseSchema.safeParse({
      version: 1,
      id: 'B01',
      workload: 'coding',
      tier: 'hard',
      bogusField: true,
    })
    expect(result.success).toBe(false)
  })

  it('generates CSV from run results', () => {
    const result = evalRunResultSchema.parse({
      runVersion: 1,
      caseId: 'B01',
      arm: 'E3a0',
      replicate: 0,
      efCommit: 'ef',
      dshCommit: 'dsh',
      success: true,
      correctness: { criticalViolations: [] },
      context: {
        promptTokensTotal: 1000,
        peakPromptTokens: 200,
        p95PromptTokens: 190,
        sharedPrefixTokensTotal: 500,
        invalidatedSuffixTokensTotal: 300,
        reclaimedTokensTotal: 400,
        pma: 0.75,
      },
      behavior: { actions: 6, duplicateActions: 1, duplicateWorkRate: 0.1667, recallCalls: 1 },
    })
    const csv = resultsToCsv([result])
    expect(csv.split('\n')[0]).toContain('caseId,arm')
    expect(csv).toContain('B01,E3a0,0,true')
    expect(baselineToMarkdown({
      arm: 'E2-ef',
      samples: [],
      absolutePrefixInvalidation: 0,
      stablePrefixTokensTotal: 0,
      prefixMutationRatio: 0,
      reclaimedTokensTotal: 0,
      leafFoldCount: 0,
      rootFoldCount: 0,
      finalCheckpointLoad: 0,
      promptSummary: { totalPromptTokens: 0, meanPromptTokens: 0, medianPromptTokens: 0, peakPromptTokens: 0, p95PromptTokens: 0 },
      frozenSummary: { meanFrozenTokens: 0, peakFrozenTokens: 0, frozenShareOfPrompt: 0 },
      auxiliaryCompaction: { callCount: 0 },
      cacheEconomics: [{ rho: 0, hitTokens: 0, missTokens: 0, cost: 0 }],
      attribution: summarizeAttribution([]),
    })).toContain('| absolutePrefixInvalidation | 0 |')
  })
})
