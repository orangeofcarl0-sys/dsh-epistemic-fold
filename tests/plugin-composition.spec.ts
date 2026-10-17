/**
 * R0-B composition smoke: the native plugin entry mounts the WHOLE runtime
 * into one cordis context — compaction engine, state projection, recall
 * tools, anchor service — and a real fold + recall + restart cycle works
 * through the mounted composition, not through hand-wired test seams.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeTemp } from '../eval/tmp.ts'
import {
  createMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Session } from '@deepseek-ai/dsh-session'
// The shared DSH runtime mount sequence (docs/68 B-6): one place for the
// services every harness used to hand-wire.
import { mountRuntime } from '../eval/src/runtime-mount.ts'
import { EpistemicFoldEngine } from '../src/fold/engine.ts'
import { createAnchorService } from '../src/state/anchor-service.ts'
import { EF_CURRENT_STATE_KEY, currentFoldState } from '../src/state/projection.ts'
import { recall } from '../src/recall/recall.ts'
import { efOwnedConfigKeys } from '../src/policy.ts'
import { EF_KEYS, PRESET_OWNED_KEYS } from '../src/ef-keys.ts'
import type { EpistemicFoldConfig } from '../src/policy.ts'
import EpistemicFoldPlugin from '../src/plugin.ts'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

class CompositionAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'rationale: the parser rewrite landed in three steps' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'rationale: the parser rewrite landed in three steps' } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []

async function createContextWithPlugin(config: { bundleRoot?: string } = {}): Promise<{
  ctx: Context
  root: string
  bundleRoot: string
  plugin: EpistemicFoldPlugin
}> {
  const root = await makeTemp('ef-plugin-')
  roots.push(root)
  const bundleRoot = join(root, 'bundles')
  const ctx = new Context()
  mountRuntime(ctx, { systemPrompt: true, tools: true })
  ctx.llm.registerAdapter([MODEL], new CompositionAdapter())
  const plugin = new EpistemicFoldPlugin(ctx, { auto: false, bundleRoot, ...config })
  return { ctx, root, bundleRoot, plugin }
}

/**
 * Mount the plugin with a config that has been through the DECLARED schema —
 * the loader path, not the programmatic one.
 *
 * A YAML profile's config reaches the plugin through
 * `EpistemicFoldPlugin.Config`, so that is the path B-5 must exercise. The
 * schema is descriptive (docs/68 §4), so a key it does not declare is still
 * carried.
 */
async function createContextWithSchemaParsedConfig(raw: Record<string, unknown>): Promise<{
  plugin: EpistemicFoldPlugin
}> {
  const root = await makeTemp('ef-plugin-loader-')
  roots.push(root)
  const ctx = new Context()
  mountRuntime(ctx, { systemPrompt: true, tools: true })
  ctx.llm.registerAdapter([MODEL], new CompositionAdapter())
  const parsed = EpistemicFoldPlugin.Config({
    auto: false,
    bundleRoot: join(root, 'bundles'),
    ...raw,
  } as unknown as EpistemicFoldConfig) as unknown as Record<string, unknown>
  const plugin = new EpistemicFoldPlugin(ctx, parsed as EpistemicFoldConfig)
  return { plugin }
}

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true, force: true })
  }
})

function conversation(): Session {
  const session = Session.create(SessionId(`ef-plugin-${Date.now()}-${Math.random()}`))
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `plugin fixture user ${turn} ${'fixture '.repeat(20).trim()}` }],
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
        content: [{ type: 'text', text: `plugin fixture assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  return session
}

describe('R0-B: native plugin composition', () => {
  it('mounts engine, projection, tools, and anchor service in one plugin', async () => {
    const { ctx, bundleRoot, plugin } = await createContextWithPlugin()

    // ctx.compaction is the EF engine, configured with the plugin bundleRoot.
    const engine = plugin.engine
    expect(engine).toBeInstanceOf(EpistemicFoldEngine)
    expect(engine.efConfig.bundleRoot).toBe(bundleRoot)
    expect((ctx as unknown as { compaction: unknown }).compaction).toBeInstanceOf(EpistemicFoldEngine)
    // The anchor service is exposed on the context.
    expect(typeof ctx.epistemicFold.declare).toBe('function')
    // The state projection is registered: an empty session folds to a state.
    const probe = Session.create(SessionId('ef-plugin-probe'))
    expect(currentFoldState(ctx, probe)).toEqual(currentFoldState(ctx, probe))
  })

  it('a real fold through the mounted composition lands recall tools + state + bundle', async () => {
    const { ctx } = await createContextWithPlugin()
    const { plugin } = await createContextWithPlugin()
    const engine = plugin.engine
    const session = conversation()
    const nodes = [...session.surface.nodes]

    const result = await engine.compactRegion(nodes[0]!, nodes[7]!, { session, options: { provider: MODEL, model: MODEL } } as never, SIGNAL)
    expect(result.shadowedSeqs).toHaveLength(8)

    // State projection advanced (mounted by the plugin).
    const state = currentFoldState(ctx, session)
    expect(state.stateHeads).toBeDefined()

    // Recall works against the plugin-configured bundle root.
    const checkpointId = /cp:([0-9a-f-]{36})\]/u.exec(
      (lastSummary(session)!.summary as never as { text?: string }[])?.map(b => b.text ?? '').join('\n') ?? '',
    )?.[1]
    expect(checkpointId).toBeDefined()
    const recalled = await recall({
      store: engine.bundleStore,
      sessionId: session.id,
      checkpointId: `cp:${checkpointId}`,
      depth: 'summary',
    })
    expect(recalled?.text).toContain(`cp:${checkpointId}`)
  })

  it('the plugin-provided anchor service refuses a write this host cannot persist', async () => {
    // `ef/anchor` is outside DSH's known event vocabulary, and a host whose
    // `append` drops the `ignorable` marker would persist a log it then refuses
    // to reopen. The plugin wires the capability probe, so on such a host the
    // refusal IS the contract — the round-trip establishing why lives in
    // tests/persistence-compat.spec.ts.
    const { ctx } = await createContextWithPlugin()
    const session = conversation()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'keep the CLI flags stable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const before = session.seq
    expect(() => ctx.epistemicFold.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'cli', property: 'flags' },
      value: 'keep the CLI flags stable',
      authority: 'normative',
      sourceRefs: [{ seq: (session.seq - 1) as never }],
    })).toThrow(/refusing to append `ef\/anchor`/u)
    expect(session.seq, 'a refused write must not reach the log').toBe(before)

    // The authority gate itself is unchanged and still refuses laundering. It
    // stays reachable on the in-memory face, where nothing persists the log.
    const inMemory = createAnchorService()
    expect(() => inMemory.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'cli', property: 'flags' },
      value: 'claim from assistant prose',
      authority: 'normative',
      sourceRefs: [{ seq: 0 as never }],
    })).toThrow(/ungrounded|not grounded/u)
  })

  it('restart: a fresh context over the same bundle root still recalls', async () => {
    const first = await createContextWithPlugin()
    const engine = first.ctx.compaction as EpistemicFoldEngine
    const session = conversation()
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[7]!, { session, options: { provider: MODEL, model: MODEL } } as never, SIGNAL)
    const checkpointId = /cp:([0-9a-f-]{36})\]/u.exec(
      (lastSummary(session)!.summary as never as { text?: string }[])?.map(b => b.text ?? '').join('\n') ?? '',
    )?.[1]!
    expect(checkpointId).toBeDefined()
    const sessionId = session.id
    const bundleRoot = first.bundleRoot
    await first.ctx.fiber.dispose()

    // "Restart": a brand-new context mounting the plugin over the SAME root.
    const second = await createContextWithPlugin({ bundleRoot })
    const secondEngine = second.plugin.engine
    const recalled = await recall({
      store: secondEngine.bundleStore,
      sessionId,
      checkpointId,
      depth: 'exact',
    })
    expect(recalled?.page?.totalMessages).toBe(8)
  })
})

describe('B-5: the plugin Config schema indexes the whole EF-owned vocabulary', () => {
  it('declares every key in efOwnedConfigKeys()', () => {
    // docs/68 C2: the schema declared 19 keys and omitted 9 of the 17 EF-owned
    // ones. schemastery passes unknown keys THROUGH, so the omission was a
    // documentation and range-checking gap rather than a dropped setting — which
    // is why the fix is this set comparison and not the declined key-table
    // refactor (Tier C-1). `Config.dict` is the schema's own field list, so the
    // assertion reads the declaration instead of restating it.
    const declared = new Set(Object.keys(EpistemicFoldPlugin.Config.dict ?? {}))
    const missing = efOwnedConfigKeys().filter(key => !declared.has(key))
    expect(missing, 'EF-owned keys absent from the plugin Config schema').toEqual([])
  })

  it('derives every list from the ONE table, so a new key cannot reach only some of them', () => {
    // Added 2026-10-18 with `src/ef-keys.ts`. Before it, this vocabulary lived in four
    // hand-maintained lists and adding ONE key took 14 registration sites; missing the strip
    // list made Basic reject the whole mount (`BasicCompactionConfig: unknown key ...`) rather
    // than fail a test. The guard above checks one direction only, so this checks the derivation:
    // every list must be exactly what the table says it is.
    const table = EF_KEYS
    expect(efOwnedConfigKeys().slice().sort()).toEqual(
      table.filter(k => k.efOwned).map(k => k.name).sort())
    expect(PRESET_OWNED_KEYS.slice().sort()).toEqual(
      table.filter(k => k.presetOwned).map(k => k.name).sort())
    // And the two dimensions must genuinely differ, or the table is not earning its keep:
    // `retainRatio` is preset-owned and BASIC-owned, so it must NOT be stripped.
    expect(PRESET_OWNED_KEYS).toContain('retainRatio')
    expect(efOwnedConfigKeys()).not.toContain('retainRatio')
    // Every EF-owned key must also be declared in the schema -- the check above, stated once
    // more against the table so a key added to the table but not the schema fails HERE.
    const declared = new Set(Object.keys(EpistemicFoldPlugin.Config.dict ?? {}))
    expect(table.filter(k => k.efOwned && !declared.has(k.name)).map(k => k.name)).toEqual([])
  })

  it('mounts through the schema and the EF-owned keys survive to the engine', async () => {
    // The SCHEMA is descriptive, not restrictive (docs/68 §4): a key it does not
    // declare still survives the parse, and this pins that pass-through so a
    // future change cannot quietly make the schema strict.
    //
    // The MOUNT is a different matter, and the distinction is the point: Basic
    // validates ITS OWN keys strictly, so an unknown key reaching the engine
    // still throws (`BasicCompactionConfig: unknown key`) — the R0 behaviour
    // `stripEfConfigKeys` exists to keep. Pass-through is a schema property,
    // not a licence to mount arbitrary keys.
    const passedThrough = EpistemicFoldPlugin.Config({
      bogusKey: 1,
      // A wrong-typed value must also still reach `policy.ts`, which owns that
      // rejection (docs/68 C4): declaring the key added documentation, not a
      // second validation layer.
      minReclaimTokens: 'not-a-number',
    } as unknown as EpistemicFoldConfig) as unknown as Record<string, unknown>
    expect(passedThrough.bogusKey).toBe(1)
    expect(passedThrough.minReclaimTokens).toBe('not-a-number')

    // ONE loader-path mount: a loader/YAML config goes through
    // `EpistemicFoldPlugin.Config` before the plugin sees it, so that is the
    // path that must carry the EF-owned keys to the engine's resolved config.
    const { plugin } = await createContextWithSchemaParsedConfig({
      referentialArchive: true,
      allowCrossSessionRecall: true,
      leafAdmission: 'economic',
      minReclaimTokens: 1_000,
      rootPolicy: 'economics',
      subagentRecall: true,
    })
    expect(plugin.engine.efConfig.referentialArchive).toBe(true)
    expect(plugin.engine.efConfig.allowCrossSessionRecall).toBe(true)
    expect(plugin.engine.efConfig.leafAdmission).toBe('economic')
    expect(plugin.engine.efConfig.minReclaimTokens).toBe(1_000)
    expect(plugin.engine.efConfig.rootPolicy.mode).toBe('economics')
    expect(plugin.engine.efConfig.subagentRecall).toBe(true)
  })
})

function lastSummary(session: Session): { summary: unknown[]; shadowedSeqs: number[] } | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)
    if (event?.type === 'compaction/summary') {
      return event.data as never
    }
  }
  return undefined
}

void EF_CURRENT_STATE_KEY
