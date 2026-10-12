/**
 * The driver's SEQUENCE is the design; the order of its statements is load-bearing.
 *
 * `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` section 10.5 fixes a sequence in which every step
 * constrains the next. Two of those constraints are invisible in the code's output and would
 * only show up as a measurement that is quietly wrong:
 *
 *   INJECTION MUST FOLLOW COMPACTION. Injecting first adds tokens, tokens can trigger a fold,
 *   and the fold then compresses the very document just injected -- so arm B would be measured
 *   on a state the injection itself changed.
 *
 *   COMPACTION MUST BE OFF BEFORE THE PROBE TURN. The probe measures a state, so a fold landing
 *   before it measures the state after a compression nobody asked for.
 *
 * Neither is a style question, and neither is detectable from a result file. This test reads the
 * sequence and asserts the two orderings hold, which is the only cheap way to keep them.
 *
 * @module tests/memory-driver-order
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const DRIVER = readFileSync(join(ROOT, 'eval', 'memory', 'run_cell.py'), 'utf8')

/** Position of a marker in the cell path, which is the only region the ordering applies to. */
const cellPath = (marker: string) => {
  const start = DRIVER.indexOf('def run_cell(')
  const end = DRIVER.indexOf('def main()')
  const at = DRIVER.indexOf(marker, start)
  expect(at, marker + ' must appear in run_cell').toBeGreaterThan(0)
  expect(at, marker + ' must be inside run_cell').toBeLessThan(end)
  return at
}

describe('the memory driver sequence', () => {
  it('ingests every document before folding', () => {
    expect(cellPath('bridge.append')).toBeLessThan(cellPath('bridge.compact()'))
  })

  it('injects AFTER compaction, so the injection cannot be folded', () => {
    expect(cellPath('if inject:')).toBeGreaterThan(cellPath('bridge.compact()'))
  })

  it('disables compaction BEFORE the probe turn, so the probe measures a state', () => {
    expect(cellPath('set_compaction(False)')).toBeLessThan(cellPath('step_with_retry(bridge)'))
  })

  it('initialises with NO tools, which is what makes the paradigm push', () => {
    expect(DRIVER).toContain('bridge.init(SYSTEM_PUSH, [])')
  })

  it('counts COMMITS as depth, not calls', () => {
    // compact() returns False when the engine declines, and counting calls would record a
    // depth the engine never reached.
    expect(DRIVER).toMatch(/if bridge\.compact\(\):\n\s+folds \+= 1/u)
  })

  it('retries a provider failure on the probe turn rather than scoring it as a loss', () => {
    expect(DRIVER).toContain('def step_with_retry(')
    expect(DRIVER).toContain('probe_failures')
    // The retry must be bounded, or a dead endpoint spins forever.
    expect(DRIVER).toMatch(/for attempt in range\(max_attempts\)/u)
  })

  it('keeps the system prompt minimal, because an instruction to summarise changes the IV', () => {
    const start = DRIVER.indexOf('SYSTEM_PUSH = (')
    const end = DRIVER.indexOf(')', start)
    const prompt = DRIVER.slice(start, end)
    for (const banned of ['concise', 'summar', 'brief', 'short']) {
      expect(prompt.toLowerCase(), 'the prompt must not instruct concision').not.toContain(banned)
    }
  })
})
