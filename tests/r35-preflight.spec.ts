/**
 * R34.1-B: the zero-request budget preflight.
 *
 * The preflight must run the REAL fold call path, report the actual
 * `maxTokens` the production writer asks for, and refuse a manifest that
 * cannot admit it. It must also refuse a run-directory collision and a plan
 * whose total request count exceeds the manifest. It reads no route
 * credential.
 *
 * @module tests/r35-preflight
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.cwd()
const PREFLIGHT_REPORT = join(ROOT, 'eval', 'r33', 'out', 'preflight-report.json')

async function preflight(args: string[], env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) merged[key] = value
  }
  try {
    const result = await run(process.execPath, ['eval/r33/live.mjs', '--preflight', ...args], {
      cwd: ROOT,
      env: merged,
      timeout: 180_000,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function readPreflight(): Promise<any> {
  return JSON.parse(await readFile(PREFLIGHT_REPORT, 'utf8'))
}

async function manifest(directory: string, options: {
  runId?: string
  cases?: string
  arms?: string
  maxOutputTokens?: number
  limits?: Record<string, number>
  routeMaxOutputTokens?: number | null
}): Promise<string> {
  const path = join(directory, 'manifest.json')
  await writeFile(path, JSON.stringify({
    model: 'preflight-model',
    stage: 'writer-only',
    maxOutputTokens: options.maxOutputTokens ?? 16384,
    limits: options.limits ?? {
      requests: 10,
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      wallClockMs: 120_000,
    },
    route: {
      baseUrlEnv: 'R35_TEST_BASE_URL',
      apiKeyEnv: 'R35_TEST_API_KEY',
      contextWindow: 131_072,
      ...(options.routeMaxOutputTokens === null
        ? {}
        : { maxOutputTokens: options.routeMaxOutputTokens ?? 32_768 }),
    },
    cases: options.cases ?? 'A1',
    arms: options.arms ?? 'S',
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  }), 'utf8')
  return path
}

describe('R34.1 zero-request preflight', () => {
  it('reports the real writer floor and marks model capability unverified when undeclared', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-preflight-ok-'))
    try {
      const path = await manifest(directory, { routeMaxOutputTokens: null })
      const result = await preflight(['--manifest', path])
      expect(result.code, result.stderr).toBe(0)
      const report = await readPreflight()
      expect(report.status).toBe('preflight-ok')
      expect(report.providerRequests).toBe(0)
      expect(report.routeCredentials).toBe('not-read')
      expect(report.results).toHaveLength(1)
      expect(report.results[0].actualFoldMaxTokens).toBe(16_384)
      expect(report.results[0].writerCallStatus).toBe('dry-run response')
      expect(report.results[0].writerProtocol).toBe('parsed')
      expect(report.results[0].verdict).toBe('unknown-model-capability')
      expect(report.summary.unknownModelCapability).toBe(1)
      expect(report.unverified.join(' ')).toContain('model output capability')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses an input budget below one conservative request reserve', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-preflight-input-'))
    try {
      const path = await manifest(directory, {
        limits: { requests: 10, inputTokens: 65_536, outputTokens: 200_000, wallClockMs: 120_000 },
      })
      const result = await preflight(['--manifest', path])
      expect(result.code).toBe(2)
      const report = await readPreflight()
      expect(report.status).toBe('preflight-infeasible')
      expect(report.results[0].verdict).toBe('infeasible')
      expect(report.results[0].reasons.some((entry: any) => entry.axis === 'input-reserve')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses a plan whose total requests exceed the manifest limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-preflight-total-'))
    try {
      const path = await manifest(directory, {
        cases: 'A1,C1',
        limits: { requests: 1, inputTokens: 2_000_000, outputTokens: 200_000, wallClockMs: 120_000 },
      })
      const result = await preflight(['--manifest', path])
      expect(result.code).toBe(2)
      const report = await readPreflight()
      expect(report.status).toBe('preflight-infeasible')
      expect(report.summary.totalPlannedRequests).toBe(2)
      expect(report.blocking.some((entry: any) => entry.axis === 'total-requests')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses a run directory that already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r35-preflight-collision-'))
    const runRoot = join(directory, 'runs')
    try {
      await mkdir(join(runRoot, 'already-used'), { recursive: true })
      const path = await manifest(directory, { runId: 'already-used' })
      const result = await preflight(['--manifest', path], { R33_RUN_ROOT: runRoot })
      expect(result.code).toBe(2)
      const report = await readPreflight()
      expect(report.collision).toBe(true)
      expect(report.blocking.some((entry: any) => entry.axis === 'run-directory')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it('validates the committed example manifest and never logs a credential value', async () => {
    const result = await preflight(
      ['--manifest', join(ROOT, 'eval', 'r33', 'live-manifest.example.json')],
      {
        R35_LIVE_API_KEY: 'SUPER_SECRET_SENTINEL_VALUE',
        R35_LIVE_BASE_URL: 'https://example.invalid/v1',
      },
    )
    expect(result.code, result.stderr).toBe(0)
    const report = await readPreflight()
    expect(report.status).toBe('preflight-ok')
    expect(report.results).toHaveLength(12)
    expect(report.results.every((entry: any) => entry.verdict === 'feasible')).toBe(true)
    expect(report.results.every((entry: any) => entry.actualFoldMaxTokens === 16_384
      || entry.actualFoldMaxTokens === 0)).toBe(true)
    expect(report.providerRequests).toBe(0)
    expect(JSON.stringify(report)).not.toContain('SUPER_SECRET_SENTINEL_VALUE')
  }, 180_000)
})
