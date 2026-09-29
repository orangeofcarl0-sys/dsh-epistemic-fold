/**
 * RC1.2.1: the harness refuses a contradictory mount.
 *
 * The defect this pins was load-bearing and silent. `createHarness` returns
 * early on `plugin: true`, so a caller that ALSO passed `engine: 'basic'` got an
 * `EpistemicFoldPlugin` while believing it had Basic. The rc12a recall smoke did
 * exactly that, and the result was published as a three-arm comparison in which
 * the "Basic" arm was really:
 *
 *   EF plugin + default (legacy) policy + the EF recall tools registered
 *
 * which is why it reported `facts retrievable 2/5` — a metric that has no
 * meaning for real Basic, because real Basic has no Bundle and no
 * `context_search` / `context_recall`.
 *
 * The guard is a runtime throw rather than only a type change, so the mistake
 * cannot recur in any suite written later by someone reading only the call site.
 */

import { describe, expect, it } from 'vitest'
import { createHarness } from './harness.ts'

describe('RC1.2.1: plugin:true and engine:basic cannot be combined', () => {
  it('THROWS rather than silently preferring plugin:true', async () => {
    await expect(
      createHarness({ text: 'digest' }, {
        contextWindow: 8_000,
        plugin: true,
        engine: 'basic',
      }),
    ).rejects.toThrow(/mutually exclusive/u)
  })

  it('names both options and the remedy', async () => {
    // The message must be actionable, because the failure it prevents is one a
    // caller cannot see from the return value.
    await expect(
      createHarness({ text: 'digest' }, { plugin: true, engine: 'basic' }),
    ).rejects.toThrow(/plugin:true[\s\S]*engine:'basic'[\s\S]*Mount exactly one/u)
  })

  it('still mounts a real Basic engine when only engine:basic is given', async () => {
    // The guard must not break the legitimate path it exists to protect.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000,
      engine: 'basic',
    })
    expect(harness.engine).toBeDefined()
    // Basic has no EF bundle store: `bundleStore` on an EF engine is the
    // product's own, and its absence is what makes the two mounts different.
    expect((harness.engine as unknown as { bundleStore?: unknown }).bundleStore).toBeUndefined()
  })

  it('still mounts the EF plugin when only plugin:true is given', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000,
      plugin: true,
      systemPrompt: true,
      efConfig: { mode: 'economy' },
    })
    expect(harness.plugin).toBeDefined()
    expect(harness.engine.bundleStore).toBeDefined()
  })
})
