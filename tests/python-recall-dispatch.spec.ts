/**
 * The Python half of the recall chain, EXECUTED rather than grepped.
 *
 * The LHTB lane reaches recall as `model tool-call -> EFLhtbAgent dispatch -> bridge op:"tool" ->
 * ToolRuntime`. Every other test covers one END of that: `harness-recall-tools.spec.ts` calls the
 * runtime directly, and `task-root-bridge.spec.ts` dispatches over the wire. The production agent
 * loop in between -- the branch at `ef_lhtb_agent.py:644-662` that routes a non-shell call to
 * `call_tool` and appends the result -- had never run.
 *
 * `tests/fixtures/python-recall-dispatch.py` runs it: a fake provider scripts the model's calls,
 * the Harbor environment is a stub, and the agent, the bridge client, the Node bridge process, the
 * plugin, the SessionStore, the fold transaction and the ToolRuntime are all real. No API key.
 *
 * The archived evidence is a NONCE carried by a folded TOOL RESULT, not by the task root -- the
 * root is protected and is never folded, so it could not prove anything about the archive.
 *
 * @module tests/python-recall-dispatch
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = process.env.EF_HARBOR_PY
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe'
const DRIVER = join(ROOT, 'tests', 'fixtures', 'python-recall-dispatch.py')
// The agent imports Harbor, so the interpreter is the LHTB virtualenv's. A checkout without it
// SKIPS rather than fails: this is coverage of a host-side integration, not of the repo in
// isolation, and a red suite on a machine that cannot possibly run it would be a false signal.
// `EF_HARBOR_PY` overrides the location.
const canRun = existsSync(PY)

function runDriver(): Record<string, unknown> {
  const out = execFileSync(PY, [DRIVER], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 })
  const line = out.trim().split(/\r?\n/u).filter(text => text.startsWith('{')).pop()
  if (line === undefined) throw new Error(`driver produced no JSON: ${out.slice(-400)}`)
  return JSON.parse(line) as Record<string, unknown>
}

describe.skipIf(!canRun)('the Python EFLhtbAgent recall dispatch', () => {
  const result = canRun ? runDriver() : ({} as Record<string, unknown>)

  it('dispatched BOTH recall tools from the model tool-calls the agent parsed', () => {
    expect(result['toolsDispatched']).toContain('context_search')
    expect(result['toolsDispatched']).toContain('context_recall')
    expect(result['searchCount'] as number).toBeGreaterThan(0)
    expect(result['recallCount'] as number).toBeGreaterThan(0)
  })

  it('executed them on the real ToolRuntime, against a real archived checkpoint', () => {
    expect(result['searchOutputHasRef'], 'the search cited a real checkpoint').toBe(true)
    const refs = result['recallRefs'] as string[]
    expect(refs.some(ref => ref.startsWith('cp:'))).toBe(true)
  })

  it('recovered the ARCHIVED BYTES, nonce and original wording included', () => {
    // Not a fabricated success: the nonce exists only inside the folded tool result.
    expect(result['recallOutputHasNonce']).toBe(true)
    expect(result['recallOutputHasOriginalWording']).toBe(true)
  })

  it('fed the real Tool Results back so the next provider request carried them', () => {
    expect(result['providerSawSearchResult']).toBe(true)
    expect(result['providerSawRecallResult']).toBe(true)
  })

  it('reports a MISS rather than a hit when the reference does not exist', () => {
    const bad = String(result['badRefOutput'])
    expect(bad.length, 'the bad ref was dispatched and answered').toBeGreaterThan(0)
    expect(bad, 'it must not return archived content').not.toContain('zqxnonce77')
  })

  it('leaves the task root registered, in its original role, never folded', () => {
    expect(result['taskRoot']).toMatchObject({ mode: 'exact', status: 'resident', digestVerified: true })
  })
})