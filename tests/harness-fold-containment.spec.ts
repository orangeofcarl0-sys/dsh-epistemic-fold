/**
 * A failed fold must not end the episode, and the failure must be visible.
 *
 * ## The defect this exists for
 *
 * `bridge-host.ts` called `compactIfNeeded` with no try/catch. Production does
 * not: `src/basic/index.ts` registers `agent/pre-step` and wraps its own call in
 * a catch that logs `step compaction failed: …; continuing the turn` and calls
 * `next()`. A fold that cannot complete is a missed fold in real DSH, not a
 * fatal condition.
 *
 * In the harness the error propagated out of `modelTurn`, became `{ok: false}`,
 * raised `BridgeError` in the Python client, and left `ef_lhtb_agent.run()` —
 * ending the trial at reward 0. The Phase 7 `basic` arm died exactly this way at
 * turn 62, after 62 real model calls:
 *
 *     ef_bridge_client.BridgeError: summarization truncated at the token cap
 *     (incomplete checkpoint)
 *
 * The report read that as evidence about Basic's summarization quality. It was
 * evidence about the harness: the run was killed by an unguarded call, not by a
 * task failure and not by the model giving up.
 *
 * ## What is pinned, and why at two levels
 *
 * `bridge-host.ts` is a script — importing it starts the stdin protocol loop —
 * so a unit test cannot call its `foldIfNeeded`. The containment is therefore
 * pinned in the SOURCE (the call is inside a `try`, and the catch records rather
 * than rethrows), and the underlying SEMANTICS are pinned against the engine
 * (a truncated summarization really does throw, so a guard is genuinely
 * required). Neither alone is sufficient: the source check would pass against a
 * catch that swallowed the error silently, and the semantics check alone would
 * not notice the guard being deleted.
 *
 * @module tests/harness-fold-containment
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHarness, SIGNAL } from './harness.ts'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')
const MODEL = 'test-model'

const source = readFileSync(BRIDGE, 'utf8')

/** The body of `foldIfNeeded`, so assertions cannot match a different function. */
function foldBody(): string {
  const start = source.indexOf('async function foldIfNeeded()')
  expect(start, 'foldIfNeeded must exist').toBeGreaterThan(-1)
  // Ends at the next top-level `async function` / `function` declaration.
  const rest = source.slice(start)
  const end = rest.indexOf('\nfunction ', 1)
  const endAsync = rest.indexOf('\nasync function ', 1)
  const stop = [end, endAsync].filter(i => i > 0).sort((a, b) => a - b)[0] ?? rest.length
  return rest.slice(0, stop)
}

describe('a fold failure is contained in the harness', () => {
  it('wraps compactIfNeeded in a try/catch rather than letting it escape', () => {
    const body = foldBody()
    expect(body, 'the fold call must be guarded').toContain('try {')
    expect(body).toContain('compactIfNeeded(agent, \'pressure\'')
    // The guard must be around the CALL, not somewhere later in the function.
    const tryAt = body.indexOf('try {')
    const callAt = body.indexOf("compactIfNeeded(agent, 'pressure'")
    expect(tryAt, 'the try must precede the call').toBeLessThan(callAt)
    // `catch` is searched AFTER the `try`: the function's own doc comment
    // contains the word "try/catch", which would otherwise satisfy this.
    expect(body.indexOf('catch', tryAt), 'the try must have a catch').toBeGreaterThan(tryAt)
    // And the catch must come after the call, so it encloses it.
    expect(body.indexOf('catch', callAt), 'the catch must follow the call').toBeGreaterThan(callAt)
  })

  it('records the failure instead of swallowing it', () => {
    const body = foldBody()
    // A silent catch would be worse than the crash it replaces: an arm that
    // failed every call would be indistinguishable from one that folded cleanly.
    expect(body, 'failures must be counted').toMatch(/compactionFailures\s*\+=\s*1/u)
    expect(body, 'the message must be kept').toMatch(/lastCompactionError\s*=/u)
    // And the credential redaction every other error path uses.
    expect(body, 'a maintenance error can echo the request, which carries the key').toContain('[redacted]')
  })

  it('splits the count by KIND, so the mix is readable after the fact', () => {
    // The count alone merged two different faults: a summarization budget error
    // and a provider HTTP 500 both incremented one number, and only the LAST
    // message was kept. A run had to be comparable to itself, so the kind has to
    // be recorded as it happens rather than reconstructed from prose later.
    const body = foldBody()
    expect(body, 'the kind must be recorded per failure').toMatch(/compactionFailureKinds\[/u)
    expect(body, 'and classified by structure before prose').toMatch(/classifyCompactionFailure\(/u)
    // Structured codes first: Basic tags a truncated summary, the adapter tags
    // its own failures. Message matching is the fallback, not the method.
    expect(source).toContain("code === 'MAX_TOKENS'")
    expect(source).toContain("code === 'LIVE_HTTP'")
  })

  it('names a failed fold that is neither truncated nor the provider', () => {
    // "still above threshold after N leaf fold attempts" is a THIRD thing: the
    // summary succeeded and the surface is still over the threshold. It was the
    // only non-truncated failure in the two-pass run and it recurred in both
    // economy passes, so it is reproducible rather than noise. Left as 'other' it
    // would share a bucket with genuinely unknown faults -- the conflation this
    // classifier exists to end.
    expect(source, 'the harness must name the kind').toContain("'pressure-unresolved'")
    expect(source, 'and must not rely on prose alone').toContain("code === 'PRESSURE_UNRESOLVED'")
    // The code has to be attached where the error is RAISED, or the structural
    // branch above can never fire. It goes on EF's own engine, which is ours.
    //
    // NOT on src/basic/index.ts, which raises the same failure in Basic's
    // wording: that tree is a byte-identical vendored copy of
    // @deepseek-ai/dsh-compaction-basic (tests/rc7-vendored-basic.spec.ts), so a
    // tag there would rot the fork. Both messages are covered by the fallback
    // above, which is why the tag is an optimisation and not the only path.
    const raiser = readFileSync(join(ROOT, 'src', 'engine.ts'), 'utf8')
    expect(raiser, 'the engine must tag it').toContain("unresolved.code = 'PRESSURE_UNRESOLVED'")
    expect(raiser, 'and must keep the message').toMatch(/still above threshold after/u)
    const vendored = readFileSync(join(ROOT, 'src', 'basic', 'index.ts'), 'utf8')
    expect(vendored, 'the vendored copy must stay untouched').not.toContain('PRESSURE_UNRESOLVED')
    expect(vendored, 'and keep its own wording').toMatch(/compaction still above threshold after/u)
  })

  it('surfaces the counters in the telemetry it reports', () => {
    // A counter nobody reads is not a record. The telemetry block is what the
    // LHTB transcript persists.
    expect(source).toMatch(/readonly compactionFailures: number/u)
    expect(source).toMatch(/readonly compactionFailureKinds: Readonly<Record<string, number>>/u)
    expect(source).toMatch(/readonly lastCompactionError: string \| null/u)
    expect(source).toMatch(/^\s*compactionFailures,$/mu)
    expect(source).toMatch(/^\s*compactionFailureKinds,$/mu)
    expect(source).toMatch(/^\s*lastCompactionError,$/mu)
    // Reset per episode: the bridge process is long-lived across init calls.
    expect(source).toMatch(/compactionFailures = 0/u)
    expect(source).toMatch(/compactionFailureKinds = \{\}/u)
    expect(source).toMatch(/lastCompactionError = null/u)
  })

  it('no longer calls a compaction failure a FOLD failure', () => {
    // On the basic arm the call this counts is Basic's own summarization, so
    // "folds that THREW" was false there by construction -- a basic cell
    // legitimately reports folds: 0 beside a non-zero failure count. The old
    // names must not come back, because the misreading they caused is the whole
    // reason this file has a rename in it.
    expect(source, 'the EF word for it must not come back').not.toMatch(/foldFailures|lastFoldError/u)
  })

  it('bounds the fold with a real deadline, not an un-aborted controller', () => {
    const body = foldBody()
    // The old signal was `new AbortController().signal` — created and never
    // aborted — so nothing bounded summarization. That is how one fold stalled
    // for 16 minutes with no error and both processes alive.
    expect(body, 'the fold must have a timeout').toMatch(/FOLD_TIMEOUT_MS/u)
    expect(body).toMatch(/setTimeout\(/u)
    expect(body).toMatch(/clearTimeout\(/u)
    expect(source, 'the bound must be documented and overridable').toMatch(
      /EF_TAU2_FOLD_TIMEOUT_MS/u,
    )
  })

  it('bounds BOTH fold paths, since the idle rebase summarizes too', () => {
    // The automatic pressure fold was bounded first, and the idle rebase was
    // left open — which made "each fold is bounded" false, because the rebase IS
    // a fold: `compactNow` summarizes, and it builds its operation signal from
    // the one handed to it by `runMaintenance`. A stalled rebase is exactly what
    // the Phase 7 run hit, so leaving this path unbounded would have left the
    // defect reachable through the other door.
    const start = source.indexOf('async function drainIdleRebase()')
    expect(start, 'drainIdleRebase must exist').toBeGreaterThan(-1)
    const rest = source.slice(start)
    const end = rest.indexOf('\nasync function ', 1)
    const body = rest.slice(0, end > 0 ? end : rest.length)

    expect(body, 'the idle consumer must construct a deadline').toMatch(/const deadline = new AbortController\(\)/u)
    expect(body, 'and it must actually abort it').toMatch(/deadline\.abort\(/u)
    expect(body, 'the task must receive that deadline').toMatch(/task\(deadline\.signal\)/u)
    expect(body, 'and the timer must be cleared on the way out').toMatch(/clearTimeout\(/u)
  })

  it('leaves no un-aborted controller on the fold path', () => {
    // The first version of this fix passed the deadline through
    // `AbortSignal.any([deadline.signal, new AbortController().signal])` — which
    // is harmless at runtime (an `any()` with a never-aborting member is the
    // deadline) but kept the EXACT expression being fixed on the EXACT line
    // being fixed. Grepping for the defect hit the fix, so a later reader could
    // not tell whether the fix had landed.
    //
    // The invariant is not "no controller" — the deadline IS one. It is that
    // every controller on this path is a controller something actually aborts.
    // Comments are stripped first, since this function's own doc comment quotes
    // the old expression to explain it.
    const code = foldBody()
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join('\n')

    // Every `new AbortController()` must be bound to a name…
    const constructed = [...code.matchAll(/const\s+(\w+)\s*=\s*new AbortController\(\)/gu)]
      .map(match => match[1]!)
    expect(constructed.length, 'the deadline controller must exist').toBeGreaterThan(0)

    // …and every such name must be aborted, or handed to `AbortSignal.timeout`.
    for (const name of constructed) {
      expect(
        code,
        `${name} is constructed but never aborted — that is the unbounded-signal defect`,
      ).toMatch(new RegExp(`${name}\\.abort\\(`, 'u'))
    }

    // And no controller may be constructed inline, where it cannot be aborted
    // and cannot be named. This is the exact shape the first fix left behind.
    expect(
      code,
      'a controller built inline in the task call cannot be aborted — pass the deadline itself',
    ).not.toMatch(/task\([^)]*new AbortController\(\)/u)
    expect(code, 'the deadline must be passed directly').toMatch(/task\(deadline\.signal\)/u)
  })
})

describe('the engine really does throw on a truncated fold', () => {
  /**
   * A conversation large enough to cross the fold threshold at an 8k window.
   *
   * Written out rather than using `conversation(n)`, whose 280-char turns never
   * reach a threshold — which is the trap the convergence specs document: a
   * fixture that cannot fold makes every invariant hold vacuously.
   */
  function largeConversation(turns = 12): Session {
    const session = Session.create(SessionId(`fold-containment-${turns}`))
    const blob = 'x'.repeat(4_000)
    for (let turn = 1; turn <= turns; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${blob} user ${turn}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      if (turn === 1) {
        session.append('request/header', {
          header: { config: { provider: MODEL, model: MODEL } },
          reason: 'initial',
        })
      }
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `${blob} assistant ${turn}` }],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: turns + 1 })
    return session
  }

  it('throws the Phase 7 error, so an unguarded caller would die with it', async () => {
    const { engine } = await createHarness(
      { failure: { kind: 'max-tokens', message: 'truncated' } },
      {
        contextWindow: 8_000,
        efConfig: { auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 2_000, mode: 'basic' },
      },
    )
    const session = largeConversation()
    const agent = {
      session,
      options: { provider: MODEL, model: MODEL },
      runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as never

    // The exact message from the Phase 7 trial. If this stops throwing, the
    // guard becomes unnecessary — but until then, an unguarded call is fatal.
    await expect(
      (engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL),
    ).rejects.toThrow(/summarization truncated at the token cap/u)
  })

  it('leaves the surface intact, so a contained failure is recoverable', async () => {
    // Containment is only safe if the failed fold left nothing half-applied.
    // The engine prepares a candidate and only replaces the surface after the
    // summary lands, so a throw must leave the surface exactly as it was.
    const { engine } = await createHarness(
      { failure: { kind: 'max-tokens', message: 'truncated' } },
      {
        contextWindow: 8_000,
        efConfig: { auto: true, thresholdRatio: 0.5, headroomTokens: 0, maxTokens: 2_000, mode: 'basic' },
      },
    )
    const session = largeConversation()
    const before = [...session.surface.nodes]
    const agent = {
      session,
      options: { provider: MODEL, model: MODEL },
      runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as never

    await expect(
      (engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL),
    ).rejects.toThrow()

    expect([...session.surface.nodes], 'a failed fold must not mutate the surface').toEqual(before)
    // And it must not have published a bundle for a fold that never committed.
    expect(engine.bundleWriteCount).toBe(0)
    expect(engine.leafFoldCount).toBe(0)
  })
})
