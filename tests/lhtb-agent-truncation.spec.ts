/**
 * A reply cut off at the token cap is a TRUNCATION, not the model declining to act.
 *
 * ## The defect this pins
 *
 * The agent tested emptiness before it tested the finish reason:
 *
 *     if content == "" or content == EMPTY_PLACEHOLDER:   # first
 *         ... nudge: "Your last reply was empty. Continue the task..."
 *     if finish.endswith("max-tokens"):                   # second, unreachable when empty
 *         ... submit a bigger budget
 *
 * So a reply the cap cut off BEFORE it could emit anything was read as silence and
 * answered with a nudge. A nudge cannot fix a budget overrun -- the model re-derives
 * the same reasoning and is cut off in the same place -- so the streak walked to its
 * ceiling: five consecutive `max-tokens` empties ended a `basic` cell at 56 model
 * calls, having spent 1.04M tokens of a four-hour budget.
 *
 * ## Why the test is at the SOURCE level
 *
 * The decision lives inside the agent's turn loop, which needs a live bridge to call.
 * What the defect WAS is the ORDER of two tests, and that is a property of the source
 * rather than of a return value -- the same reason
 * `tests/harness-fold-containment.spec.ts` checks the bridge's guard in its source.
 * The BEHAVIOUR of the rule is pinned separately in
 * `tests/lhtb-watchdog.spec.ts` for the watchdog, and by measurement for the rest.
 *
 * @module tests/lhtb-agent-truncation
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const AGENT = readFileSync(join(ROOT, 'eval', 'lhtb', 'ef_lhtb_agent.py'), 'utf8')
const BRIDGE = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')
const RUNNER = readFileSync(join(ROOT, 'scripts', 'run-lhtb.sh'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'eval', 'bridge', 'ef_bridge_client.py'), 'utf8')

describe('the truncation test must come BEFORE the empty-reply test', () => {
  it('orders the two tests so a cut-off reply cannot be read as silence', () => {
    const truncationAt = AGENT.indexOf('if finish.endswith("max-tokens"):')
    const emptyAt = AGENT.indexOf('if content == "" or content == EMPTY_PLACEHOLDER:')
    expect(truncationAt, 'the truncation branch must exist').toBeGreaterThan(-1)
    expect(emptyAt, 'the empty branch must exist').toBeGreaterThan(-1)
    // This single comparison is the defect. Reversing it restored the five-empty
    // streak that ended a cell.
    expect(
      truncationAt,
      'the cap check must precede the emptiness check, or an empty cut-off is nudged',
    ).toBeLessThan(emptyAt)
  })

  it('counts the two events separately, because their recoveries are opposite', () => {
    expect(AGENT).toContain('truncation_streak += 1')
    expect(AGENT).toContain('MAX_TRUNCATION_STREAK')
    // The empty branch keeps its own ceiling: one ceiling cannot serve both.
    expect(AGENT).toMatch(/if empty_streak >= MAX_EMPTY_STREAK:/u)
    expect(AGENT).toMatch(/if truncation_streak > MAX_TRUNCATION_STREAK:/u)
  })

  it('records which of the two happened, so the mix survives the run', () => {
    expect(AGENT).toContain('"anomaly": "truncated response"')
    expect(AGENT).toContain('"anomaly": "empty response"')
    // And the budget actually used, so an escalation ladder is readable after it.
    expect(AGENT).toContain('"replyBudget": escalated')
  })
})

describe('the recovery is a bigger budget, and it escalates', () => {
  it('doubles the budget per cut-off rather than repeating the same request', () => {
    // Repeating reproduces the constraint that truncated the reply.
    expect(AGENT).toContain('reply_budget = min(')
    expect(AGENT).toContain('current * 2,')
  })

  it('asks the bridge for the escalated budget on the retry', () => {
    expect(AGENT).toContain('reply = self._bridge.step(escalated)')
  })

  it('keeps the escalated budget for EVERY other retry in the episode', () => {
    // A provider-failure retry or an empty nudge must not silently drop back to the
    // budget that was already known to be too small.
    expect(AGENT).toContain('reply = self._bridge.step(reply_budget)')
    expect(AGENT, 'the initial call has no override yet').toContain('reply = self._bridge.step()')
  })

  it('starts from the bridge default instead of a second, drifting constant', () => {
    expect(AGENT).toContain('os.environ.get("EF_BRIDGE_MAX_TOKENS", "32768")')
  })
})

describe('the base reply budget is sized for a reasoning model', () => {
  it('defaults to 32768, matching the summarization budget chosen for the same reason', () => {
    // At 8192 the measured behaviour was that reasoning consumed the whole budget
    // and the reply was EMPTY. A regression here re-creates the five-empty streak.
    expect(RUNNER).toContain('EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-32768}"')
  })
})

describe('the protocol carries a per-call reply budget', () => {
  it('lets a caller override the budget for one step', () => {
    expect(BRIDGE).toContain('maxTokens: maxTokens ?? STEP_MAX_TOKENS')
    expect(BRIDGE).toContain("typeof request.maxTokens === 'number'")
  })

  it('lets the Python client ask for one without restarting the episode', () => {
    expect(CLIENT).toContain('def step(self, max_tokens: Optional[int] = None)')
    expect(CLIENT).toContain('request["maxTokens"] = int(max_tokens)')
  })
})
