/**
 * Gate B: the PRODUCTION Python agent terminating on a spent budget.
 *
 * `tests/fixtures/python-budget-termination.py` drives the real `EFLhtbAgent.run()` against a real
 * Node bridge, a real budget gate (`REQUIRED=1`, `REQUESTS=1`) and a local fake provider. The
 * fetch count is the evidence; a test of the error object alone would prove nothing.
 *
 * ## The defect this locks down
 *
 * The bridge reports a budget stop with its own finish reason AND an `error` string, and the agent's
 * provider-failure branch caught it first. Measured before the fix: `providerCalls` correctly stayed
 * at 1, but the episode ran **126 turns** and recorded **125 provider failures**, retrying against a
 * gate that refused every request, and never set a termination at all.
 *
 * @module tests/python-budget-termination
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = process.env.EF_HARBOR_PY
  ?? 'D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe'
const DRIVER = join(ROOT, 'tests', 'fixtures', 'python-budget-termination.py')
const canRun = existsSync(PY)

describe.skipIf(!canRun)('a spent budget terminates the Python agent', () => {
  const out = canRun
    ? execFileSync(PY, [DRIVER], { encoding: 'utf8', cwd: ROOT, timeout: 180_000 })
    : ''
  const line = out.trim().split(/\r?\n/u).filter(text => text.startsWith('{')).pop()
  const result = (line === undefined ? {} : JSON.parse(line)) as Record<string, unknown>

  it('sent exactly the one request the budget allowed, and no more', () => {
    expect(result['timedOut'], 'the run terminated rather than hanging').toBe(false)
    expect(result['providerCalls'], 'the fake provider saw one request').toBe(1)
    expect(result['budgetRequests']).toBe(1)
    expect(result['budgetRefusals'], 'and refused exactly the next one').toBe(1)
  })

  it('terminates as budget-exhausted, NOT as a provider failure or a completion', () => {
    expect(result['termination']).toBe('budget-exhausted')
    expect(result['providerFailures'], 'a spent budget is not infrastructure').toBe(0)
    expect(result['lastFinishReason']).toBe('budget-exhausted')
    expect(result['turns'], 'and the retry storm is gone').toBe(1)
  })

  it('appends no fabricated assistant turn and leaves the task root intact', () => {
    expect(result['lastTurn']).toMatchObject({ turn: 1, tool: 'run_shell' })
    expect(result['taskRoot']).toMatchObject({
      mode: 'exact', status: 'resident', digestVerified: true,
    })
  })

  it('closes and reaps the bridge', () => {
    expect(result['bridgeClosed']).toBe(true)
    expect(result['bridgeReaped']).toBe(true)
  })
})