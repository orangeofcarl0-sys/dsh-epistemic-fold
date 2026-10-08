/**
 * A fold that cannot reach the threshold must not be retried — and the harness
 * must mount the mechanism production uses to make that state rare.
 *
 * ## The defect this exists for
 *
 * The Phase 7 two-pass run reported the same failure twice, reproducibly:
 *
 *     still above threshold after 2 leaf fold attempts (68023 ... frozen prefix 180)
 *     still above threshold after 2 leaf fold attempts (53447 ... frozen prefix  40)
 *
 * PR #3 read that as "the summary succeeded, twice, and the foldable prefix was
 * 180 and 40 tokens". Three things were wrong with the reading, and each one is
 * pinned separately below.
 *
 * ## 1. The foldable content was not 180 tokens
 *
 * `frozenTokens` is the token cost of the frozen EF CHECKPOINTS — the part a leaf
 * cannot touch. The report treated it as the foldable prefix, which inverted the
 * meaning: the open content in those runs was ~53-68K. There was plenty to fold;
 * the selector would not take it.
 *
 * ## 2. Neither a leaf NOR a rebase could have folded it
 *
 * Both `selectLeafSpan` and `selectCompactableRange` walk the surface from the
 * tail and `break` as soon as `retainTokens` is met. At `retainTokens = 0` that
 * break fires on the FIRST iteration, so the last node is retained at every
 * setting — and a single node larger than the threshold is un-foldable by
 * construction. This is why "escalate to Root" cannot be the fix, and the test
 * below measures it rather than asserting it.
 *
 * ## 3. "2 leaf fold attempts" was a CONSTANT
 *
 * The message printed `spec.compactionRetries + 1`. The loop can also `break` on
 * a null span, so it claimed two attempts after one committed fold, and a reader
 * could not tell how much work was done. The count is now real.
 *
 * ## 4. And the harness omitted a service production mounts
 *
 * `dsh-base` mounts `@deepseek-ai/dsh-compaction-tool-result-pruner`, and EF's
 * pressure path already reads it. The harness mounted nothing, so the prune step
 * never ran. That pruner is the ONE mechanism that can shrink a single oversized
 * node — which is exactly the LHTB shape, because the oversized node is shell
 * output. Measured on a 66K surface whose last node was a 60K tool result:
 *
 *     without the pruner   after=60136  leaves=1  still over threshold
 *     with the pruner      after=7406   leaves=0  converged
 *
 * So `pressure-unresolved` was, at least in part, a property of the harness.
 *
 * @module tests/fold-reachability
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { createHarness, SIGNAL } from './harness.ts'
import { selectLeafSpan } from '../src/leaf-policy.ts'
import { selectCompactableRange } from '../src/basic/region.ts'
import { assessFoldReachability } from '../src/fold-economics.ts'

const ROOT = join(import.meta.dirname, '..')
const MODEL = 'test-model'

/**
 * The LHTB shape: six closed turns of ordinary history, then ONE open turn whose
 * tool result is far larger than the fold threshold.
 *
 * The single oversized node is the point. A tail made of many medium nodes is
 * foldable (retention stops partway and the span takes the rest); one node bigger
 * than the threshold is not, because the walk can never step past it.
 */
function lhtbShape(toolResultChars: number): Session {
  const session = Session.create(SessionId(`reach-${toolResultChars}-${Math.random()}`))
  const callId = ToolCallId('big-read')
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  for (let turn = 1; turn <= 6; turn += 1) {
    if (turn > 1) session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'u'.repeat(2_000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a'.repeat(2_000) }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // The open turn, left open so automatic compaction is admissible.
  session.append('turn/start', { turn: 7 })
  session.append('step/start', { turn: 7, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 7,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'run_shell', arguments: '{}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 7, step: 1, callId, name: 'run_shell', arguments: '{}' })
  session.append('tool/result', {
    turn: 7,
    step: 1,
    message: createToolResultMessage({
      callId,
      isError: false,
      content: [{ type: 'text', text: 'X'.repeat(toolResultChars) }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 7, step: 1 })
  return session
}

const EF_CONFIG = {
  auto: true,
  thresholdRatio: 0.5,
  headroomTokens: 0,
  maxTokens: 8_192,
} as const

/** One `compactIfNeeded` against the LHTB shape, with or without the pruner. */
async function drive(options: { readonly pruner: boolean }): Promise<{
  before: number
  after: number
  leaves: number
  outcome: string
  reach: ReturnType<typeof assessFoldReachability> | undefined
}> {
  const { engine, ctx } = await createHarness({ text: 'digest' }, {
    contextWindow: 32_000,
    ...(options.pruner ? { pruner: true } : {}),
    efConfig: EF_CONFIG,
  })
  const session = lhtbShape(240_000)
  const agent = {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
  } as never
  const before = ctx.tokenMeter.measure(session).totalTokens
  let outcome: string
  try {
    const result = await (engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded(agent, 'pressure', SIGNAL)
    outcome = result === null ? 'returned null' : 'returned a result'
  } catch (error) {
    outcome = `THREW ${String((error as { code?: string }).code)}`
  }
  return {
    before,
    after: ctx.tokenMeter.measure(session).totalTokens,
    leaves: engine.leafFoldCount,
    outcome,
    reach: engine.lastFoldReachability,
  }
}

describe('a fold that cannot reach the threshold is refused, not retried', () => {
  it('does not throw, and does not spend a second summarization call', async () => {
    // Before: the loop folded, failed to reach, folded again, and threw
    // `still above threshold after 2 leaf fold attempts`. The retry was futile —
    // the surface is a fixpoint of this action — and the throw made a
    // recoverable state look fatal.
    const run = await drive({ pruner: false })
    expect(run.outcome, 'a non-converging surface must not be fatal').not.toMatch(/THREW/u)
    expect(run.leaves, 'exactly one fold is legitimate; the retry is not').toBe(1)
    expect(run.reach?.canReachThreshold, 'and the engine must have recorded why it stopped').toBe(false)
  })

  it('records the arithmetic, so the state is readable instead of inferred', async () => {
    // The old message named only `frozenTokens`, which is what let Phase 7 read
    // 180 as "the foldable prefix". The reading must now carry the terms that
    // actually decide it: the widest span, the checkpoint, the retained remainder.
    const run = await drive({ pruner: false })
    const reach = run.reach
    expect(reach, 'reachability must be recorded').toBeDefined()
    expect(reach!.totalTokens).toBeGreaterThan(reach!.thresholdTokens)
    expect(reach!.frozenCount, 'the checkpoint count must be present, not just its size').toBeGreaterThan(0)
    expect(reach!.retainedTokens, 'the remainder is what decides the verdict').toBeGreaterThanOrEqual(
      reach!.thresholdTokens,
    )
    expect(reach!.reason).toBe('no_legal_span')
  })

  it('a leaf and a rebase fold the SAME span, which is why escalation cannot help', async () => {
    // This is the load-bearing measurement behind "do not escalate to Root". Both
    // selectors break out of the retention walk on the first iteration at retain
    // 0, so the oversized last node is retained either way.
    const h = await createHarness({ text: 'digest' }, {
      contextWindow: 32_000,
      efConfig: EF_CONFIG,
    })
    const session = lhtbShape(240_000)
    const measurement = h.ctx.tokenMeter.measure(session)
    const nodes = measurement.nodes
    const sum = (startIdx: number, endIdx: number): number =>
      nodes.slice(startIdx, endIdx + 1).reduce((total, node) => total + node.tokens, 0)

    const leaf = selectLeafSpan(session, measurement, 5_120)
    const rebase = selectCompactableRange(session, measurement, 0)
    expect(leaf, 'a leaf span exists — the surface is not empty').not.toBeNull()
    expect(rebase, 'and so does a rebase range').not.toBeNull()

    const leafTokens = sum(leaf!.startIdx, leaf!.endIdx)
    const rebaseTokens = sum(
      nodes.findIndex(node => node.seq === rebase!.start),
      nodes.findIndex(node => node.seq === rebase!.end),
    )
    // Retain 0 is the MOST generous rebase, and it still cannot reach the last
    // node. So a rebase can never fold more than a leaf can here.
    expect(rebaseTokens, 'the rebase takes no more than the leaf').toBeLessThanOrEqual(leafTokens)
    expect(
      measurement.totalTokens - rebaseTokens,
      'and the remainder stays over the threshold',
    ).toBeGreaterThan(16_000)
  })
})

describe('the harness mounts the pruner production mounts', () => {
  it('the pruner is what makes the LHTB shape converge', async () => {
    // The fidelity fix. LHTB's oversized node is a `tool/result` — shell output —
    // which is precisely what the pruner targets. Without it the harness measured
    // a configuration that cannot ship, and the resulting `pressure-unresolved`
    // was a property of the harness rather than of EF.
    const withPruner = await drive({ pruner: true })
    const without = await drive({ pruner: false })

    expect(withPruner.outcome).not.toMatch(/THREW/u)
    expect(
      withPruner.after,
      'with the pruner the surface must fit, and without it must not — '
      + 'if these ever agree, the pruner has stopped being the mechanism under test',
    ).toBeLessThan(without.after)
    expect(withPruner.after, 'and it must come under the threshold').toBeLessThan(16_000)
    expect(without.after, 'while the un-pruned surface does not').toBeGreaterThan(16_000)
  })

  it('the pruner converges by pruning, not by folding more', async () => {
    // If it converged by folding, the fix would be a different one — and the
    // frozen prefix would grow, which is the opposite of what is wanted here.
    const withPruner = await drive({ pruner: true })
    expect(withPruner.leaves, 'the pruner should remove the need to fold at all').toBe(0)
  })
})

describe('the failure count in the message is real', () => {
  it('reports committed folds, never `retries + 1`', () => {
    // The constant that misled Phase 7. A reader must be able to tell one
    // committed fold from two, and the loop can exit without exhausting retries.
    //
    // Comments are stripped first: the fix's own doc comment quotes the old
    // expression to explain it, and the prohibition is on emitting it.
    const source = readFileSync(join(ROOT, 'src', 'engine.ts'), 'utf8')
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join('\n')
    expect(source, 'the message must not derive its count from the retry budget').not.toMatch(
      /after \$\{spec\.compactionRetries \+ 1\} leaf fold/u,
    )
    expect(source, 'and it must count what committed').toMatch(/committed \+= 1/u)
    expect(source).toMatch(/after \$\{committed\} committed leaf fold/u)
  })

  it('every code the engine raises is recognized by the harness classifier', () => {
    // ## The defect this pins
    //
    // The engine tagged `PRESSURE_UNRESOLVED`, but the harness classifier never
    // learned the code — so the failure fell into `other`, which is precisely the
    // conflation the kind split exists to end. The engine's code was added in the
    // same change and still did not reach the classifier, because the two files
    // are edited independently and nothing compared them.
    //
    // The check is deliberately mechanical: read every `code = '...'` the engine
    // assigns, and require the classifier to branch on each one. A new code with
    // no branch is the bug, and this fails before a run can produce an
    // unattributable `other`.
    const engine = readFileSync(join(ROOT, 'src', 'engine.ts'), 'utf8')
    const classifier = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')
    const raised = [...new Set(
      [...engine.matchAll(/\.code = '([A-Z_]+)'/gu)].map(match => match[1]!),
    )]
    expect(raised.length, 'the engine must raise at least one tagged failure').toBeGreaterThan(0)
    for (const code of raised) {
      expect(
        classifier,
        `the harness classifier must recognize '${code}', or it lands in 'other' `
        + 'beside genuinely unknown faults',
      ).toContain(`code === '${code}'`)
    }
  })
})
