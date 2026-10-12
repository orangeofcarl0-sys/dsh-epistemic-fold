/**
 * A turn must be OPEN whenever the model is called, and nothing checked it.
 *
 * ## The defect this pins
 *
 * `bridge-host.ts` hand-rolls the turn lifecycle, because it drives a plugin
 * directly instead of running the production agent loop. Two of its paths
 * disagreed about what "the turn" meant:
 *
 *  - the provider-failure path closed the empty turn and set
 *    `turnHasContent = false` ("an empty turn is legal; an unclosed one is not");
 *  - `rotateTurn` opened the next turn ONLY inside `if (turnHasContent)`.
 *
 * So a step that followed a provider failure ran with NO open turn. Automatic
 * compaction refuses exactly that state -- `compactRegion: no open turn --
 * automatic compaction events must be enclosed in a turn` -- and it is right to:
 * `src/basic/region.ts` is vendored byte-for-byte from
 * `@deepseek-ai/dsh-compaction-basic`, guarded by
 * `tests/rc7-vendored-basic.spec.ts`, and the official `lib/index.js` carries the
 * identical throw.
 *
 * Production never reaches the state because Basic's `compactIfNeeded` runs on
 * `agent/pre-step`, inside a turn the agent loop owns. This host is the only
 * place that could lose one.
 *
 * ## Why only the basic arm showed it
 *
 * `drainIdleRebase` closes and reopens the turn on every model call, which
 * incidentally repaired the invariant -- but it returns early for `mode: basic`
 * ("keeps the Basic arm's event log identical to a deployment where EF is not
 * installed"), and it runs AFTER `foldIfNeeded`, so it could not have repaired
 * the call that needed it anyway.
 *
 * Measured across seven cells: every `basic` cell reported double-digit
 * compaction failures (unknown-config 21/33, riscv 26/41 and 26/45, commit0
 * 13/36) and every EF arm reported 0.
 *
 * ## What this test does and does not prove
 *
 * It reads the source as text, like `tau2-bridge-contract.spec.ts`, and pins the
 * STRUCTURE that makes the state unreachable. It is not a behavioural proof: the
 * behavioural evidence is a `basic` cell reporting `compactionFailures: 0` on a
 * real run. Until that exists, treat the fix as unit-verified only.
 *
 * @module tests/tau2-turn-invariant
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const HOST = 'eval/tau2/bridge-host.ts'

/** The host source, split into lines, keeping 1-based numbers. */
function lines(): string[] {
  return readFileSync(join(ROOT, HOST), 'utf8').split(/\r?\n/u)
}

/** The body of a top-level `function name(...)`, by brace matching. */
function bodyOf(name: string): string[] {
  const all = lines()
  // Some of these are async; both forms must match or the helper silently
  // reports the function as missing.
  const start = all.findIndex(line => new RegExp('^(?:async )?function ' + name + '\\(').test(line))
  expect(start, name + ' is no longer a top-level function in ' + HOST).toBeGreaterThan(-1)
  const out: string[] = []
  let depth = 0
  for (let i = start; i < all.length; i += 1) {
    const text = all[i]!
    out.push(text)
    depth += (text.match(/\{/gu) ?? []).length
    depth -= (text.match(/\}/gu) ?? []).length
    if (depth === 0 && i > start) break
  }
  return out
}

describe('the harness turn invariant', () => {
  it('declares an explicit open/closed flag, separate from has-content', () => {
    expect(lines().some(line => /^let turnOpen = false$/.test(line)),
      'turnOpen must exist: turnHasContent answers may-I-close, not is-one-open').toBe(true)
  })

  it('opens a turn whenever none is open, not only when the last had content', () => {
    const body = bodyOf('rotateTurn').join('\n')
    // The recovery must not sit inside the `if (turnHasContent)` branch: that is
    // precisely the branch a provider failure makes false.
    expect(/if \(!turnOpen\) openTurn\(\)/u.test(body),
      'rotateTurn must restore an open turn independently of turnHasContent').toBe(true)
    // And it must not open unconditionally, or the first step double-opens the
    // turn that init already opened.
    expect(/if \(turnHasContent\) closeTurn\(\)/u.test(body)).toBe(true)
  })

  it('records the open state in openTurn and clears it in closeTurn', () => {
    expect(bodyOf('openTurn').join('\n')).toMatch(/turnOpen = true/u)
    const close = bodyOf('closeTurn').join('\n')
    expect(close, 'closeTurn must be guarded so it cannot emit an unbalanced turn/end')
      .toMatch(/if \(!turnOpen\) return/u)
    expect(close).toMatch(/turnOpen = false/u)
  })

  it('has drainIdleRebase ask whether a turn is open, not whether it has content', () => {
    const body = bodyOf('drainIdleRebase').join('\n')
    expect(body).toMatch(/const wasOpen = turnOpen/u)
    expect(body, 'using turnHasContent here is the conflation that caused the defect')
      .not.toMatch(/const wasOpen = turnHasContent/u)
  })

  it('resets the flag with the rest of the per-episode state', () => {
    const all = lines()
    const i = all.findIndex(line => /^  turnCounter = 0$/.test(line))
    expect(i).toBeGreaterThan(-1)
    expect(all.slice(i, i + 8).join('\n')).toMatch(/turnOpen = false/u)
  })
})
