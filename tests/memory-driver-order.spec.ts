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

  it('counts COMMITS, and reports the depth REACHED beside the depth ASKED FOR', () => {
    // Three distinct defects, each of which loses the independent variable.
    //
    // compact() returns False when the engine declines, so counting CALLS records a depth the
    // engine never reached. The old design then went further and asked for a TOTAL, topping up
    // the difference, on the stated premise that "the corpus is more than four times the window,
    // so ingestion alone forces folds".
    //
    // Measured, that premise was false: natural folds were 0 in 40 of 40 cells, because append
    // does not call foldIfNeeded -- only a model call does, and ingestion makes none. So the loop
    // always asked for exactly 5, the engine committed 1 and CORRECTLY declined the other 4, and
    // every cell ran at an ACHIEVED depth of 1 while being reported as depth 5. Four of five
    // requests were provably no-ops.
    //
    // The top-up loop is gone. The target is now only a REQUEST, and what the cell reached is
    // recorded separately -- so a table cannot be labelled with a depth the cell never had.
    expect(DRIVER).toMatch(/if ok:\n\s+committed \+= 1/u)
    expect(DRIVER).toContain('declined += 1')
    expect(DRIVER, 'the top-up loop is the defect, not the fix').not.toContain('max(0, depth - natural)')
    expect(DRIVER).toContain('"depth_achieved": folds')
    for (const k of ['depth_target', 'depth_achieved', 'folds_natural', 'folds_requested',
                     'folds_committed', 'folds_declined', 'folds_total']) {
      expect(DRIVER, k + ' must be reported').toContain('"' + k + '"')
    }
  })

  it('drives a FIXED number of folds over a split corpus, in order', () => {
    // The design in one test: the corpus is cut into equal parts, one fold is driven after each,
    // and the count is the design's rather than the engine's.
    //
    // The previous version derived the cadence from a depth target, and depth was never a free
    // axis: 4.2 windows of corpus can only be folded so many ways. A depth-1 cell therefore had
    // to hold 4.2 windows UNFOLDED before its single fold -- 4.21x past the window it was
    // simulating -- and at 252K that made one summarisation request 1,042,985 tokens against a
    // 1,048,576 model context. It did not fail as an error; the provider dropped the socket.
    // Split by cumulative TOKENS, not by document count: documents are not the same size and a
    // part IS a fold's span, so a count-based split gives parts that differ in exactly the
    // quantity being controlled.
    expect(DRIVER).toContain('boundary = sum(weights) / folds_target')
    expect(DRIVER).toContain('running >= boundary * (cursor + 1)')
    expect(DRIVER).toContain('for part_index, part in enumerate(parts):')
    expect(DRIVER).toContain('increment = corpus_tokens_est // folds_target')
    // Folding is switched off BEFORE the first append and re-enabled for exactly one call per
    // fold, so the engine never chooses when to compress.
    const switchOff = DRIVER.indexOf('compaction_on = bridge.set_compaction(False)')
    const firstAppend = DRIVER.indexOf('reply = bridge.append(')
    expect(switchOff, 'folding must be off before the corpus starts arriving').toBeGreaterThan(0)
    expect(switchOff).toBeLessThan(firstAppend)
    expect(DRIVER).toContain('_enabled = bridge.set_compaction(True)')
    expect(DRIVER).toContain('bridge.set_compaction(False)')
    // And a part that produced no fold is recorded as such rather than counted.
    expect(DRIVER).toContain('declined += 1')
  })

  it('gives the regenerable arm a read tool and the compression arms none', () => {
    // The bench's control is regenerable memory, which is a different thing from no compression:
    // the model must be able to reach the documents freely and repeatedly. That needs the fs seam
    // mounted and the model-facing read tool registered -- and it must be mounted for THAT arm
    // only, because a compression arm measured with a read tool is a different arm.
    expect(DRIVER).toContain('bridge.init(SYSTEM_WARNED if warned else SYSTEM_PUSH, [], fs_root=fs_root)')
    expect(DRIVER).toContain('def step_with_tools(')
    expect(DRIVER).toContain('bridge.append({"role": "tool", "id": str(call.get("id") or ""),')
    expect(DRIVER).toContain('if fs_root is not None:')
    // Mode R takes no corpus, and a compression mode cannot take an fs root.
    expect(DRIVER).toContain('ingests_corpus = mode in ("A", "B")')
    expect(DRIVER).toContain('--mode R is the regenerable arm and needs --fs-root')
    expect(DRIVER).toContain('a compression arm measured')
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
    // The arm guard sits before the fold, so C and N cannot be asked to compress a document set
    // that is already minimal -- and depth 0 still ingests, because that cell is the unfolded
    // reference rather than an empty session.
    expect(cellPath('bridge.compact()')).toBeGreaterThan(cellPath('if not ingests_corpus or folds_target <= 0:'))
    expect(DRIVER).toContain('if ingests_corpus and folds_target > 0 and committed < folds_target:')
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

  it('takes the calibration target from the WINDOW, so it is reachable', () => {
    // The first version set the target at 20% of the INGESTED surface. The corpus is 861,697
    // tokens and the window is 131,072, so that target was 172,339 -- 31% ABOVE the window, and
    // unreachable by any mechanism: the surface has to fit the window or the provider refuses
    // the request.
    //
    // 10.6 treats a mechanism that cannot reach the target as a finding ABOUT THE MECHANISM.
    // Every sweep would have reported that, and it would have been a finding about arithmetic.
    expect(DRIVER).toContain('window = int(os.environ.get("EF_MEMORY_WINDOW", "131072"))')
    expect(DRIVER).toContain('target = int(window * target_frac)')
    expect(DRIVER, 'the target must not be derived from the ingested size').not.toMatch(
      /target = int\(ingested \* target_frac\)/u)
    // And the default fraction must leave room for the probe turn and the reply.
    const m = /--target-frac", type=float, default=([0-9.]+)/u.exec(DRIVER)
    expect(m, 'the default fraction must be declared').not.toBeNull()
    const frac = Number(m![1])
    expect(frac).toBeGreaterThan(0)
    expect(frac, 'a target at the window leaves nothing for the probe turn').toBeLessThanOrEqual(0.75)
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
