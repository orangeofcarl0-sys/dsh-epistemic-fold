/**
 * The Python seam has no test, and three defects have now crossed it.
 *
 * ## Why this exists
 *
 * The interaction and long-work lanes are Python; this repository's suite is
 * TypeScript, so nothing checked the boundary between them. That boundary
 * failed three times, each silently:
 *
 *  1. The tau2 adapter called `self.bridge.turn(message)` after RC10 replaced the
 *     typed bridge protocol with `turn_raw`/`append`/`step`. `turn` was never
 *     defined on `EpistemicFoldBridge` in any commit, so the lane died on the
 *     first turn of every episode — from a clean checkout, that is, which is not
 *     how it was being run.
 *  2. `init` JSON-encodes its second argument, and tau2 hands over pydantic
 *     `Tool` objects. Passing `self.tools` through was one serialisation away
 *     from killing every cell at step 0.
 *  3. The wrapper never passed `--out`, which the runner accepted all along, so
 *     a 96-cell sweep left no machine-readable record.
 *
 * A call to a method the callee does not define, and an option the caller
 * declares but never passes, are both statically visible. These assertions read
 * the source as text and compare the two sides, which is enough to catch the
 * class of defect without a Python runtime in CI.
 *
 * @module tests/tau2-bridge-contract
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** Source lines with whole-line comments dropped, keeping 1-based numbers. */
function code(relative: string): { line: number; text: string }[] {
  return read(relative)
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(entry => !entry.text.trimStart().startsWith('#'))
}

/** Every method `EpistemicFoldBridge` defines, read from its class body. */
function bridgeMethods(): ReadonlySet<string> {
  const lines = code('eval/bridge/ef_bridge_client.py')
  const start = lines.findIndex(entry => /^class EpistemicFoldBridge\b/u.test(entry.text))
  expect(start, 'EpistemicFoldBridge is no longer defined in ef_bridge_client.py').toBeGreaterThan(-1)
  const names = new Set<string>()
  for (const entry of lines.slice(start + 1)) {
    // The first line at column 0 after the class ends its body.
    if (/^\S/u.test(entry.text)) break
    const match = /^\s+def (\w+)\(/u.exec(entry.text)
    if (match !== null) names.add(match[1]!)
  }
  return names
}

const METHODS = bridgeMethods()

describe('the Python bridge seam', () => {
  it('defines every method the tau2 and LHTB agents call on it', () => {
    const call = /\b_?bridge\.(\w+)\(/gu
    const callers = ['eval/tau2/ef_tau2_adapter.py', 'eval/lhtb/ef_lhtb_agent.py']
    const checked: string[] = []
    for (const path of callers) {
      for (const entry of code(path)) {
        for (const match of entry.text.matchAll(call)) {
          checked.push(match[1]!)
          expect(
            METHODS.has(match[1]!),
            `${path}:${entry.line} calls bridge.${match[1]}() and EpistemicFoldBridge defines no such method `
              + `(it defines: ${[...METHODS].sort().join(', ')})`,
          ).toBe(true)
        }
      }
    }
    // Guard the guard: a regex that matched nothing would pass vacuously.
    expect(checked.length, 'no bridge method calls were found to check').toBeGreaterThan(2)
  })

  it('projects tau2 tools onto the wire shape before init', () => {
    const initCalls = code('eval/tau2/ef_tau2_adapter.py').filter(entry => /\.init\(/u.test(entry.text))
    expect(initCalls.length, 'expected exactly one bridge.init call in the tau2 adapter').toBe(1)
    expect(
      initCalls[0]!.text,
      'init JSON-encodes its arguments, so tau2 pydantic Tool objects must be projected first',
    ).toContain('_tool_schemas(')
  })

  it('keeps the premature-stop column informative', () => {
    const runner = read('eval/tau2/run_tau2.py')
    expect(runner, 'termination reasons must be normalised before classification').toMatch(/def _termination_kind\(/u)
    expect(runner, 'prefer the enum value: str(TerminationReason.USER_STOP) is the qualified name').toMatch(
      /getattr\(reason, "value", reason\)/u,
    )
    expect(runner, 'the raw qualified-name comparison never matched, so it must not come back').not.toMatch(
      /c\.termination not in \(/u,
    )
    expect(runner).toMatch(/_termination_kind\(c\.termination\)/u)
  })
})

describe('the tau2 launch seam', () => {
  it('passes --out, so a run leaves a record instead of only a log', () => {
    expect(read('eval/tau2/run_tau2.py')).toMatch(/add_argument\("--out"/u)
    const execLine = code('scripts/run-tau2.sh').find(entry => /run_tau2\.py/u.test(entry.text))
    expect(execLine, 'the wrapper no longer invokes run_tau2.py').toBeDefined()
    expect(execLine!.text, 'the wrapper must pass --out; the runner accepts it but does not default it').toContain('--out')
  })

  it('sets a NO_PROXY an HTTP client can parse', () => {
    const assignments = code('scripts/run-tau2.sh').filter(entry => /^export (NO_PROXY|no_proxy)=/u.test(entry.text.trim()))
    expect(assignments.length, 'both spellings must be set, since Windows may carry either').toBeGreaterThanOrEqual(2)
    for (const entry of assignments) {
      // A bracketed IPv6 literal reads as a port to httpx: Invalid port: ':1]'.
      expect(entry.text, `${entry.text.trim()} carries a bracket httpx reads as a port`).not.toContain(']')
      expect(entry.text).not.toContain('[')
    }
  })
})
