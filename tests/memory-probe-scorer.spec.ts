/**
 * Scoring must separate three outcomes that are easy to conflate.
 *
 * ## The three
 *
 *   CORRECT    the letter matches the key
 *   WRONG      the letter was read and does not match
 *   UNPARSED   the letter could not be read at all
 *
 * Scoring UNPARSED as WRONG inflates the apparent loss: a run whose reply format drifted would
 * be reported as a total retention failure rather than as a parse failure, and the two call for
 * opposite responses.
 *
 * ## The fallback that had to be rejected
 *
 * The first fallback was "take the first letter of the line". It reads `Answer 1 is C` as **A**,
 * from the word "Answer", and would have recorded a confident WRONG answer for every line of a
 * prose reply. **A fallback that can produce a wrong answer is worse than no fallback, because it
 * is indistinguishable from a real one.** The loose pass therefore still requires a number and a
 * standalone letter, in that order and close together.
 *
 * ## The floor
 *
 * Every probe carries four real options, so chance is about 0.25 and the report states it. An
 * accuracy of 0.31 read against zero looks like near-total failure; read against the floor it is
 * barely above chance, which is the honest reading (docs/62 threat 6).
 *
 * @module tests/memory-probe-scorer
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MEM = join(ROOT, 'eval', 'memory')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY) && existsSync(join(MEM, 'score_probes.py'))

/** Run the scorer over a reply and return its report. */
function scoreReply(reply: string) {
  execFileSync(PY, [join(MEM, 'score_probes.py')], { input: reply, encoding: 'utf8', timeout: 120000 })
  return JSON.parse(readFileSync(join(MEM, 'last_score.json'), 'utf8'))
}

describe.skipIf(!canRun)('the probe scorer', () => {
  const key = JSON.parse(readFileSync(join(MEM, 'answer_key.json'), 'utf8'))
  const L = 'ABCD'

  it('scores a perfect reply as perfect', () => {
    const reply = key.probes.map((p: { id: number; answer_index: number }) =>
      p.id + ': ' + L[p.answer_index]).join('\n')
    const r = scoreReply(reply)
    expect(r.overall.accuracy).toBe(1)
    expect(r.overall.unparsed).toBe(0)
  })

  it('states the chance floor rather than implying zero', () => {
    const reply = key.probes.map((p: { id: number }) => p.id + ': A').join('\n')
    const r = scoreReply(reply)
    expect(r.overall.chance_floor).toBeCloseTo(0.25, 2)
  })

  it('reports an unreadable reply as UNPARSED, not as wrong', () => {
    const r = scoreReply('I would rather not answer these.')
    expect(r.overall.unparsed).toBe(key.probes.length)
    expect(r.overall.accuracy, 'nothing was scored, so there is no accuracy').toBeNull()
  })

  it('reads a prose reply correctly, and never from the first letter of the line', () => {
    // "Answer 1 is C" must read as C. A first-letter fallback reads the A of "Answer".
    const p = key.probes[0]
    const r = scoreReply('Answer ' + p.id + ' is ' + L[p.answer_index])
    expect(r.overall.correct, 'the loose pass must read the letter, not the word').toBe(1)
  })

  it('pairs binding loss by fact, and reports the discordant counts McNemar needs', () => {
    const reply = key.probes.map((p: { id: number; answer_index: number; kind: string }) =>
      p.id + ': ' + (p.kind === 'disambiguation' ? 'ABCD'[(p.answer_index + 1) % 4] : L[p.answer_index])
    ).join('\n')
    const r = scoreReply(reply)
    expect(r.binding_loss.n_pairs).toBeGreaterThan(0)
    // Extraction right and disambiguation wrong, on the same fact: all discordant one way.
    expect(r.binding_loss.mcnemar_b).toBe(r.binding_loss.n_pairs)
    expect(r.binding_loss.mcnemar_c).toBe(0)
  })
})
