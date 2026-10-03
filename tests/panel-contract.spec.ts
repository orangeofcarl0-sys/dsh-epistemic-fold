/**
 * The panel and the host must agree on the projection's shape.
 *
 * ## The hole this closes
 *
 * `client.js` is plain JavaScript, so it cannot import `FoldStatusView` — it
 * carries a `@typedef` that MIRRORS the host interface. A mirror is the weak
 * part: the host could rename a field, update its interface, its Zod schema AND
 * its view function in one coordinated change, and the panel would keep
 * working — rendering `—` for that row, which is exactly what it renders for a
 * figure that is legitimately unknown.
 *
 * Measured before this test existed: renaming `folds` to `leafFolds` across all
 * three host sites (interface, `viewSchema`, `view`) left **all 46** panel and
 * registry tests passing. The rename was caught only by accident, when a
 * half-applied version tripped the Zod view schema.
 *
 * ## Why the comparison is against RUNTIME output
 *
 * The obvious check — parse `FoldStatusView` out of the source and compare
 * names — would pass on a schema/interface disagreement, and would also pass if
 * `view()` stopped emitting a declared field. Driving the real projection and
 * reading `Object.keys` of what it actually publishes tests the contract a
 * browser receives, not a declaration about it.
 *
 * The typedef side is read from `client.js` by parsing its JSDoc, because that
 * file cannot be imported: it is a browser module wrapped in
 * `window.__ModuleLoader__.load({...})`, and evaluating it in Node needs a fake
 * loader (which `sidebar-panel-render.spec.ts` supplies for its own purposes).
 *
 * ## What a failure means
 *
 * Either the host changed its view and the panel was not updated, or the panel
 * reads a field the host does not publish. Both are silent at runtime and
 * visible here.
 *
 * @module tests/panel-contract
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { epistemicFoldStatusProjection } from '../src/status-projection.ts'

const ROOT = join(import.meta.dirname, '..')

/**
 * Every property name a `@typedef` block in `client.js` declares.
 *
 * Handles both the required form (`@property {number} folds`) and the optional
 * form (`@property {number} [pressureTokens]`), which is how the pressure
 * typedef marks the fields a provider may not have reported yet.
 */
function typedefKeys(source: string, name: string): string[] {
  const block = source.match(new RegExp(`@typedef \\{object\\} ${name}\\b([\\s\\S]*?)\\*/`))
  if (block === null) throw new Error(`client.js declares no @typedef ${name}`)
  return [...block[1]!.matchAll(/@property \{[^}]*\} \[?([A-Za-z_$][\w$]*)\]?/gu)]
    .map(match => match[1]!)
    .sort()
}

/** The keys the host's view ACTUALLY publishes, from the real projection. */
function hostViewKeys(): string[] {
  const unit = epistemicFoldStatusProjection({ mode: 'economy' })
  return Object.keys(unit.wire.view(unit.init())).sort()
}

describe('the panel renders the projection the host actually publishes', () => {
  it('the panel typedef and the host view declare the same keys', () => {
    const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
    const declared = typedefKeys(source, 'FoldStatusView')
    const published = hostViewKeys()

    // Reported as two lists rather than a set difference so a failure names
    // both directions at once: a field the host added and the panel ignores,
    // and a field the panel reads that no longer exists.
    expect(declared, 'the panel must mirror the host view exactly').toEqual(published)
  })

  it('the panel reads every key it declares, and no others', () => {
    // The typedef could be correct while the panel body drifts from it — a row
    // deleted, or a field read that was never declared. `status.<name>` is the
    // only way this panel reaches the view, so the set is exactly recoverable.
    const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
    const declared = typedefKeys(source, 'FoldStatusView')
    const read = [...new Set(
      [...source.matchAll(/\bstatus\.([A-Za-z_$][\w$]*)/gu)].map(match => match[1]!),
    )].sort()

    // `usage` is read as `status.usage` and then destructured; the nested keys
    // are asserted separately below.
    expect(read, 'a declared-but-unread or read-but-undeclared field').toEqual(declared)
  })

  it('the nested usage block matches the host split', () => {
    const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
    const declared = typedefKeys(source, 'FoldStatusUsage')
    // The host publishes the four buckets inside `usage`; drive it with real
    // usage so the block is present rather than null.
    const unit = epistemicFoldStatusProjection({ mode: 'economy' })
    const state = {
      ...unit.init(),
      provider: 'deepseek', model: 'deepseek-flash',
      uncachedInputTokens: 10, cacheReadTokens: 5, outputTokens: 2, hasUsage: true,
    }
    const view = unit.wire.view(state)
    expect(view.usage, 'the fixture must produce a usage block').not.toBeNull()
    expect(declared).toEqual(Object.keys(view.usage!).sort())
  })

  it('the pressure typedef matches the token meter fields the panel divides', () => {
    // `occupancy` is pressure over window, so both halves must exist under the
    // names this panel uses. Asserted against the names the meter's own
    // projection publishes (`ContextPressureProjection`), which the panel
    // already reads through `useProjectionValue(..., 'contextPressure')`.
    const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
    const declared = typedefKeys(source, 'ContextPressureView')
    // Sorted, like every other comparison in this file.
    expect(declared).toEqual(['contextWindow', 'pressureTokens', 'projectedTokens'])
  })
})
