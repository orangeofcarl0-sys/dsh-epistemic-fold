/**
 * R37-D WP1: operational completion and workspace freshness.
 *
 * These tests use synthetic report rows. They do not read the historical
 * archive; the artifact-level assertions in `r37d-artifacts.spec.ts` do that.
 *
 * @module tests/r37d-operational
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyOperationalCompletion,
  operationalContract,
  OPERATIONAL_SCORER_VERSION,
} from '../eval/r37d/src/operational-completion.mjs'
import { workspaceDigest, workspaceDigests } from '../eval/r33/src/workspace.mjs'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r37d-workspace-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

function baseInput(overrides: any = {}): any {
  const checker = {
    status: 'executed',
    agentError: null,
    checks: [{ name: 'functionality.fifo', pass: true }],
  }
  const behaviour = {
    taskSuccess: true,
    contractSuccess: true,
    processCompliance: true,
    constraintViolation: false,
    obsoleteRevival: false,
    rejectedRetrial: false,
    agentError: null,
    finalVerificationStatus: 'verified',
  }
  const detail = {
    testsExecuted: 1,
    testRuns: [{ passed: true, exitCode: 0, digest: 'd1' }],
    verificationFreshness: {
      currentDigest: 'd1',
      verifiedCurrentCode: true,
      lastPassingTest: { step: 1, digest: 'd1' },
    },
    finishGuard: { finishRequests: 1, rejections: 0 },
    harness: { stepLimitTermination: false, providerFailure: null },
    finished: true,
  }
  return {
    caseData: { id: 'B2', requiresTests: true },
    behaviour,
    detail,
    checker,
    run: { exitCode: 0, signal: null, timedOut: false },
    ...overrides,
  }
}

describe('R37-D operational completion: the three layers', () => {
  it('passes a finish with a fresh passing test', () => {
    const result = classifyOperationalCompletion(baseInput())
    expect(result.scorerVersion).toBe(OPERATIONAL_SCORER_VERSION)
    expect(result.artifact.artifactCorrectness).toBe(true)
    expect(result.verification.verificationCompleteness).toBe(true)
    expect(result.termination.acceptableTermination).toBe(true)
    expect(result.operationalCompletion).toBe(true)
    expect(result.operationalCompletionStrictFinish).toBe(true)
    expect(result.firstFailingLayer).toBe(null)
  })

  it('accepts a step limit after complete work, but marks it inefficient', () => {
    const input = baseInput()
    input.detail.finished = false
    input.detail.finishGuard.finishRequests = 0
    input.detail.harness.stepLimitTermination = true
    const result = classifyOperationalCompletion(input)
    expect(result.operationalCompletion).toBe(true)
    expect(result.operationalCompletionStrictFinish).toBe(false)
    expect(result.termination.terminationReason).toBe('step-limit')
    expect(result.termination.acceptableTermination).toBe(true)
    expect(result.termination.efficientTermination).toBe(false)
  })

  it('fails verification when the source changed after the last test', () => {
    const input = baseInput()
    input.detail.verificationFreshness.currentDigest = 'd2'
    input.detail.verificationFreshness.verifiedCurrentCode = false
    const result = classifyOperationalCompletion(input)
    expect(result.verification.lastTestFresh).toBe(false)
    expect(result.verification.verificationCompleteness).toBe(false)
    expect(result.operationalCompletion).toBe(false)
    expect(result.firstFailingLayer).toBe('verification')
    expect(result.legacy.contractSuccess).toBe(true)
  })

  it('fails verification when no test ran', () => {
    const input = baseInput()
    input.detail.testsExecuted = 0
    input.detail.testRuns = []
    input.detail.verificationFreshness.verifiedCurrentCode = false
    input.detail.verificationFreshness.lastPassingTest = null
    const result = classifyOperationalCompletion(input)
    expect(result.verification.lastTestPassed).toBe(null)
    expect(result.verification.verificationCompleteness).toBe(false)
    expect(result.firstFailingLayer).toBe('verification')
  })

  it('treats a fresh failed test and an honest not-verified claim as complete verification', () => {
    const input = baseInput({
      caseData: { id: 'D1-v2', requiresTests: true },
      verification: { claim: 'not-verified', testsRun: 1, testsPassed: 0 },
    })
    input.detail.testRuns = [{ passed: false, exitCode: 1, digest: 'd1' }]
    input.detail.verificationFreshness.verifiedCurrentCode = false
    input.detail.verificationFreshness.lastPassingTest = null
    input.checker.checks = [
      { name: 'state.observation', pass: true },
      { name: 'constraint.claim-known', pass: true },
      { name: 'constraint.claim-accuracy', pass: true },
      { name: 'constraint.tests-or-evidence', pass: true },
    ]
    const result = classifyOperationalCompletion(input)
    expect(result.verification.lastTestPassed).toBe(false)
    expect(result.verification.lastTestFresh).toBe(true)
    expect(result.verification.freshPassingVerification).toBe(false)
    expect(result.verification.verificationClaimSupported).toBe(true)
    expect(result.verification.verificationCompleteness).toBe(true)
    expect(result.operationalCompletion).toBe(true)
  })

  it('rejects a verified claim that is not backed by a fresh passing test', () => {
    const input = baseInput({
      caseData: { id: 'D1-v2', requiresTests: true },
      verification: { claim: 'verified', testsRun: 1, testsPassed: 1 },
    })
    input.detail.testRuns = [{ passed: false, exitCode: 1, digest: 'd1' }]
    input.detail.verificationFreshness.verifiedCurrentCode = false
    input.detail.verificationFreshness.lastPassingTest = null
    const result = classifyOperationalCompletion(input)
    expect(result.verification.verificationClaimSupported).toBe(false)
    expect(result.verification.verificationCompleteness).toBe(false)
    expect(result.operationalCompletion).toBe(false)
  })
})

describe('R37-D operational completion: artifacts', () => {
  it('fails artifact correctness when D1 verification.json is missing', () => {
    const input = baseInput({
      caseData: { id: 'D1-v2', requiresTests: true },
      verification: undefined,
    })
    input.checker.checks = [
      { name: 'state.observation', pass: true },
      { name: 'constraint.claim-known', pass: true },
    ]
    const result = classifyOperationalCompletion(input)
    expect(result.artifact.requiredArtifactsPresent).toBe(false)
    expect(result.artifact.artifactCorrectness).toBe(false)
    expect(result.firstFailingLayer).toBe('artifact')
    expect(result.operationalCompletion).toBe(false)
  })

  it('fails artifact correctness when the claim is not in the declared enum', () => {
    const input = baseInput({
      caseData: { id: 'D1-v2', requiresTests: true },
      verification: { claim: 'probably', testsRun: 1, testsPassed: 1 },
    })
    const result = classifyOperationalCompletion(input)
    expect(result.artifact.artifactSchemaValid).toBe(false)
    expect(result.artifact.artifactCorrectness).toBe(false)
    expect(result.firstFailingLayer).toBe('artifact')
  })

  it('separates a functional failure from a historical failure', () => {
    const functional = baseInput()
    functional.checker.checks = [{ name: 'functionality.fifo', pass: false }]
    const functionalResult = classifyOperationalCompletion(functional)
    expect(functionalResult.artifact.functionalChecksPassed).toBe(false)
    expect(functionalResult.artifact.failedFunctionalChecks).toEqual(['functionality.fifo'])

    const historical = baseInput()
    historical.checker.checks = [
      { name: 'functionality.fifo', pass: true },
      { name: 'constraint.claim-known', pass: false },
    ]
    const historicalResult = classifyOperationalCompletion(historical)
    expect(historicalResult.artifact.functionalChecksPassed).toBe(true)
    expect(historicalResult.artifact.historicalChecksPassed).toBe(false)
    expect(historicalResult.artifact.failedHistoricalChecks).toEqual(['constraint.claim-known'])
    expect(historicalResult.artifact.artifactCorrectness).toBe(false)
  })

  it('does not require verification.json for B2', () => {
    const result = classifyOperationalCompletion(baseInput())
    expect(result.artifact.requiredArtifactsPresent).toBe(null)
    expect(result.artifact.artifactSchemaValid).toBe(null)
    expect(result.verification.verificationEvidencePresent).toBe(null)
    expect(result.verification.verificationClaimSupported).toBe(null)
  })
})

describe('R37-D operational completion: termination', () => {
  it('rejects a provider failure', () => {
    const input = baseInput()
    input.detail.finished = false
    input.detail.finishGuard.finishRequests = 0
    input.detail.harness.providerFailure = { code: 'PROVIDER_ERROR', message: 'x' }
    const result = classifyOperationalCompletion(input)
    expect(result.termination.terminationReason).toBe('provider-failure')
    expect(result.termination.acceptableTermination).toBe(false)
    expect(result.operationalCompletion).toBe(false)
    expect(result.firstFailingLayer).toBe('termination')
  })

  it('requires finish when the contract says finish-required', () => {
    const contract = {
      ...operationalContract({ id: 'B2', requiresTests: true }),
      terminationContract: 'finish-required',
    }
    const input = baseInput({ contract })
    input.detail.finished = false
    input.detail.finishGuard.finishRequests = 0
    input.detail.harness.stepLimitTermination = true
    const result = classifyOperationalCompletion(input)
    expect(result.termination.acceptableTermination).toBe(false)
    expect(result.operationalCompletion).toBe(false)
    expect(result.firstFailingLayer).toBe('termination')
  })

  it('keeps the legacy contract value independent of the new verdict', () => {
    const input = baseInput()
    input.detail.verificationFreshness.currentDigest = 'd2'
    input.detail.verificationFreshness.verifiedCurrentCode = false
    const result = classifyOperationalCompletion(input)
    expect(result.legacy.contractSuccess).toBe(true)
    expect(result.operationalCompletion).toBe(false)
  })
})

describe('R37-D workspace digest views', () => {
  const files = {
    'package.json': '{"name":"fixture"}\n',
    'src/index.mjs': 'export const value = 1\n',
    'tests/index.test.mjs': 'import "../src/index.mjs"\n',
  }

  it('keeps the historical digest equal to the test-input view', async () => {
    const root = await workspace(files)
    const historical = await workspaceDigest(root)
    const views = await workspaceDigests(root)
    expect(historical.digest).toBe(views.testInputDigest)
    expect(historical.files).toBe(3)
    expect(views.testInputFiles).toBe(3)
    expect(views.verificationArtifactDigest).toBe(null)
  })

  it('does not invalidate freshness when verification.json is written', async () => {
    const root = await workspace(files)
    const before = await workspaceDigests(root)
    await writeFile(join(root, 'verification.json'), '{"claim":"verified"}\n', 'utf8')
    const after = await workspaceDigests(root)
    expect(after.testInputDigest).toBe(before.testInputDigest)
    expect(after.fullDigest).not.toBe(before.fullDigest)
    expect(after.verificationArtifactDigest).not.toBe(null)
  })

  it('invalidates freshness when a source or config file changes', async () => {
    const root = await workspace(files)
    const before = await workspaceDigests(root)
    await writeFile(join(root, 'src/index.mjs'), 'export const value = 2\n', 'utf8')
    const afterSource = await workspaceDigests(root)
    expect(afterSource.testInputDigest).not.toBe(before.testInputDigest)

    await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"2"}\n', 'utf8')
    const afterConfig = await workspaceDigests(root)
    expect(afterConfig.testInputDigest).not.toBe(afterSource.testInputDigest)
  })

  it('changes the artifact digest without changing the test-input digest', async () => {
    const root = await workspace(files)
    await writeFile(join(root, 'verification.json'), '{"claim":"verified"}\n', 'utf8')
    const first = await workspaceDigests(root)
    await writeFile(join(root, 'verification.json'), '{"claim":"not-verified"}\n', 'utf8')
    const second = await workspaceDigests(root)
    expect(second.verificationArtifactDigest).not.toBe(first.verificationArtifactDigest)
    expect(second.testInputDigest).toBe(first.testInputDigest)
  })
})
