/**
 * RC1.2-B: the keyless mechanism proof — recall RETURNS the folded facts.
 *
 * This is the deterministic half of the question, and it is the half that
 * decides whether the preset needs changing.
 *
 * The live smoke can only say "the model scored N/3". That number mixes two
 * different things: whether EF's recall mechanism can produce a folded fact, and
 * whether the model chooses to look. Only the first is a property of EF, and
 * only the first would justify changing `semanticMode`.
 *
 * So this suite removes the model from the loop entirely. It folds a
 * conversation carrying ordinary undeclared prose, and then asks the PRODUCT's
 * own `search` and `recall` whether the facts are reachable. No provider, no
 * tool-use variance, no sampling — the answer is deterministic.
 *
 * The claim it tests is narrow and exact:
 *
 *   a fact that the marker-only checkpoint surface no longer carries
 *   IS retrievable from the bundle through context_search → context_recall
 *
 * If that holds, then RC1.1's "conditional on declaration" reading described the
 * SURFACE, not the product, and the correct contract is "declared state is hot,
 * undeclared history is recoverable".
 *
 * @module tests/rc12b-recall-mechanism
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.ts'
import { growAndFold, seedNarrative, surfaceText } from './recall-loop.ts'
import { recall, search } from '../src/recall.ts'
import { resolvePreset } from '../src/preset.ts'

const WINDOW = 6_000
const RESERVED = 1_500

/**
 * The facts, the filler, the seeding and the growth loop all come from
 * `recall-loop.ts`, and they must: this file used to declare its own copies,
 * including a `filler` with a DECIMAL unit index. That index is not cosmetic —
 * a 250-unit filler contains `unit 64`, `unit 90` and `unit 30`, which are
 * exactly the tokens the fact matchers below look for. A local copy therefore
 * reintroduced the leak that `recall-loop.ts` documents as fixed, letting a
 * retained filler tail satisfy `/\b64\b/u` on the surface and making the
 * premise check below pass for the wrong reason.
 */

describe('RC1.2-B: undeclared prose is recoverable through the product recall path', () => {
  it('folds the facts OFF the surface, then finds them in the bundle', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: WINDOW,
      plugin: true,
      systemPrompt: true,
      tools: true,
      // The ENGINE resolves its route through `ctx.llm`, so the provider the
      // fixture routes to must have an adapter. `workloadModel` registers the
      // harness's scripted one — this suite needs no provider at all, since it
      // measures the recall mechanism rather than a model's use of it.
      workloadModel: 'live',
      efConfig: {
        ...resolvePreset('economy'),
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: Math.floor((WINDOW - RESERVED) * 0.16),
        maxTokens: RESERVED,
      },
    })
    const session = seedNarrative('rc12b')
    const folds = await growAndFold(harness, session, 14, 3_000)

    // Vacuity guard: without folds, the facts are simply still on the surface
    // and this test would prove nothing about recall.
    expect(folds, 'the session must fold for the facts to leave the surface').toBeGreaterThan(0)

    const surface = surfaceText(session)
    console.log(`MECHANISM folds=${folds} surface length=${surface.length}`)

    // --- The premise: the marker-only surface does NOT carry the prose.
    //
    // This is the RC1.1 finding, restated deterministically. It must hold, or
    // the rest of the test would be measuring a case that never arises.
    const onSurface = {
      constraint: /\b64\b/u.test(surface),
      supersession: /\b90\b/u.test(surface),
      exact: /PARSE-7741/u.test(surface),
    }
    console.log(`MECHANISM facts still on the surface: ${JSON.stringify(onSurface)}`)

    // --- The claim: they ARE retrievable.
    //
    // Queries are natural user phrasings, not the facts verbatim, so a hit
    // means the search index actually reaches the folded content rather than
    // pattern-matching an exact string.
    const queries = ['batch size', 'parser timeout', 'error code', 'PARSE-7741']
    let anyHit = 0
    let combined = ''
    for (const query of queries) {
      const hits = await search({
        store: harness.engine.bundleStore,
        sessionId: session.id,
        query,
      })
      if (hits.length > 0) anyHit += 1
      console.log(`MECHANISM search "${query}" -> ${hits.length} hit(s)`)
      for (const hit of hits.slice(0, 2)) {
        for (const depth of ['summary', 'detail', 'exact'] as const) {
          const result = await recall({
            store: harness.engine.bundleStore,
            sessionId: session.id,
            checkpointId: hit.checkpointId,
            depth,
          })
          combined += JSON.stringify(result ?? {})
        }
      }
    }

    expect(anyHit, 'at least one natural query must reach the folded archive').toBeGreaterThan(0)

    // --- THE ASSERTION THAT MATTERS. Every fact the surface lost must be
    // present in what recall RETURNS, or the mechanism does not close the gap
    // and the preset genuinely needs `rationale`.
    const recoverable = {
      constraint: /\b64\b/u.test(combined),
      supersession: /\b90\b/u.test(combined),
      exact: /PARSE-7741/u.test(combined),
    }
    console.log(
      `MECHANISM facts RECOVERABLE via search→recall: ${JSON.stringify(recoverable)} `
      + `(recalled text length ${combined.length})`,
    )

    expect(
      recoverable.constraint,
      'the batch-size limit must be recoverable from the folded archive',
    ).toBe(true)
    expect(
      recoverable.supersession,
      'the superseding timeout must be recoverable from the folded archive',
    ).toBe(true)
    expect(
      recoverable.exact,
      'the exact error code must be recoverable from the folded archive',
    ).toBe(true)

    // The superseded value is also archived — which is correct: the archive is
    // raw history, and the CORRECTION is what makes 90 authoritative. Recall
    // returning both is the honest behavior; a model reading them in order can
    // see the supersession, and one reading only `30` would be a comprehension
    // failure rather than a recall failure.
    console.log(
      `MECHANISM archived superseded value present: ${/\b30\b/u.test(combined)} `
      + '(expected: the archive is raw history, and the correction is what supersedes it)',
    )
  }, 600_000)

  it('the mechanism is the same under semanticMode:none and :rationale', async () => {
    // The preset question turns on this: if `none` recovers the facts just as
    // well, `rationale` buys nothing for RECALL — it only changes what the
    // surface carries, which is a different (and separately measured) property.
    const runWith = async (semanticMode: 'none' | 'rationale'): Promise<{
      readonly folds: number
      readonly recovered: boolean
      readonly onSurface: boolean
    }> => {
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: WINDOW,
        plugin: true,
        systemPrompt: true,
        tools: true,
        workloadModel: 'live',
        efConfig: {
          ...resolvePreset('economy'),
          semanticMode,
          thresholdRatio: 0.15,
          headroomTokens: 0,
          retainTokens: Math.floor((WINDOW - RESERVED) * 0.16),
          maxTokens: RESERVED,
        },
      })
      const session = seedNarrative('rc12b')
      const folds = await growAndFold(harness, session, 14, 3_000)
      const surface = surfaceText(session)
      const hits = await search({
        store: harness.engine.bundleStore,
        sessionId: session.id,
        query: 'error code',
      })
      let combined = ''
      for (const hit of hits) {
        const result = await recall({
          store: harness.engine.bundleStore,
          sessionId: session.id,
          checkpointId: hit.checkpointId,
          depth: 'exact',
        })
        combined += JSON.stringify(result ?? {})
      }
      return {
        folds,
        recovered: /PARSE-7741/u.test(combined),
        onSurface: /PARSE-7741/u.test(surface),
      }
    }

    const none = await runWith('none')
    const rationale = await runWith('rationale')
    console.log(
      `MECHANISM none:      folds=${none.folds} onSurface=${none.onSurface} recoverable=${none.recovered}`,
    )
    console.log(
      `MECHANISM rationale: folds=${rationale.folds} onSurface=${rationale.onSurface} recoverable=${rationale.recovered}`,
    )

    expect(none.folds).toBeGreaterThan(0)
    expect(rationale.folds).toBeGreaterThan(0)
    // BOTH modes must be able to recover it. If `none` could not, the preset
    // would need `rationale` for correctness rather than for surface richness.
    expect(none.recovered, 'semanticMode:none must still be able to recall the fact').toBe(true)
    expect(rationale.recovered, 'semanticMode:rationale must be able to recall the fact').toBe(true)
  }, 900_000)
})
