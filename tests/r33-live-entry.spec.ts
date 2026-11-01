/**
 * R33-B/G5: the live gate, the global budget, and honest run statuses.
 *
 * The live run is BLOCKED in this round (no explicit budget permission), so the
 * most important property is that it refuses cleanly and records `not-executed`
 * rather than looking like a successful zero. These tests exercise the real
 * scripts, not a reimplementation:
 *
 *  - `--check` exits 0 and reports `interface-ok`;
 *  - `--run` without R33_LIVE exits 3 and writes `not-executed`;
 *  - a manifest with a zero limit is refused (0 is not "unlimited");
 *  - unknown usage keeps its reservation charged;
 *  - the run status distinguishes success, partial, failure and budget stop.
 *
 * @module tests/r33-live-entry
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  BudgetExhausted,
  BudgetLedger,
  loadLiveGate,
  runStatus,
} from '../eval/r33/src/budget.mjs'

const run = promisify(execFile)
const ROOT = process.cwd()

async function runScript(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const result = await run(process.execPath, ['eval/r33/live.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 60_000,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('R33 live gate and budget', () => {
  it('validates the interface without resolving credentials', async () => {
    const result = await runScript(['--check'], { R33_LIVE: undefined })
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1))
    expect(parsed.status).toBe('interface-ok')
    expect(parsed.cases).toBe(17)
    expect(parsed.note).toContain('resolves no credentials')
  }, 60_000)

  it('refuses a live run and records not-executed when R33_LIVE is not 1', async () => {
    const result = await runScript(['--run'], { R33_LIVE: undefined })
    expect(result.code).toBe(3)
    const report = JSON.parse(await readFile(join(ROOT, 'eval', 'r33', 'out', 'live-report.json'), 'utf8'))
    expect(report.status).toBe('not-executed')
    expect(report.reason).toContain('R33_LIVE')
    expect(report.note).toContain('No provider request was attempted')
  }, 60_000)

  it('refuses a manifest whose limits are zero', async () => {
    const gate = await loadLiveGate(undefined, { R33_LIVE: '1' })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('manifest')
  })

  it('counts retries and keeps unknown usage charged', () => {
    const ledger = new BudgetLedger({
      requests: 2,
      inputTokens: 100,
      outputTokens: 50,
      wallClockMs: 60_000,
    })
    const reservation = { inputTokens: 40, outputTokens: 10 }
    ledger.reserve(reservation)
    ledger.record({ usage: undefined, reservation, retry: true })
    expect(ledger.snapshot().used.requests).toBe(1)
    expect(ledger.snapshot().used.retries).toBe(1)
    expect(ledger.snapshot().used.unknownUsage).toBe(1)
    expect(ledger.snapshot().used.inputTokens).toBe(40)
    ledger.reserve(reservation)
    ledger.record({ usage: { inputTokens: 30, outputTokens: 5 }, reservation })
    expect(() => ledger.reserve(reservation)).toThrow(BudgetExhausted)
  })

  it('distinguishes run statuses', () => {
    expect(runStatus({ executed: false, cases: [] })).toBe('not-executed')
    expect(runStatus({ executed: true, cases: [], invalid: true })).toBe('invalid-benchmark')
    expect(runStatus({ executed: true, cases: [], budgetExhausted: true })).toBe('budget-exhausted')
    expect(runStatus({ executed: true, cases: [{ valid: true, taskSuccess: false }] })).toBe('executed-failed')
    expect(runStatus({ executed: true, cases: [{ valid: true, taskSuccess: true }] })).toBe('executed-success')
    expect(runStatus({
      executed: true,
      cases: [{ valid: true, taskSuccess: true }, { valid: false }],
    })).toBe('executed-partial')
  })
})
