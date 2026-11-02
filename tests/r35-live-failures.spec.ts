/**
 * R34.1-A/B/C: the live entry's accounting and failure paths, end to end.
 *
 * These tests start a LOCAL OpenAI-compatible mock provider and run the real
 * `eval/r33/live.mjs --run` process against it. No credential and no external
 * network are involved; the mock is the "provider". They assert on the
 * run-scoped report, so they exercise the same reader an operator would use.
 *
 * Covered:
 *  - 429, 429, 200 is three HTTP attempts, two retries, two unknown-usage
 *    attempts, and the FINAL REPORT says two — not four;
 *  - a writer failure the fold safely degrades around is a provider failure,
 *    not an agent task failure;
 *  - a follow-up failure after the fold is a provider failure, and the cost
 *    of the requests that already happened is preserved;
 *  - a normal run whose tasks all fail the hidden checker is a valid negative
 *    result, not a harness failure;
 *  - a budget refusal inside a safely degraded call still stops the run and
 *    keeps its charged usage;
 *  - preflight refuses a manifest whose per-request bound is below the real
 *    writer's 16,384-token floor.
 *
 * @module tests/r35-live-failures
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadDataset } from '../eval/r33/src/dataset.mjs'

const run = promisify(execFile)
const ROOT = process.cwd()

interface Reply {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
}

interface MockProvider {
  readonly port: number
  readonly bodies: unknown[]
  attempts(): number
  close(): Promise<void>
}

async function mockProvider(script: (body: any, index: number) => Reply): Promise<MockProvider> {
  let count = 0
  const bodies: unknown[] = []
  const server = createServer(async (request, response) => {
    const index = count
    count += 1
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
    bodies.push(parsed)
    let reply: Reply
    try {
      reply = script(parsed, index)
    } catch (error) {
      reply = { status: 500, body: { error: String(error) } }
    }
    response.writeHead(reply.status, {
      'content-type': 'application/json',
      ...(reply.headers ?? {}),
    })
    response.end(JSON.stringify(reply.body ?? {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    bodies,
    attempts: () => count,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function completion(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): Reply {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage,
    },
  }
}

function writerCompletion(): Reply {
  return completion('<handoff>mock handoff</handoff>\n<deltas>{"deltas":[]}</deltas>')
}

/**
 * A protocol-valid writer answer whose handoff cannot pay for a small fold.
 *
 * The guard compares the framed checkpoint against the shadowed span's route
 * price. On F1 that span is 598 tokens, so a multi-thousand-character handoff
 * is correctly refused. The refusal is a writer/fold result, not a harness
 * crash, and the remaining cases must still run.
 */
function verboseWriterCompletion(): Reply {
  const prose = 'The recorded decision was reviewed against the frozen transcript and the surrounding context was restated at unnecessary length. '.repeat(45)
  return completion(`<handoff>${prose}</handoff>\n<deltas>{"deltas":[]}</deltas>`)
}

function finishAction(): Reply {
  return completion('{"tool":"finish","summary":"mock finish"}', {
    prompt_tokens: 80,
    completion_tokens: 8,
  })
}

async function writeManifest(directory: string, options: {
  runId: string
  stage?: 'writer-only' | 'continuation'
  cases?: string
  arms?: string
  limits?: Record<string, number>
  maxOutputTokens?: number
}): Promise<string> {
  const path = join(directory, 'manifest.json')
  await writeFile(path, JSON.stringify({
    model: 'r35-mock-model',
    stage: options.stage ?? 'writer-only',
    maxOutputTokens: options.maxOutputTokens ?? 16384,
    limits: options.limits ?? {
      requests: 20,
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      wallClockMs: 120_000,
    },
    route: {
      baseUrlEnv: 'R35_TEST_BASE_URL',
      apiKeyEnv: 'R35_TEST_API_KEY',
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    },
    cases: options.cases ?? 'A1',
    arms: options.arms ?? 'S',
    followUpSteps: 2,
    runId: options.runId,
    note: 'test manifest; the mock provider is local',
  }), 'utf8')
  return path
}

async function live(args: string[], env: Record<string, string>): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  try {
    const result = await run(process.execPath, ['eval/r33/live.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 180_000,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function readReport(runRoot: string, runId: string): Promise<any> {
  return JSON.parse(await readFile(join(runRoot, runId, 'report.json'), 'utf8'))
}

async function withRun(
  provider: MockProvider,
  options: {
    runId: string
    stage: 'writer-only' | 'continuation'
    cases?: string
    arms?: string
    limits?: Record<string, number>
  },
  action: (report: any, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `r35-live-${options.runId}-`))
  const runRoot = join(directory, 'runs')
  try {
    const manifest = await writeManifest(directory, {
      runId: options.runId,
      stage: options.stage,
      ...(options.cases === undefined ? {} : { cases: options.cases }),
      ...(options.arms === undefined ? {} : { arms: options.arms }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    })
    const result = await live(['--run', '--manifest', manifest], {
      R33_LIVE: '1',
      R35_TEST_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      R35_TEST_API_KEY: 'mock-key-not-a-credential',
      R33_RUN_ROOT: runRoot,
      R35_WRITE_LATEST: '0',
    })
    expect(result.stderr, result.stderr).not.toContain('mock-key-not-a-credential')
    const report = await readReport(runRoot, options.runId)
    await action(report, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('R34.1 live accounting and failure classification', () => {
  it('counts 429,429,200 once in the ledger and once in the final report', async () => {
    const provider = await mockProvider((_body, index) => index < 2
      ? { status: 429, headers: { 'retry-after': '0' } }
      : writerCompletion())
    try {
      await withRun(provider, { runId: 'retry-accounting', stage: 'writer-only' }, async report => {
        expect(provider.attempts()).toBe(3)
        expect(report.status).toBe('executed-success')
        expect(report.ledger.used.attempts).toBe(3)
        expect(report.ledger.used.retries).toBe(2)
        expect(report.ledger.unknownUsageRequests).toBe(2)
        expect(report.retryAccounting.authority).toBe('ledger')
        expect(report.retryAccounting.ledgerRetries).toBe(2)
        expect(report.retryAccounting.adapter.retries).toBe(2)
        expect(report.retryAccounting.consistent).toBe(true)

        const row = report.rows[0]
        expect(row.valid).toBe(true)
        expect(row.failures.outcome).toBe('writer-only-measured')
        expect(row.failures.provider).toEqual([])
        expect(row.writer.call).toBe('success')
        expect(row.writer.protocol).toBe('parsed')
        expect(row.cost.httpAttempts).toBe(3)
        expect(row.cost.httpRetries).toBe(2)
        expect(row.cost.unknownUsageRequests).toBe(2)
        expect(row.cost.chargedInputTokens).toBeGreaterThan(row.cost.observedInputTokens)
        expect(row.cost.chargedOutputTokens).toBeGreaterThan(row.cost.observedOutputTokens)
        expect(report.runElapsedMs).toBeGreaterThanOrEqual(0)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('classifies a writer HTTP failure as a provider failure while the fold safely degrades', async () => {
    const provider = await mockProvider(() => ({ status: 500, body: { error: 'mock upstream failure' } }))
    try {
      await withRun(provider, { runId: 'writer-failure', stage: 'writer-only' }, async report => {
        expect(provider.attempts()).toBe(1)
        expect(report.status).toBe('provider-unavailable')
        expect(report.quality.measurementValid).toBe(true)
        const row = report.rows[0]
        // The fold completed deterministically; the writer's failure is a
        // measured provider failure, not an agent task failure.
        expect(row.valid).toBe(true)
        expect(row.fold.valid).toBe(true)
        expect(row.writer.call).toBe('failed')
        expect(row.writer.protocol).toBe('not-called')
        expect(row.failures.outcome).toBe('writer-only-measured')
        expect(row.failures.provider).toHaveLength(1)
        expect(row.failures.provider[0].kind).toBe('provider-http-error')
        expect(row.failures.provider[0].stage).toBe('fold-writer')
        expect(row.failures.task.assessed).toBe(false)
        expect(row.providerCalls).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 })
        // A 500 produced no usage record; its whole reserve stays charged and
        // the attempt is counted as unknown, never as zero.
        expect(report.ledger.unknownUsageRequests).toBeGreaterThanOrEqual(1)
        expect(row.cost.unknownUsageRequests).toBeGreaterThanOrEqual(1)
        expect(row.cost.reservedOutputTokens).toBe(16_384)
        expect(row.cost.chargedOutputTokens).toBe(16_384)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('preserves the cost of successful calls when the follow-up provider fails', async () => {
    const provider = await mockProvider((_body, index) => index === 0
      ? writerCompletion()
      : { status: 500, body: { error: 'follow-up unavailable' } })
    try {
      await withRun(provider, {
        runId: 'follow-up-failure',
        stage: 'continuation',
        arms: 'S',
        limits: { requests: 20, inputTokens: 2_000_000, outputTokens: 200_000, wallClockMs: 120_000 },
      }, async report => {
        expect(provider.attempts()).toBe(2)
        // The writer call succeeded, so the route answered. A follow-up failure
        // leaves this case without a valid measurement, but it is NOT a
        // provider outage: calling it provider-unavailable would blame the
        // route for a failure that happened after a successful call.
        expect(report.providerAvailability).toMatchObject({
          attempts: 2,
          successes: 1,
          unavailable: false,
        })
        expect(report.status).toBe('executed-failed')
        expect(report.quality.measurementValid).toBe(false)
        const row = report.rows[0]
        expect(row.valid).toBe(false)
        expect(row.measurementValid).toBe(false)
        expect(row.failures.outcome).toBe('provider-http-error')
        expect(row.failures.provider[0].stage).toBe('follow-up')
        expect(row.failures.task.assessed).toBe(false)
        expect(row.behaviourDetail.providerFailure.code).toBe('LIVE_HTTP')
        // The writer request really happened; its cost is not zeroed just
        // because the case ended in a provider failure.
        expect(row.cost.httpAttempts).toBe(2)
        expect(row.cost.observedInputTokens).toBeGreaterThan(0)
        expect(row.cost.observedOutputTokens).toBeGreaterThan(0)
        expect(row.cost.chargedInputTokens).toBeGreaterThan(0)
        expect(row.cost.caseDurationMs).toBeGreaterThanOrEqual(0)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('reports a normal run whose tasks all fail as a valid negative result', async () => {
    const provider = await mockProvider((_body, index) => index === 0
      ? writerCompletion()
      : finishAction())
    try {
      await withRun(provider, {
        runId: 'all-tasks-fail',
        stage: 'continuation',
        arms: 'S',
      }, async report => {
        expect(report.status).toBe('executed-failed')
        expect(report.quality.measurementValid).toBe(true)
        expect(report.quality.taskSuccesses).toBe(0)
        expect(report.quality.taskSuccessRate).toBe(0)
        expect(report.quality.functionalFailures).toBe(1)
        const row = report.rows[0]
        expect(row.valid).toBe(true)
        expect(row.failures.outcome).toBe('valid-task-failure')
        expect(row.failures.provider).toEqual([])
        expect(row.failures.task.assessed).toBe(true)
        expect(row.failures.task.functionalFailure).toBe(true)
        expect(row.behaviour.taskSuccess).toBe(false)
        expect(row.behaviour.contractSuccess).toBe(false)
        // The task required tests and the mock agent finished without running any.
        expect(row.behaviour.processViolation).toBe(true)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('stops on a budget refusal inside a safely degraded writer and keeps its charge', async () => {
    const provider = await mockProvider(() => ({ status: 429, headers: { 'retry-after': '0' } }))
    try {
      await withRun(provider, {
        runId: 'budget-refusal',
        stage: 'writer-only',
        limits: { requests: 1, inputTokens: 2_000_000, outputTokens: 200_000, wallClockMs: 120_000 },
      }, async report => {
        expect(provider.attempts()).toBe(1)
        expect(report.status).toBe('budget-exhausted')
        expect(report.ledger.used.attempts).toBe(1)
        expect(report.ledger.refusals).toBe(1)
        expect(report.ledger.unknownUsageRequests).toBe(1)
        const row = report.rows[0]
        expect(row.valid).toBe(false)
        expect(row.failures.outcome).toBe('budget-exhausted')
        expect(row.failures.budget.length).toBeGreaterThan(0)
        expect(row.failures.provider).toEqual([])
        expect(row.cost.httpAttempts).toBe(1)
        expect(row.cost.budgetRefusals).toBe(1)
        expect(row.cost.chargedInputTokens).toBeGreaterThan(0)
        expect(row.cost.chargedOutputTokens).toBeGreaterThan(0)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('preflight rejects a per-request bound below the real writer floor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-preflight-'))
    try {
      const manifest = await writeManifest(directory, {
        runId: 'preflight-incompatible',
        stage: 'writer-only',
        cases: 'A1',
        arms: 'S',
        maxOutputTokens: 8192,
      })
      const result = await live(['--preflight', '--manifest', manifest], {
        R33_LIVE: undefined,
        R35_TEST_BASE_URL: undefined,
        R35_TEST_API_KEY: undefined,
      } as unknown as Record<string, string>)
      expect(result.code).toBe(2)
      const report = JSON.parse(await readFile(join(ROOT, 'eval', 'r33', 'out', 'preflight-report.json'), 'utf8'))
      expect(report.status).toBe('preflight-infeasible')
      expect(report.providerRequests).toBe(0)
      expect(report.routeCredentials).toBe('not-read')
      expect(report.results[0].actualFoldMaxTokens).toBe(16_384)
      expect(report.results[0].verdict).toBe('infeasible')
      expect(report.results[0].reasons.some((entry: any) => entry.axis === 'per-request-output')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it('scores a real writer-only proposal against the frozen gold fact', async () => {
    const { cases } = await loadDataset()
    const caseData = cases.find((entry: any) => entry.id === 'A1')
    const fact = caseData.gold[0]
    const delta = {
      kind: fact.kind,
      subjectKey: fact.subjectKey,
      statement: fact.statement,
      status: fact.kind === 'finding' ? 'observed' : 'claimed',
      evidence: [{ quote: fact.quote }],
      ...(fact.scope === undefined ? {} : { scope: fact.scope }),
    }
    const provider = await mockProvider(() => completion(
      `<handoff>the constraint is preserved</handoff>\n<deltas>${JSON.stringify({ deltas: [delta] })}</deltas>`,
    ))
    try {
      await withRun(provider, {
        runId: 'writer-extraction',
        stage: 'writer-only',
        cases: 'A1',
        arms: 'S',
      }, async report => {
        expect(report.status).toBe('executed-success')
        const row = report.rows[0]
        expect(row.writer.call).toBe('success')
        expect(row.writer.protocol).toBe('parsed')
        expect(row.writer.accepted).toBe(1)
        expect(row.writer.commitStatus).toBe('committed')

        // R34.1 left writer-only extraction at "this arm commits no semantic
        // deltas"; a parsed and committed proposal must be scored.
        expect(row.extraction.applicable).toBe(true)
        expect(row.extraction.criticalRecall).toBe(1)
        expect(row.extraction.claimCorrectness).toBe(1)
        expect(row.extraction.coordinateRecall).toBe(1)
        expect(row.extraction.sourceSupport).toBe(1)
        expect(row.extraction.falseNormativeRate).toBe(0)
        expect(row.extraction.requiresReview).toBe(0)
        expect(row.extraction.currentStateAccuracy).toBe(1)
        expect(row.extraction.counts).toMatchObject({ gold: 1, matched: 1, accepted: 1, refused: 0 })
        expect(report.quality.writerExtraction).toMatchObject({
          realWriterRows: 1,
          scoredRows: 1,
          criticalRecall: 1,
          claimCorrectness: 1,
          sourceSupport: 1,
          falseNormativeRate: 0,
          requiresReview: 0,
          accepted: 1,
          refused: 0,
          scoredCaseIds: ['A1'],
        })
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('continues on full history when a continuation fold is refused', async () => {
    // The first response is the writer's overlong handoff; later responses are
    // the follow-up agent's finish action. The fold cannot shrink the span, so
    // the task must run against the uncompressed history, not be skipped.
    const provider = await mockProvider((_body, index) => index === 0
      ? verboseWriterCompletion()
      : finishAction())
    try {
      await withRun(provider, {
        runId: 'continuation-fold-fallback',
        stage: 'continuation',
        cases: 'A1',
        arms: 'S',
      }, async report => {
        expect(provider.attempts()).toBeGreaterThanOrEqual(2)
        expect(report.status).toBe('executed-failed')
        expect(report.harnessError).toBeNull()
        const row = report.rows[0]
        expect(row.valid).toBe(true)
        expect(row.fold.valid).toBe(false)
        expect(row.foldFallback).toBe('full-history')
        expect(row.failures.fold[0]).toMatchObject({
          kind: 'fold-refused',
          reason: 'summary-not-smaller',
          fallback: 'full-history',
        })
        expect(row.checker.status).toBe('executed')
        expect(row.behaviour.taskSuccess).toBe(false)
        expect(row.behaviourDetail).not.toBeNull()
        expect(row.failures.task.assessed).toBe(true)
        // The fallback must hand the follow-up the uncompressed history, not an
        // empty checkpoint. A1's first user message is the compatibility
        // constraint, and it must be in the context the agent received.
        expect(row.checkpoint.text).toContain('loadConfig(path) string form')
        expect(row.checkpoint.chars).toBeGreaterThan(0)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('records a non-compressing writer summary as a fold refusal and continues', async () => {
    // F1's first real answer is too long for its small span; A1's is normal.
    // The run must record F1's refusal and still measure A1.
    const provider = await mockProvider((_body, index) => index === 0
      ? verboseWriterCompletion()
      : writerCompletion())
    try {
      await withRun(provider, {
        runId: 'fold-refused',
        stage: 'writer-only',
        cases: 'F1,A1',
        arms: 'S,O1',
      }, async report => {
        expect(provider.attempts()).toBe(2)
        // F1's S and O1 rows are refused; A1's S and O1 rows commit. That is a
        // partial run, not a harness crash and not a provider outage.
        expect(report.status).toBe('executed-partial')
        expect(report.harnessError).toBeNull()
        expect(report.stopReason).toBeNull()
        expect(report.providerAvailability).toMatchObject({ attempts: 2, successes: 2, unavailable: false })

        const row = (arm: string, caseId: string) =>
          report.rows.find((entry: any) => entry.arm === arm && entry.caseId === caseId)

        const refused = row('S', 'A1')
        expect(refused.valid).toBe(false)
        expect(refused.fold.valid).toBe(false)
        expect(refused.failures.fold).toHaveLength(1)
        expect(refused.failures.fold[0].kind).toBe('fold-refused')
        expect(refused.failures.fold[0].reason).toBe('summary-not-smaller')
        expect(refused.writer.call).toBe('success')
        expect(refused.writer.protocol).toBe('parsed')
        expect(refused.writer.commitStatus).toBe('fold-refused')
        expect(refused.writer.rawOutputChars).toBeGreaterThan(1_000)
        expect(refused.writer.rawOutputDigest).toMatch(/^[0-9a-f]{16}/u)
        expect(refused.cost.httpAttempts).toBe(1)
        expect(refused.cost.observedOutputTokens).toBeGreaterThan(0)

        // The refusal did not stop the run: the next case was measured. Its
        // writer proposed an empty delta list, so the fold commits a
        // deterministic checkpoint with nothing accepted — a protocol-valid
        // answer, not a semantic success.
        const measured = row('S', 'F1')
        expect(measured.valid).toBe(true)
        expect(measured.fold.valid).toBe(true)
        expect(measured.writer.call).toBe('success')
        expect(measured.writer.commitStatus).toBe('nothing-accepted')
        expect(measured.writer.accepted).toBe(0)
        expect(row('O1', 'F1').valid).toBe(true)

        const writer = report.quality.writerMeasurements
        expect(writer.realWriterRows).toBe(2)
        expect(writer.callSucceeded).toBe(2)
        expect(writer.callFailed).toBe(0)
        expect(writer.oracleControls).toBe(2)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)
})
