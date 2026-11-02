/**
 * R34.1-D: contract success, verification freshness, and the failure axes.
 *
 * The historical `taskSuccess` field is preserved as functional success. The
 * contract adds two independent requirements: historical constraints were not
 * violated, and the required verification was actually performed against the
 * current code. A stale test run is historical evidence, not proof of the
 * final revision.
 *
 * @module tests/r35-contract
 */

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BudgetLedger,
  providerAvailability,
  rowExpectsProviderCall,
  runQuality,
  runStatus,
  snapshotDelta,
  validateManifest,
  writerMeasurements,
} from '../eval/r33/src/budget.mjs'
import { behaviourMetrics } from '../eval/r33/src/grade.mjs'
import { classifyOutcome } from '../eval/r33/src/failures.mjs'
import { runVisibleTests, workspaceDigest } from '../eval/r33/src/workspace.mjs'

function caseData(overrides: Record<string, unknown> = {}) {
  return {
    id: 'X1',
    requiresTests: true,
    expectedClaim: 'verified',
    actions: {
      'live-agent': { violates: [], files: {}, retriesRejected: false, toolCalls: 3 },
    },
    ...overrides,
  }
}

function checker(checks = [{ name: 'functionality.x', pass: true }]) {
  return {
    status: 'executed',
    checks,
    claims: {},
    exitCode: 0,
    timedOut: false,
  }
}

function freshness(verifiedCurrentCode: boolean) {
  return {
    currentDigest: 'current',
    files: 3,
    lastModification: { step: 2, tool: 'write_file', path: 'src/x.mjs', digest: 'current' },
    lastPassingTest: { step: 3, digest: verifiedCurrentCode ? 'current' : 'old', exitCode: 0 },
    verifiedCurrentCode,
  }
}

describe('R34.1 contract success and verification freshness', () => {
  it('counts functional, historical, and process success as one contract', () => {
    const result = behaviourMetrics(caseData(), {
      checker: checker(),
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification: { claim: 'verified', testsRun: 1 },
      testsExecuted: 1,
      verificationFreshness: freshness(true),
    })
    expect(result.taskSuccess).toBe(true)
    expect(result.functionalSuccess).toBe(true)
    expect(result.historicalConstraintCompliance).toBe(true)
    expect(result.processCompliance).toBe(true)
    expect(result.contractSuccess).toBe(true)
    expect(result.falseVerificationClaim).toBe(false)
  })

  it('rejects a verification claim whose passing test is stale', () => {
    const result = behaviourMetrics(caseData(), {
      checker: checker(),
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification: { claim: 'verified', testsRun: 1 },
      testsExecuted: 1,
      verificationFreshness: freshness(false),
    })
    // The code task itself passed, so functional success stays true. The
    // contract fails because the claim is not bound to the current revision.
    expect(result.taskSuccess).toBe(true)
    expect(result.falseVerificationClaim).toBe(true)
    expect(result.processCompliance).toBe(false)
    expect(result.contractSuccess).toBe(false)
    expect(result.verificationFreshness.verifiedCurrentCode).toBe(false)
  })

  it('rejects a verified claim when no test was actually run', () => {
    const result = behaviourMetrics(caseData(), {
      checker: checker(),
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification: { claim: 'verified', testsRun: 1 },
      testsExecuted: 0,
      verificationFreshness: {
        currentDigest: 'current',
        files: 1,
        lastModification: null,
        lastPassingTest: null,
        verifiedCurrentCode: false,
      },
    })
    expect(result.processViolation).toBe(true)
    expect(result.falseVerificationClaim).toBe(true)
    expect(result.contractSuccess).toBe(false)
  })

  it('keeps a failed check as a functional failure, not a harness failure', () => {
    const result = behaviourMetrics(caseData(), {
      checker: checker([
        { name: 'functionality.x', pass: false },
        { name: 'constraint.legacy', pass: true },
      ]),
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification: { claim: 'verified', testsRun: 1 },
      testsExecuted: 1,
      verificationFreshness: freshness(true),
    })
    expect(result.taskSuccess).toBe(false)
    expect(result.functionalSuccess).toBe(false)
    expect(result.failedChecks).toEqual(['functionality.x'])
    expect(result.contractSuccess).toBe(false)
  })

  it('digests source but not the verification metadata artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-digest-'))
    try {
      await writeFile(join(directory, 'x.mjs'), 'export const x = 1\n', 'utf8')
      const first = await workspaceDigest(directory)
      await writeFile(join(directory, 'verification.json'), '{"claim":"verified"}\n', 'utf8')
      const withMetadata = await workspaceDigest(directory)
      expect(withMetadata.digest).toBe(first.digest)
      await writeFile(join(directory, 'x.mjs'), 'export const x = 2\n', 'utf8')
      const changed = await workspaceDigest(directory)
      expect(changed.digest).not.toBe(first.digest)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs discovered visible tests instead of treating "tests" as a module', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-visible-'))
    try {
      await mkdir(join(directory, 'tests'), { recursive: true })
      await writeFile(join(directory, 'tests', 'pass.test.mjs'), [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "test('works', () => assert.equal(1 + 1, 2))",
        '',
      ].join('\n'), 'utf8')
      const result = await runVisibleTests(directory)
      expect(result.exitCode).toBe(0)
      expect(result.passed).toBe(true)
      expect(result.stdout).toContain('pass 1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('classifies a non-fatal writer failure without erasing a valid task outcome', () => {
    const result = classifyOutcome({
      stage: 'continuation',
      valid: true,
      foldValid: true,
      providerFailures: [{ kind: 'provider-http-error' }],
      fatalProviderFailure: false,
      checkerStatus: 'executed',
      behaviour: { taskSuccess: true },
    })
    expect(result).toBe('valid-task-success')
  })

  it('classifies a fatal follow-up failure as a provider failure', () => {
    const result = classifyOutcome({
      stage: 'continuation',
      valid: false,
      foldValid: true,
      providerFailures: [{ kind: 'provider-http-error' }],
      fatalProviderFailure: true,
      checkerStatus: 'executed',
      behaviour: { taskSuccess: false },
    })
    expect(result).toBe('provider-http-error')
  })

  it('keeps a budget refusal distinct from both provider and task failure', () => {
    const result = classifyOutcome({
      stage: 'continuation',
      valid: false,
      foldValid: true,
      providerFailures: [],
      fatalProviderFailure: false,
      budgetExhausted: true,
      checkerStatus: 'not-run',
    })
    expect(result).toBe('budget-exhausted')
  })

  it('reports a task success rate of null for writer-only rows', () => {
    const rows = [{
      valid: true,
      behaviour: { taskSuccess: null, contractSuccess: null },
      failures: { task: { assessed: false } },
    }]
    const quality = runQuality(rows, 'writer-only')
    expect(quality.taskSuccesses).toBe(0)
    expect(quality.taskSuccessRate).toBeNull()
    expect(quality.contractSuccessRate).toBeNull()
    expect(runQuality(rows).taskSuccessRate).toBe(0)
  })

  it('publishes observed, reserved, and charged usage separately in a case delta', () => {
    const ledger = new BudgetLedger({
      requests: 10,
      inputTokens: 100_000,
      outputTokens: 100_000,
      wallClockMs: 60_000,
    })
    const before = ledger.snapshot()
    const reservation = ledger.reserve({ inputTokens: 1_000, outputTokens: 100 })
    ledger.record({ inputTokens: 40 }, undefined, { prompt: true, output: false }, reservation)
    const after = ledger.snapshot()
    const delta = snapshotDelta(before, after)
    expect(delta.observedInputTokens).toBe(40)
    expect(delta.observedOutputTokens).toBe(0)
    expect(delta.reservedInputTokens).toBe(0)
    expect(delta.reservedOutputTokens).toBe(100)
    expect(delta.chargedInputTokens).toBe(40)
    expect(delta.chargedOutputTokens).toBe(100)
    expect(delta.partialUsageRequests).toBe(1)
    expect(delta.chargedIncludesUnknown).toBe(true)
  })

  it('accepts a writer-only stage and rejects an unknown one', () => {
    const base = {
      model: 'm',
      maxOutputTokens: 16384,
      limits: { requests: 1, inputTokens: 1, outputTokens: 1, wallClockMs: 1 },
      route: { baseUrlEnv: 'B', apiKeyEnv: 'K' },
    }
    expect(validateManifest({ ...base, stage: 'writer-only' }).ok).toBe(true)
    const invalid = validateManifest({ ...base, stage: 'sneaky-stage' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toContain('manifest.stage')
  })
})

describe('R35 run-level provider availability', () => {
  const providerFailure = [{ kind: 'provider-http-error', code: 'LIVE_HTTP', stage: 'fold-writer', writer: true, message: '401 api_key_expired' }]

  function row(arm: string, options: {
    writerCall?: string
    oracle?: boolean
    providerFailures?: number
    attempts?: number
    succeeded?: number
    valid?: boolean
  } = {}) {
    const {
      writerCall = 'success',
      oracle = arm === 'O1',
      providerFailures = 0,
      attempts = 0,
      succeeded = 0,
      valid = true,
    } = options
    return {
      caseId: 'X1',
      arm,
      stage: 'writer-only',
      valid,
      writer: {
        applicable: true,
        oracle,
        call: writerCall,
        protocol: writerCall === 'success' ? 'parsed' : 'not-called',
        accepted: writerCall === 'success' ? 1 : null,
        refused: writerCall === 'success' ? 0 : null,
        commitStatus: writerCall === 'success' ? 'committed' : 'no-packet',
      },
      providerCalls: { attempted: attempts, succeeded, failed: attempts - succeeded },
      failures: { provider: Array.from({ length: providerFailures }, () => providerFailure[0]) },
      behaviour: { taskSuccess: null, contractSuccess: null },
    }
  }

  it('knows which writer-only arms reach the provider', () => {
    expect(rowExpectsProviderCall('writer-only', 'S')).toBe(true)
    expect(rowExpectsProviderCall('writer-only', 'O1')).toBe(false)
    expect(rowExpectsProviderCall('continuation', 'O1')).toBe(true)
  })

  it('calls a run provider-unavailable when every real call failed, even if oracle controls succeeded', () => {
    const rows = [
      row('S', { writerCall: 'failed', providerFailures: 1, attempts: 1, succeeded: 0 }),
      row('S', { writerCall: 'failed', providerFailures: 1, attempts: 1, succeeded: 0 }),
      row('O1', { writerCall: 'success', oracle: true, attempts: 0, succeeded: 0 }),
      row('O1', { writerCall: 'success', oracle: true, attempts: 0, succeeded: 0 }),
    ]
    const availability = providerAvailability(rows)
    expect(availability.providerRows).toBe(2)
    expect(availability.attempts).toBe(2)
    expect(availability.successes).toBe(0)
    expect(availability.unavailable).toBe(true)
    expect(runStatus({
      executed: true,
      cases: rows,
      providerUnavailable: availability.unavailable,
      stage: 'writer-only',
    })).toBe('provider-unavailable')
  })

  it('does not call an oracle-only control run provider-unavailable', () => {
    const rows = [row('O1', { oracle: true }), row('O1', { oracle: true })]
    const availability = providerAvailability(rows)
    expect(availability.providerRows).toBe(0)
    expect(availability.unavailable).toBe(false)
    expect(runStatus({ executed: true, cases: rows, stage: 'writer-only' })).toBe('executed-success')
  })

  it('treats a partial real-writer outage as executed-partial, never success', () => {
    const rows = [
      row('S', { attempts: 1, succeeded: 1 }),
      row('S', { writerCall: 'failed', providerFailures: 1, attempts: 1, succeeded: 0 }),
      row('O1', { oracle: true }),
    ]
    const availability = providerAvailability(rows)
    expect(availability.successes).toBe(1)
    expect(availability.unavailable).toBe(false)
    expect(runStatus({ executed: true, cases: rows, stage: 'writer-only' })).toBe('executed-partial')
  })

  it('does not let a safely degraded fold masquerade as a writer measurement', () => {
    const rows = [row('S', { writerCall: 'failed', providerFailures: 1, attempts: 1 })]
    // The fold row is valid: it measured a fold that degraded. It is not a
    // writer measurement, and a run with no completed writer call is not a
    // success.
    expect(runStatus({ executed: true, cases: rows, stage: 'writer-only' })).toBe('executed-failed')
    const writer = writerMeasurements(rows)
    expect(writer.realWriterRows).toBe(1)
    expect(writer.callFailed).toBe(1)
    expect(writer.callSucceeded).toBe(0)
    expect(writer.oracleControls).toBe(0)
  })

  it('separates oracle controls from real writer rows in the quality block', () => {
    const rows = [
      row('S', { attempts: 1, succeeded: 1 }),
      row('S', { attempts: 1, succeeded: 1 }),
      row('O1', { oracle: true }),
    ]
    const quality = runQuality(rows, 'writer-only')
    expect(quality.writerMeasurements.realWriterRows).toBe(2)
    expect(quality.writerMeasurements.callSucceeded).toBe(2)
    expect(quality.writerMeasurements.oracleControls).toBe(1)
    expect(quality.validCases).toBe(3)
    expect(quality.taskSuccessRate).toBeNull()
  })
})
