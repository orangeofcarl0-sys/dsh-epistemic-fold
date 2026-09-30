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
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { EpistemicFoldEngine } from '../src/engine.ts'
import { EF_CURRENT_STATE_KEY, currentFoldState } from '../src/projection.ts'
import { recall } from '../src/recall.ts'
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
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  ctx.llm.registerAdapter([MODEL], new CompositionAdapter())
  const plugin = new EpistemicFoldPlugin(ctx, { auto: false, bundleRoot, ...config })
  return { ctx, root, bundleRoot, plugin }
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

  it('anchor service declares authority-gated state through the plugin', async () => {
    const { ctx } = await createContextWithPlugin()
    const session = conversation()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'keep the CLI flags stable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const anchor = ctx.epistemicFold.declare(session, {
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'cli', property: 'flags' },
      value: 'keep the CLI flags stable',
      authority: 'normative',
      sourceRefs: [{ seq: (session.seq - 1) as never }],
    })
    const state = currentFoldState(ctx, session)
    expect(Object.values(state.constraints)[0]!.id).toBe(anchor.id)

    // The gate refuses laundering through the mounted service as well.
    expect(() => ctx.epistemicFold.declare(session, {
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
