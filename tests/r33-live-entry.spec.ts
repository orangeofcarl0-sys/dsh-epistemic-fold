/**
 * R33.1-B/G5: the live gate, the global budget, and honest run statuses.
 *
 * The live run is BLOCKED in this round (no explicit budget permission), so the
 * most important property is that it refuses cleanly and records `not-executed`
 * rather than looking like a successful zero. These tests exercise the real
 * scripts, not a reimplementation:
 *
 *  - `--check` exits 0 and reports `interface-ok` without resolving credentials;
 *  - `--run` without R33_LIVE exits 3 and writes `not-executed`;
 *  - a manifest with a zero limit is refused (0 is not "unlimited");
 *  - snapshots are immutable point-in-time values;
 *  - unknown usage keeps its reservation charged;
 *  - the run status reads `behaviour.taskSuccess`, not a field that does not
 *    exist, and separates execution validity from task quality.
 *
 * @module tests/r33-live-entry
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  BudgetExhausted,
  BudgetLedger,
  loadLiveGate,
  runQuality,
  runStatus,
  snapshotDelta,
} from '../eval/r33/src/budget.mjs'

const run = promisify(execFile)
const ROOT = process.cwd()

async function runScript(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const result = await run(process.execPath, ['eval/r33/live.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 120_000,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/** The report path a run printed on its last stdout line. */
function printedPath(stdout: string): string {
  const lines = stdout.trimEnd().split('\n')
  return lines[lines.length - 1]!.trim()
}

describe('R33 live gate and budget', () => {
  it('validates the interface without resolving credentials', async () => {
    // EF-C1: `--out` keeps this probe from rewriting the TRACKED
    // eval/r33/out/live-check.json. The interface check is not evidence.
    const out = await mkdtemp(join(tmpdir(), 'r33-check-'))
    const result = await runScript(['--check', '--out', out], { R33_LIVE: undefined })
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1))
    expect(parsed.status).toBe('interface-ok')
    expect(parsed.dataset.cases).toBe(17)
    expect(parsed.arms).toEqual(['B1', 'S', 'O1', 'O2'])
    expect(parsed.note).toContain('resolves no credentials')

    // The committed snapshot is historical: verify its identity and require a
    // declared drift when the interface has moved on.
    const committedRaw = readFileSync(join(ROOT, 'eval', 'r33', 'out', 'live-check.json'), 'utf8')
    const committed = JSON.parse(committedRaw) as unknown
    const generated = `${JSON.stringify(parsed, null, 2)}\n`
    const sha256 = (text: string): string =>
      createHash('sha256').update(text.replace(/\r\n/gu, '\n')).digest('hex')
    const registry = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'convergence', 'data', 'report-baselines.json'), 'utf8'),
    ) as { reports: Array<{ id: string; status: string; frozenSha256: string; observedSha256: string; cause: string }> }
    const entry = registry.reports.find(row => row.id === 'r33-live-check')
    expect(entry, 'the R33 live check must be declared in report-baselines.json').toBeDefined()
    expect(sha256(committedRaw), 'the committed live check changed without a baseline update')
      .toBe(entry!.frozenSha256)
    if (JSON.stringify(committed) === JSON.stringify(parsed)) {
      expect(entry!.status, 'the check reproduces; the registry must say current').toBe('current')
    } else {
      expect(entry!.status, 'the check does not reproduce; the drift must be declared').toBe('stale')
      expect(entry!.observedSha256, 'the declared drift digest must match the check').toBe(sha256(generated))
      expect(entry!.cause.length, 'a declared drift needs a cause').toBeGreaterThan(0)
    }
  }, 120_000)

  it('refuses a live run and records not-executed when R33_LIVE is not 1', async () => {
    // EF-C1: a refusal gets its own run-scoped record. It must NOT replace the
    // tracked latest report — that was the defect: running this test erased the
    // record of the last real run.
    const runRoot = await mkdtemp(join(tmpdir(), 'r33-refusal-'))
    const result = await runScript(['--run'], { R33_LIVE: undefined, R33_RUN_ROOT: runRoot })
    expect(result.code).toBe(3)
    const report = JSON.parse(await readFile(printedPath(result.stdout), 'utf8'))
    expect(report.status).toBe('not-executed')
    expect(report.reason).toContain('R33_LIVE')
    expect(report.note).toContain('No provider request was attempted')
  }, 120_000)

  it('refuses a manifest whose limits are zero', async () => {
    const gate = await loadLiveGate(undefined, { R33_LIVE: '1' })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('manifest')
  })

  it('refuses a manifest that embeds a credential header', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(join(tmpdir(), 'r33-gate-'))
    const path = join(directory, 'manifest.json')
    await writeFile(path, JSON.stringify({
      model: 'test-model',
      maxOutputTokens: 1024,
      limits: { requests: 1, inputTokens: 1, outputTokens: 1, wallClockMs: 1 },
      route: {
        baseUrlEnv: 'BASE',
        apiKeyEnv: 'KEY',
        headers: { authorization: 'Bearer secret' },
      },
    }), 'utf8')
    const gate = await loadLiveGate(path, { R33_LIVE: '1' })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('credential')
  })

  it('keeps a snapshot immutable and computes a real per-case delta', () => {
    const ledger = new BudgetLedger({
      requests: 10,
      inputTokens: 1_000,
      outputTokens: 500,
      wallClockMs: 60_000,
    })
    const before = ledger.snapshot()
    const reservation = ledger.reserve({ inputTokens: 40, outputTokens: 10 })
    ledger.recordStream({
      usage: { inputTokens: 30, outputTokens: 5 },
      reservation,
    })
    const after = ledger.snapshot()
    // The before snapshot must NOT have changed when the ledger recorded.
    expect(before.used.requests).toBe(0)
    expect(before.observed.inputTokens).toBe(0)
    expect(before.reserved.inputTokens).toBe(0)
    expect(after.used.requests).toBe(1)
    const delta = snapshotDelta(before, after)
    expect(delta.attempts).toBe(1)
    expect(delta.inputTokens).toBe(30)
    expect(delta.outputTokens).toBe(5)
  })

  it('counts an attempt at admission and keeps unknown/partial usage charged', () => {
    const ledger = new BudgetLedger({
      requests: 2,
      inputTokens: 100,
      outputTokens: 50,
      wallClockMs: 60_000,
    })
    const reservation = { id: 1, inputTokens: 40, outputTokens: 10 }
    ledger.reserve({ inputTokens: 40, outputTokens: 10 })
    ledger.recordStream({ usage: undefined, reservation, retry: true })
    const first = ledger.snapshot()
    expect(first.used.requests).toBe(1)
    expect(first.used.retries).toBe(1)
    expect(first.unknownUsageRequests).toBe(1)
    // The observation is zero, but the CHARGE keeps the whole reservation.
    expect(first.observed.inputTokens).toBe(0)
    expect(first.charged.inputTokens).toBe(40)
    expect(first.charged.outputTokens).toBe(10)
    ledger.reserve({ inputTokens: 40, outputTokens: 10 })
    expect(() => ledger.reserve({ inputTokens: 40, outputTokens: 10 })).toThrow(BudgetExhausted)
  })

  it('does not settle an unreported dimension to zero', () => {
    const ledger = new BudgetLedger({
      requests: 10,
      inputTokens: 1_000,
      outputTokens: 500,
      wallClockMs: 60_000,
    })
    const reservation = { id: 1, inputTokens: 100, outputTokens: 50 }
    ledger.reserve({ inputTokens: 100, outputTokens: 50 })
    ledger.record({ inputTokens: 10 }, undefined, { prompt: true, output: false }, reservation)
    const snap = ledger.snapshot()
    expect(snap.observed.inputTokens).toBe(10)
    // Prompt was reported, so its reserve is released; output was not, so its
    // reserve stands rather than becoming free.
    expect(snap.reserved.inputTokens).toBe(0)
    expect(snap.reserved.outputTokens).toBe(50)
    expect(snap.partialUsageRequests).toBe(1)
  })

  it('distinguishes execution validity from task quality', () => {
    expect(runStatus({ executed: false, cases: [] })).toBe('not-executed')
    expect(runStatus({ executed: true, cases: [], invalid: true })).toBe('invalid-benchmark')
    expect(runStatus({ executed: true, cases: [], budgetExhausted: true })).toBe('budget-exhausted')
    expect(runStatus({
      executed: true,
      cases: [{ valid: true, behaviour: { taskSuccess: false } }],
    })).toBe('executed-failed')
    expect(runStatus({
      executed: true,
      cases: [{ valid: true, behaviour: { taskSuccess: true } }],
    })).toBe('executed-success')
    expect(runStatus({
      executed: true,
      cases: [
        { valid: true, behaviour: { taskSuccess: true } },
        { valid: false, behaviour: { taskSuccess: false } },
      ],
    })).toBe('executed-partial')
    // A valid run where every task failed is a NEGATIVE RESULT, not a broken
    // harness. The fields say so even though the status is executed-failed.
    const quality = runQuality([{ valid: true, behaviour: { taskSuccess: false } }])
    expect(quality.measurementValid).toBe(true)
    expect(quality.taskSuccessRate).toBe(0)
    const broken = runQuality([{ valid: false, behaviour: { taskSuccess: false } }])
    expect(broken.measurementValid).toBe(false)
    expect(broken.taskSuccessRate).toBeNull()
  })
})
