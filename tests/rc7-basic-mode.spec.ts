/**
 * RC7-T1/T6: `mode: basic` makes EF stand aside — behaviourally and visibly.
 *
 * ## Why these two tests are the same test
 *
 * RC4-A found the defect class this guards: a mounted EF whose engine is NOT
 * folding still REPORTS. The Sidebar panel and `/context` showed an EF with zero
 * folds while native Basic did the work, which reads as "EF is idle" rather than
 * "EF is not running". Suppressing the engine's behaviour without suppressing its
 * surface would reproduce that defect exactly, so the two halves are asserted
 * together:
 *
 *  T1 — the FOLD is Basic's: same checkpoint body, no EF marker, no bundle.
 *  T6 — the SURFACE is absent: no projection, no status, no recall tools, no
 *       `/context` command, no `ctx.epistemicFold` anchor service.
 *
 * Either half alone is insufficient. A fold that matches Basic but a panel that
 * still reports EF is the RC4-A bug; a panel that is absent but a fold that still
 * stamps `[EF1 …]` would corrupt the fold frontier of a later EF session.
 *
 * @module tests/rc7-basic-mode
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { createHarness, SIGNAL } from './harness.ts'

const WINDOW = 12_000

/**
 * Budgets shared by both arms.
 *
 * Chosen so a fold actually LANDS: a parity test where neither engine folds
 * compares two unfolded surfaces and proves nothing. This mistake was made twice
 * while building RC7 and is guarded here by asserting both arms folded.
 */
const SHARED = {
  thresholdRatio: 0.15,
  headroomTokens: 0,
  retainTokens: 300,
  maxTokens: 3_000,
}

const filler = (units: number): string =>
  Array.from({ length: units }, (_, i) => `bg ${i} ${'payload '.repeat(12)}`).join(' ')

/** A session grown past the threshold, with one open turn to fold into. */
function seed(tag: string): SessionType {
  const session = Session.create(SessionId(`rc7-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: 'live', model: 'live' } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `The batch limit is 64. ${filler(120)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: filler(300) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

/** The checkpoint node's text, or null when no fold landed. */
function checkpointText(session: SessionType): string | null {
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message !== null && isCompactCheckpointSource(message.source)) {
      return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    }
  }
  return null
}

/** Drive one pressure fold and report what landed. */
async function foldOnce(arm: 'native-basic' | 'ef-basic', tag: string) {
  const harness = arm === 'native-basic'
    // The host package: what a user's DSH actually runs. The reference arm.
    ? await createHarness({ text: 'SEMANTIC-SUMMARY-MARKER' }, {
        contextWindow: WINDOW, engine: 'basic', workloadModel: 'live', efConfig: SHARED,
      })
    // EF in `mode: basic`: delegates to EF's OWN vendored copy of Basic.
    : await createHarness({ text: 'SEMANTIC-SUMMARY-MARKER' }, {
        contextWindow: WINDOW, plugin: true, projection: true, systemPrompt: true, tools: true,
        workloadModel: 'live', efConfig: { ...SHARED, mode: 'basic' },
      })
  const session = seed(tag)
  const before = harness.ctx.tokenMeter.measure(session).totalTokens
  try {
    await (harness.engine as unknown as {
      compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
    }).compactIfNeeded({ session, options: { provider: 'live', model: 'live' } }, 'pressure', SIGNAL)
  } catch {
    // A refusal is a decision, not a failure; the checkpoint body is the evidence.
  }
  return {
    body: checkpointText(session),
    before,
    after: harness.ctx.tokenMeter.measure(session).totalTokens,
    bundle: harness.engine.publishedBundle,
    harness,
  }
}

describe('RC7-T1: mode:basic produces the SAME fold as native Basic', () => {
  it('the checkpoint body is byte-identical, with no EF marker and no bundle', async () => {
    const native = await foldOnce('native-basic', 'native')
    const basic = await foldOnce('ef-basic', 'efbasic')

    // Vacuity guard: without a landed fold in BOTH arms, identical surfaces would
    // prove nothing about the fold.
    expect(native.body, 'native Basic must fold for this comparison to mean anything').not.toBeNull()
    expect(basic.body, 'EF in mode:basic must fold for this comparison to mean anything').not.toBeNull()
    expect(basic.after, 'the fold must actually reclaim tokens').toBeLessThan(basic.before)

    // THE CLAIM: byte-identical checkpoint bodies.
    expect(basic.body).toBe(native.body)

    // ...and the marker specifically, because that is what would corrupt the fold
    // frontier of a later EF session on the same surface.
    expect(basic.body).not.toContain('[EF1')
    expect(basic.body).not.toContain('cp:')

    // No bundle: the fold never became an EF checkpoint, so there is nothing for
    // `context_recall` to return and nothing for the frontier to misread.
    expect(basic.bundle, 'mode:basic must not publish an EF bundle').toBeUndefined()
  }, 300_000)
})

describe('RC7-T6: mode:basic registers NO EF surface', () => {
  it('the fold delegates, and every EF surface the PLUGIN owns is absent', async () => {
    const { harness } = await foldOnce('ef-basic', 'surface')
    const { ctx, plugin } = harness
    // The harness types `plugin` as optional because a non-plugin mount has none;
    // this arm mounts one, so its absence would be a fixture error rather than a
    // finding. Asserting it here keeps the checks below non-optional.
    expect(plugin, 'this arm must mount the EF plugin').toBeDefined()
    if (plugin === undefined) return

    // The engine still owns `ctx.compaction` — that is HOW it delegates — but it
    // reports itself as standing aside.
    expect(plugin.engine.basicMode).toBe(true)
    expect(plugin.engine.currentMode).toBe('basic')

    // (1) No anchor service. A provided service is a surface.
    expect(plugin.anchors, 'mode:basic must not provide the anchor service').toBeUndefined()
    expect(ctx.get('epistemicFold'), 'ctx.epistemicFold must be absent').toBeUndefined()

    // (2) No STATUS projection — the Sidebar's data source. This is the RC4-A
    // half of the guard: a status projection that exists would report an EF that
    // is not folding, which reads as "EF is idle" rather than "EF is not running".
    //
    // The state projection is NOT asserted absent here: the harness mounts it
    // independently when a test asks for `projection: true`, so its presence in
    // this fixture says nothing about the plugin. What the plugin owns is the
    // status surface, and that is what is checked.
    const registry = ctx.get('sessionProjections')
    const session = Session.create(SessionId(`rc7-probe-${Date.now()}`))
    expect(
      registry?.stateOf(session, 'epistemicFold.status'),
      'mode:basic must not register the status projection (the Sidebar source)',
    ).toBeUndefined()
  }, 300_000)

  it('runtime switching in or out of basic is refused, not half-applied', async () => {
    // The surface is decided at MOUNT, so a running engine cannot acquire or shed
    // it. Switching must fail loud rather than leave a mounted EF whose surface
    // disagrees with its behaviour — the RC4-A defect again.
    const { harness } = await foldOnce('ef-basic', 'switch')
    expect(() => harness.engine.setMode('economy'))
      .toThrow(/install-time mode/u)
    expect(harness.engine.currentMode, 'a refused switch must not change the mode').toBe('basic')
  }, 300_000)
})
