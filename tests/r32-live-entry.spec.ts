/**
 * R32-D5: the live-eval ENTRY POINT is inspected, not executed.
 *
 * `--check` must be credential-free and deterministic, and `--run` must refuse
 * to spend provider credits without the explicit `EF_R32_LIVE=1` opt-in. The
 * live result itself is reported as `not executed` in R32_EVALUATION; no
 * scripted 6/6 is presented as model quality.
 *
 * @module tests/r32-live-entry
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'eval', 'r32', 'live-semantic-eval.mjs')

interface CheckReport {
  readonly status: string
  readonly scenarios: readonly { readonly id: string; readonly probe: string }[]
  readonly reportFields: readonly string[]
}

function run(args: readonly string[], env: Record<string, string> = {}): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('R32-D5: live semantic evaluation entry', () => {
  it('validates four scenarios and the recorded report fields without credentials', () => {
    const result = run(['--check'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as CheckReport
    expect(report.status).toBe('interface-ok')
    expect(report.scenarios.map(scenario => scenario.id)).toEqual([
      'unanchored-constraint',
      'negative-knowledge',
      'validation-boundary',
      'cross-phase-dependency',
    ])
    for (const scenario of report.scenarios) expect(scenario.probe.length).toBeGreaterThan(0)
    for (const field of ['provider', 'model', 'writer', 'accepted', 'refused', 'checkpoint', 'probe', 'score']) {
      expect(report.reportFields).toContain(field)
    }
  })

  it('refuses to call a provider unless EF_R32_LIVE=1 is explicit', () => {
    const result = run(['--run'], { EF_R32_LIVE: '' })
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as { status: string; reason: string }
    expect(report.status).toBe('not-executed')
    expect(report.reason).toMatch(/EF_R32_LIVE/u)
  })
})
