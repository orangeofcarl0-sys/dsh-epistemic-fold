/**
 * R33.1-D2 / R34-A: the live entry's real runtime paths, without a provider.
 *
 * `--self-test` drives the REAL DSH fold host, the REAL semantic writer path
 * (with a scripted adapter), the REAL validator/journal/working-set compile,
 * the REAL hidden checkers, and the REAL follow-up tool loop. It does not call
 * a provider. These tests assert that the four arms actually differ in the way
 * the experiment claims:
 *
 *   B1/O2  no semantic writer, no committed state
 *   S      a writer call, parsed deltas, committed state, raw output captured
 *   O1     the SAME runtime with an oracle proposal, labelled as such
 *
 * They also assert that a valid live manifest with no route environment refuses
 * with `provider-unavailable` instead of guessing a credential.
 *
 * @module tests/r331-live-writer
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = process.cwd()
const OUT = join(ROOT, 'eval', 'r33', 'out')

async function live(args: string[], env: Record<string, string | undefined> = {}) {
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

describe('R33.1/R34 four-arm self-test', () => {
  it('runs B1/S/O1/O2 through the real host and captures writer diagnostics', async () => {
    const result = await live(['--self-test', '--cases', 'A1,C1', '--arms', 'B1,S,O1,O2'])
    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(await readFile(join(OUT, 'self-test-report.json'), 'utf8'))
    expect(report.status).toBe('executed-success')
    expect(report.quality.measurementValid).toBe(true)
    expect(report.rows).toHaveLength(8)
    expect(report.ledger.unresolvedAttempts).toBe(0)
    expect(report.ledger.used.attempts).toBeGreaterThan(0)

    const row = (arm: string, caseId: string) =>
      report.rows.find((entry: any) => entry.arm === arm && entry.caseId === caseId)

    for (const arm of ['B1', 'O2']) {
      for (const caseId of ['A1', 'C1']) {
        const entry = row(arm, caseId)
        expect(entry.valid, `${arm}/${caseId}`).toBe(true)
        expect(entry.writer.applicable).toBe(false)
        expect(entry.state.commits).toBe(0)
      }
    }

    for (const caseId of ['A1', 'C1']) {
      const s = row('S', caseId)
      expect(s.writer.applicable).toBe(true)
      expect(s.writer.oracle).toBe(false)
      expect(s.writer.call).toBe('success')
      expect(s.writer.protocol).toBe('parsed')
      expect(s.writer.accepted).toBeGreaterThan(0)
      expect(typeof s.writer.rawOutput).toBe('string')
      expect(s.writer.rawOutputChars).toBeGreaterThan(0)
      expect(s.state.commits).toBe(1)
      expect(s.state.anchors.length).toBeGreaterThan(0)
      expect(s.state.stateDigest).toMatch(/^[0-9a-f]{16}/u)

      const o1 = row('O1', caseId)
      expect(o1.writer.applicable).toBe(true)
      expect(o1.writer.oracle).toBe(true)
      // S runs before O1, so the oracle replaces only S's DELTAS and keeps its
      // handoff. The basis is recorded so this is a conditional oracle, not an
      // independent model arm.
      expect(o1.writer.oracleBasis).toBe('s-conditional')
      expect(o1.writer.accepted).toBeGreaterThan(0)
      expect(o1.state.commits).toBe(1)
      // O1 must go through the real journal and working-set compile, not a
      // second text-injection channel.
      expect(o1.state.anchors.length).toBeGreaterThan(0)
    }

    for (const entry of report.rows) {
      expect(entry.checker.status, `${entry.arm}/${entry.caseId} checker`).toBe('executed')
      expect(entry.behaviour.taskSuccess, `${entry.arm}/${entry.caseId} task`).toBe(true)
      expect(entry.sourceBindings.length).toBeGreaterThan(0)
      for (const binding of entry.sourceBindings) {
        for (const ref of binding.refs) {
          expect(Number.isInteger(ref.eventSeq)).toBe(true)
        }
      }
    }
  }, 180_000)

  it('refuses a valid manifest when the route environment is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r331-live-route-'))
    const manifest = join(directory, 'manifest.json')
    await writeFile(manifest, JSON.stringify({
      model: 'unconfigured-model',
      maxOutputTokens: 1024,
      limits: { requests: 10, inputTokens: 100_000, outputTokens: 10_000, wallClockMs: 60_000 },
      route: { baseUrlEnv: 'R331_UNSET_BASE_URL', apiKeyEnv: 'R331_UNSET_API_KEY' },
    }), 'utf8')
    const result = await live(['--run', '--manifest', manifest], {
      R33_LIVE: '1',
      R331_UNSET_BASE_URL: undefined,
      R331_UNSET_API_KEY: undefined,
    })
    expect(result.code).toBe(5)
    const report = JSON.parse(await readFile(join(OUT, 'live-report.json'), 'utf8'))
    expect(report.status).toBe('provider-unavailable')
    expect(report.reason).toContain('route environment variables')
    expect(report.note).toContain('No provider request')
  }, 180_000)
})
