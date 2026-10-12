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

  it('counts COMMITS, and treats depth as the ACHIEVED TOTAL', () => {
    // Two distinct defects, both of which lose the independent variable.
    //
    // compact() returns False when the engine declines, so counting CALLS records a depth the
    // engine never reached. And the corpus is more than four times the window, so ingestion
    // alone forces folds: requesting "depth 5" on top of those gives a total that depends on
    // the corpus rather than the request, and the request barely moves it.
    expect(DRIVER).toMatch(/if bridge\.compact\(\):\n\s+committed \+= 1/u)
    expect(DRIVER).toContain('natural = int(bridge.last_telemetry.get("folds") or 0)')
    // Only the DIFFERENCE is requested, and the guard is not pinned verbatim: the line also
    // carries the arm check that keeps C and N from being asked to fold a corpus they do not
    // have, so asserting the exact text made this fail the moment that was added.
    expect(DRIVER).toMatch(/for _ in range\(max\(0, depth - natural\)/u)
    // And the three numbers are reported separately, because conflating them is the defect.
    for (const k of ['depth_target', 'folds_natural', 'folds_requested', 'folds_committed', 'folds_total']) {
      expect(DRIVER, k + ' must be reported').toContain('"' + k + '"')
    }
  })

  it('retries a provider failure on the probe turn rather than scoring it as a loss', () => {
    expect(DRIVER).toContain('def step_with_retry(')
    expect(DRIVER).toContain('probe_failures')
    // The retry must be bounded, or a dead endpoint spins forever.
    expect(DRIVER).toMatch(/for attempt in range\(max_attempts\)/u)
  })

  it('retries only errors that could become true, not deterministic ones', () => {
    // A malformed header answered HTTP 400 MissingSessionID on every attempt. The retry loop
    // spent its whole backoff budget on it AND hid the cause: the run reported one provider
    // failure, which read as provider turbulence and was in fact a request that could never
    // succeed. A 4xx that is not 429 describes the REQUEST.
    expect(DRIVER).toContain('def retryable(')
    expect(DRIVER).toContain('if not retryable(str(reply.get("error"))):')
    const body = DRIVER.slice(DRIVER.indexOf('def retryable('), DRIVER.indexOf('def step_with_retry('))
    for (const transient of ['HTTP 429', 'HTTP 503', 'fetch failed']) {
      expect(body, transient + ' must be retryable').toContain(transient)
    }
    expect(body, 'a plain 4xx must NOT be listed as retryable').not.toContain('HTTP 400')
  })

  it('gives a corpus to A and B ONLY, so C is not a copy of B', () => {
    // Section 6.2: C is "a minimal context, plus the same document(s)" and N is "the probe, no
    // corpus". The first version of this driver ingested for EVERY arm, which would have made
    // C identical to B -- so the interference term B - C would be identically ZERO and read as
    // "the retained summary does not interfere", which is a finding, when nothing was
    // measured. A silent zero is worse than a loud failure.
    expect(DRIVER).toContain('ingests_corpus = mode in ("A", "B")')
    expect(DRIVER).toContain('seq = orders[order_name] if ingests_corpus else []')
    // And C still receives the injected documents, which is what makes it the ceiling.
    expect(DRIVER).toContain('if inject:')
    // The flag is reported, so a reader cannot mistake C for B in a result file.
    expect(DRIVER).toContain('"ingests_corpus": ingests_corpus')
  })

  it('asks for no folds from an arm that has no corpus', () => {
    expect(DRIVER).toContain('if ingests_corpus else 0')
    expect(DRIVER).toMatch(/max\(0, depth - natural\) if ingests_corpus else 0/u)
  })

  it('batches the probes by the documents they need, instead of one turn', () => {
    // 5.3's requirement is NO FOLD BETWEEN PROBES, and compaction is off for the whole phase,
    // so one turn is not required. It was also impossible: the union of every probe's needed
    // documents is the whole corpus, 861,703 tokens, so arm B could not inject it.
    expect(DRIVER).toContain('def probe_batches(')
    expect(DRIVER).toContain('for batch in batches:')
    expect(DRIVER).toContain('"probe_batches": len(batches)')
  })

  it('validates that each injection actually CONTAINS the answer', () => {
    // An injection without the answer measures the injection, not the model, and the score
    // looks like a recall failure rather than a missing document.
    expect(DRIVER).toContain('def validate_injection(')
    // The errata belong to an update probe's injection: the corrected value appears nowhere
    // in the project's own documents.
    expect(DRIVER).toContain('g["errata"] = [e for e in (errata or []) if e["project"] in g["needs"]]')
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
