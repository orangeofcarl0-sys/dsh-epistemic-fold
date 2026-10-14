/**
 * A read-only PREPARED snapshot of the configuration a Live run would freeze.
 *
 * ## PREPARED, and NOT a live record
 *
 * This is a dry run. It says what COULD be frozen, not what WAS: the Live run must recompute every
 * field at launch, because the commit, the dirty set and the effective YAML can all move between
 * now and then. Presenting this as run provenance would be a fabricated record.
 *
 * No credential, header VALUE or task text is captured -- only names.
 *
 * @module tests/p1-provenance-prepared
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTPUT_RESERVE, budgetLimitsFromEnv } from '../eval/live/request-budget.ts'

const ROOT = join(import.meta.dirname, '..')
const LHTB_ROOT = process.env.LHTB_ROOT
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb'

function git(args: string[], cwd = ROOT): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return 'UNAVAILABLE'
  }
}

function sha256(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 32)
  } catch {
    return 'UNAVAILABLE'
  }
}

/** The P1 budget, exactly as the brief authorizes it. */
const P1 = {
  EF_LHTB_BUDGET_REQUIRED: '1',
  EF_LHTB_BUDGET_REQUESTS: '140',
  EF_LHTB_BUDGET_PROMPT_TOKENS: '7000000',
  EF_LHTB_BUDGET_OUTPUT_TOKENS: '100000',
  EF_LHTB_BUDGET_WALL_MS: '5400000',
}

describe('a PREPARED provenance snapshot can be produced, read-only', () => {
  it('collects every field the launch freeze needs, and no secret', () => {
    const dirty = git(['status', '--porcelain']).split(/\r?\n/u).filter(Boolean)
    const diff = git(['diff'])
    const snapshot = {
      label: 'PREPARED / NOT A LIVE RUN',
      efSha: git(['rev-parse', 'HEAD']),
      lhtbSha: git(['rev-parse', 'HEAD'], LHTB_ROOT),
      dshSession: JSON.parse(readFileSync(join(ROOT, 'node_modules/@deepseek-ai/dsh-session/package.json'), 'utf8')).version as string,
      dirtyFiles: dirty.length,
      dirtyDiffHash: createHash('sha256').update(diff).digest('hex').slice(0, 32),
      probeYamlHash: sha256(join(ROOT, 'eval/lhtb/lhtb-ef-probe.yaml')),
      model: 'deepseek-v4.1-flash',
      route: 'https://opencode.ai/zen/go/v1',
      headerNames: ['x-opencode-session'],
      engine: 'economy',
      taskRootMode: 'exact',
      contextWindow: 131_072,
      threshold: 65_536,
      budget: budgetLimitsFromEnv(P1),
      reserves: { input: 131_072, output: DEFAULT_OUTPUT_RESERVE },
    }
    expect(snapshot.efSha).toMatch(/^[0-9a-f]{40}$/u)
    expect(snapshot.dshSession).toMatch(/^\d/u)
    expect(snapshot.budget).toEqual({
      requests: 140, promptTokens: 7_000_000, outputTokens: 100_000, wallClockMs: 5_400_000,
    })
    // The two reserves the cost bound rests on, asserted rather than described.
    expect(snapshot.reserves).toEqual({ input: 131_072, output: 131_072 })
    // Redacted by construction: only names, never values.
    expect(JSON.stringify(snapshot)).not.toMatch(/sk-|Bearer|OPENCODE_GO_API_KEY/u)
    // eslint-disable-next-line no-console -- the snapshot IS the deliverable
    console.log(`PREPARED ${JSON.stringify(snapshot)}`)
  })

  it('refuses to prepare when any required budget variable is missing, invalid or zero', () => {
    // The launch gate, exercised rather than asserted from source text.
    expect(() => budgetLimitsFromEnv({ EF_LHTB_BUDGET_REQUIRED: '1' })).toThrow(/disabled/u)
    expect(() => budgetLimitsFromEnv({ ...P1, EF_LHTB_BUDGET_REQUESTS: '0' })).toThrow(/disabled/u)
    expect(() => budgetLimitsFromEnv({ ...P1, EF_LHTB_BUDGET_REQUESTS: '' })).toThrow(/empty/u)
    expect(() => budgetLimitsFromEnv({ ...P1, EF_LHTB_BUDGET_REQUESTS: 'lots' })).toThrow(/non-negative/u)
    expect(() => budgetLimitsFromEnv({ ...P1, EF_LHTB_BUDGET_WALL_MS: '-1' })).toThrow(/non-negative/u)
    expect(budgetLimitsFromEnv(P1).requests).toBe(140)
  })
})