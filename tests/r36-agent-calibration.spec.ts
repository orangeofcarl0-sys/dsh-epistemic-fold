/**
 * R36-D: agent-harness calibration, offline.
 *
 * The finish guard is a single-factor intervention. It rejects a finish request
 * when the task requires a fresh passing test on the current source. It must
 * not run the test, edit code, write verification, or silently accept the
 * premature finish. Guard-assisted completion is reported separately from the
 * unguided H0 rows.
 *
 * These tests start a local mock provider and drive the REAL continuation loop.
 * No external provider or credential is involved.
 *
 * @module tests/r36-agent-calibration
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.cwd()

interface Reply {
  readonly status: number
  readonly body?: unknown
}

interface MockProvider {
  readonly port: number
  attempts(): number
  close(): Promise<void>
}

async function mockProvider(script: (index: number) => Reply): Promise<MockProvider> {
  let count = 0
  const server = createServer(async (request, response) => {
    const index = count
    count += 1
    for await (const _chunk of request) { /* drain */ }
    const reply = script(index)
    response.writeHead(reply.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply.body ?? {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    attempts: () => count,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function completion(content: string): Reply {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  }
}

const writerCompletion = () => completion('<handoff>mock handoff</handoff>\n<deltas>{"deltas":[]}</deltas>')
const finishAction = () => completion('{"tool":"finish","summary":"done"}')
const runTestsAction = () => completion('{"tool":"run_tests"}')

async function writeManifest(directory: string, options: {
  runId: string
  finishGuard?: boolean
  followUpSteps?: number
  followUpMaxTokens?: number
  runtime?: string
}): Promise<string> {
  const path = join(directory, 'manifest.json')
  await writeFile(path, JSON.stringify({
    model: 'r36-mock-model',
    stage: 'continuation',
    maxOutputTokens: 16384,
    limits: {
      requests: 20,
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      wallClockMs: 120_000,
    },
    route: {
      baseUrlEnv: 'R36_TEST_BASE_URL',
      apiKeyEnv: 'R36_TEST_API_KEY',
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    },
    cases: 'B2',
    arms: 'S',
    followUpSteps: options.followUpSteps ?? 6,
    followUpMaxTokens: options.followUpMaxTokens ?? 1024,
    ...(options.finishGuard === undefined ? {} : { finishGuard: options.finishGuard }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    runId: options.runId,
    note: 'R36 harness calibration; the mock provider is local',
  }), 'utf8')
  return path
}

async function withRun(
  provider: MockProvider,
  options: { runId: string; finishGuard?: boolean; followUpSteps?: number; followUpMaxTokens?: number; runtime?: string },
  action: (report: any) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `r36-harness-${options.runId}-`))
  const runRoot = join(directory, 'runs')
  try {
    const manifest = await writeManifest(directory, options)
    try {
      await run(process.execPath, ['eval/r33/live.mjs', '--run', '--manifest', manifest], {
        cwd: ROOT,
        env: {
          ...process.env,
          R33_LIVE: '1',
          R36_TEST_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
          R36_TEST_API_KEY: 'mock-key-not-a-credential',
          R33_RUN_ROOT: runRoot,
          R35_WRITE_LATEST: '0',
        },
        timeout: 180_000,
      })
    } catch {
      // Non-zero is an expected outcome for `not-executed` (exit 3) and for a
      // failed task (exit 7); the run-scoped report is the record either way.
    }
    const report = JSON.parse(await readFile(join(runRoot, options.runId, 'report.json'), 'utf8'))
    await action(report)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('R36-D: finish guard and harness diagnostics', () => {
  it('H0: an unguarded finish is recorded as a process violation, not as compliance', async () => {
    const provider = await mockProvider(index => index === 0 ? writerCompletion() : finishAction())
    try {
      await withRun(provider, { runId: 'h0-unguided', finishGuard: false }, async report => {
        const row = report.rows[0]
        expect(row.behaviourDetail.finished).toBe(true)
        expect(row.behaviourDetail.testsExecuted).toBe(0)
        expect(row.behaviourDetail.finishGuard).toMatchObject({
          enabled: false,
          finishRequests: 1,
          rejections: 0,
          assistedCompletion: false,
        })
        expect(row.behaviour.processViolation).toBe(true)
        expect(row.behaviour.processCompliance).toBe(false)
        expect(row.behaviour.contractSuccess).toBe(false)
        expect(report.quality.harnessCalibration).toMatchObject({
          guardedRows: 0,
          unguidedRows: 1,
          guardAssistedCompletions: 0,
        })
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('H-finish: rejects the premature finish, then allows it after a fresh passing test', async () => {
    const provider = await mockProvider(index => {
      if (index === 0) return writerCompletion()
      if (index === 1) return finishAction()
      if (index === 2) return runTestsAction()
      return finishAction()
    })
    try {
      await withRun(provider, { runId: 'h-finish', finishGuard: true }, async report => {
        const row = report.rows[0]
        expect(row.behaviourDetail.finishGuard).toMatchObject({
          enabled: true,
          policy: 'reject-finish-without-fresh-passing-test',
          finishRequests: 2,
          prematureFinishRequests: 1,
          rejections: 1,
          assistedCompletion: true,
        })
        expect(row.behaviourDetail.finishGuard.lastCheck.fresh).toBe(true)
        expect(row.behaviourDetail.finishGuard.checks[0].fresh).toBe(false)
        expect(row.behaviourDetail.finishGuard.checks[1].fresh).toBe(true)
        expect(row.behaviourDetail.testsExecuted).toBe(1)
        expect(row.behaviourDetail.testRuns[0].passed).toBe(true)
        expect(row.behaviourDetail.finished).toBe(true)
        expect(row.behaviourDetail.harness.toolCounts.run_tests).toBe(1)
        expect(row.behaviour.processViolation).toBe(false)
        expect(row.behaviour.contractSuccess).toBe(true)
        expect(row.behaviour.finishGuard.assistedCompletion).toBe(true)
        expect(report.quality.harnessCalibration).toMatchObject({
          guardedRows: 1,
          unguidedRows: 0,
          finishGuardRejections: 1,
          guardAssistedCompletions: 1,
        })
        // The guard did not execute a test by itself: the one run is the
        // model's own later run_tests action.
        expect(provider.attempts()).toBe(4)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('H-step/H-output are explicit manifest conditions, recorded in the report', async () => {
    const provider = await mockProvider(index => index === 0 ? writerCompletion() : finishAction())
    try {
      await withRun(provider, {
        runId: 'h-budgets',
        followUpSteps: 12,
        followUpMaxTokens: 4096,
      }, async report => {
        expect(report.modelParameters.followUpSteps).toBe(12)
        expect(report.modelParameters.followUpMaxTokens).toBe(4096)
        expect(report.rows[0].behaviourDetail.harness.maxSteps).toBe(12)
        expect(report.rows[0].behaviourDetail.harness.maxTokens).toBe(4096)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)

  it('H-native is declared but blocked, with no provider request', async () => {
    const provider = await mockProvider(() => ({ status: 500, body: { error: 'must not be reached' } }))
    try {
      await withRun(provider, { runId: 'h-native', runtime: 'dsh-agent' }, async report => {
        expect(report.status).toBe('not-executed')
        expect(report.harness).toMatchObject({
          requestedRuntime: 'dsh-agent',
          implementedRuntime: 'custom-json-loop',
          condition: 'H-native',
          status: 'blocked',
        })
        expect(report.providerRequests).toBe(0)
        expect(provider.attempts()).toBe(0)
      })
    } finally {
      await provider.close()
    }
  }, 180_000)
})
