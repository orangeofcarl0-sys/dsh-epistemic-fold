/**
 * An empty reply is TWO failures, and the retry used to answer both with one instrument.
 *
 * It is the kind of defect that hides inside a plausible number: the recovery it chose (a bigger
 * budget) is correct for a truncation and useless for silence, so the cell still came back with
 * an `unparsed` count and read as a retention failure. Measured 2026-10-20 at 475K on the basic
 * arm: three of five cells returned 204/204 unparsed after six DOUBLED budgets per batch.
 *
 * @module tests/memory-empty-reply
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY)

const SCRIPT = [
  "import json, sys",
  "sys.path.insert(0, 'eval/memory')",
  "import run_cell as rc",
  "cases = {",
  "  'text':            ({'content': '1: A'}, 'stop'),",
  "  'empty_stop':      ({'content': ''}, 'stop'),",
  "  'empty_none':      ({'content': None}, 'stop'),",
  "  'empty_maxtokens': ({'content': ''}, 'max-tokens'),",
  "  'empty_prefixed':  ({'content': '  '}, 'length-max-tokens'),",
  "  'tool_calls':      ({'content': None, 'tool_calls': [{'id': 'x', 'name': 'read', 'arguments': '{}'}]}, 'stop'),",
  "  'error':           ({'error': 'HTTP 503', 'content': None}, 'stop'),",
  "}",
  "out = {k: rc.empty_kind(r, f) for k, (r, f) in cases.items()}",
  "print(json.dumps(out))",
].join('\n')

describe.skipIf(!canRun)('an empty reply is classified, not guessed', () => {
  const run = () => JSON.parse(execFileSync(PY, ['-c', SCRIPT], { encoding: 'utf8', timeout: 120000, cwd: ROOT }))

  it('separates a cap from a completed-but-empty response', () => {
    const r = run()
    // A cap is a cap: more ROOM is the only recovery.
    expect(r.empty_maxtokens).toBe('truncated')
    // The finish reason is matched by SUFFIX, because providers prefix it differently
    // ('max-tokens' vs 'length-max-tokens') and an equality test would miss one.
    expect(r.empty_prefixed).toBe('truncated')
    // Completed with nothing: no cap was hit, so a bigger budget is the wrong instrument.
    expect(r.empty_stop).toBe('silent')
    expect(r.empty_none).toBe('silent')
  })

  it('is not fooled by the three shapes that LOOK empty', () => {
    const r = run()
    // Content means content.
    expect(r.text).toBeNull()
    // ## A tool call is a request to act, not an empty reply
    //
    // The regenerable arm's replies carry `content: null` by design when the model reads
    // something. Classifying that as truncation answered the calls never, doubled the budget
    // uselessly, and left the provider rejecting the history: 20 rounds of "unanswered
    // tool_call(s) filled", cell scored 0, 202 unparsed.
    expect(r.tool_calls).toBeNull()
    // An error is already handled as a provider failure and must not be double-counted here.
    expect(r.error).toBeNull()
  })
})