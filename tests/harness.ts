/**
 * Shared M0 test harness: context assembly and conversation fixtures,
 * mirroring the DSH compaction-basic suite's patterns. The semantic face is
 * controlled at the LlmAdapter boundary so every test drives the REAL chain:
 * EF compiler → Basic summarize → LlmRuntime → adapter.
 */

import { Context } from '@deepseek-ai/cordis'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBundleStore } from '../src/bundle-store.ts'
import { EpistemicFoldEngine } from '../src/engine.ts'
import type { FoldBundleStore } from '../src/types.ts'

export const MODEL = 'test-model'
export const SIGNAL = new AbortController().signal

/** Behavior of the adapter for the `compaction`-purpose semantic call. */
export interface SemanticFace {
  /** Text the model writes; absent → empty output (Basic throws → fallback). */
  text?: string
  /** Error the model call finishes with; forces the deterministic fallback. */
  failure?: { kind: 'error' | 'max-tokens'; message: string }
  /** Runs once the semantic stream starts (surface perturbation, T03). */
  mutate?: () => void
  /** Holds the semantic stream open until released (in-flight locking, T20). */
  gate?: Promise<void>
}

export interface HarnessControl {
  readonly semantic: SemanticFace
  /** Every compaction-purpose call the adapter received. */
  readonly calls: Array<{ purpose: string | undefined; options: GenerateOptions }>
}

export interface Harness {
  readonly ctx: Context
  readonly engine: EpistemicFoldEngine
  readonly store: FoldBundleStore
  readonly root: string
  readonly control: HarnessControl
}

class ControlledAdapter extends LlmAdapter {
  constructor(
    private readonly contextWindow: number,
    private readonly control: HarnessControl,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== 'compaction') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.control.calls.push({ purpose: options.purpose, options })
    this.control.semantic.mutate?.()
    if (this.control.semantic.gate !== undefined) {
      await this.control.semantic.gate
    }
    if (this.control.semantic.failure !== undefined) {
      const { kind, message } = this.control.semantic.failure
      yield {
        type: 'finish',
        reason: kind === 'max-tokens'
          ? { kind: 'max-tokens' }
          : { kind: 'error', failure: { message, code: 'TEST_FAILURE' } },
      }
      return
    }
    const text = this.control.semantic.text
    if (text !== undefined && text.length > 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Assemble one engine over a fresh temp bundle directory. */
export async function createHarness(
  semantic: SemanticFace = {},
  options: { contextWindow?: number; efConfig?: { thresholdRatio?: number; headroomTokens?: number; retainTokens?: number; maxTokens?: number; frozenCheckpointTokenBudget?: number } } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ef-m0-'))
  const store = new FileBundleStore(root)
  const control: HarnessControl = { semantic, calls: [] }
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  // Detached test sessions are not store-live; manual compaction's durability
  // checkpoint is observable through the flush record (mirrors the DSH
  // manual-compaction suite's flush spy).
  const flushes: string[] = []
  ctx.sessions.flush = async (session: Session) => {
    flushes.push(session.id)
    return true
  }
  ctx.llm.registerAdapter([MODEL], new ControlledAdapter(options.contextWindow ?? 1_000_000, control))
  const engine = new EpistemicFoldEngine(ctx, options.efConfig ?? {}, { bundleStore: store })
  return { ctx, engine, store, root, control }
}

export function foldAgent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as unknown as Agent
}

const TEXT = 'fixture '.repeat(40).trim()

/** Unique session ids so per-session bundle directories never collide. */
let sessionCounter = 0

/** N closed text turns, then one open turn — the automatic-leaf fixture. */
export function conversation(turns = 4): Session {
  const session = Session.create(SessionId(`ef-m0-conversation-${++sessionCounter}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${TEXT} user ${turn}` }],
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
        content: [{ type: 'text', text: `${TEXT} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Three closed tool-using turns, then one open turn — the pairing fixture. */
export function toolConversation(turns = 3): Session {
  const session = Session.create(SessionId(`ef-m0-tools-${++sessionCounter}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} ${TEXT}` }],
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
        content: [
          { type: 'text', text: `calling ${turn} ${TEXT}` },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} ${TEXT}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** N closed turns with NO open tail — the idle-session (manual/root) fixture. */
export function closedConversation(turns = 4): Session {
  const session = Session.create(SessionId(`ef-m0-closed-${++sessionCounter}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${TEXT} user ${turn}` }],
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
        content: [{ type: 'text', text: `${TEXT} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** An idle-agent stub with Basic's runMaintenance contract (manual path). */
export function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(SIGNAL)
    },
  } as unknown as Agent
}
export function surfaceMessages(session: Session, seqs: readonly number[]): Message[] {
  return seqs
    .map(seq => session.deriveEventMessage(session.eventAt(seq as never)!))
    .filter((message): message is Message => message !== null)
}

/** Extract the checkpoint id embedded in rendered EF checkpoint text. */
export function extractCheckpointId(text: string): string | null {
  return /cp:([0-9a-f-]{36})/u.exec(text)?.[1] ?? null
}

/** Latest committed `compaction/summary` event data, scanning the log tail. */
export function lastCompactionSummary(session: Session): { summary: unknown[]; shadowedSeqs: number[] } | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)
    if (event?.type === 'compaction/summary') {
      return event.data as unknown as { summary: unknown[]; shadowedSeqs: number[] }
    }
  }
  return undefined
}

/** Latest committed `compaction/end` event data (error field present on failure). */
export function lastCompactionEnd(session: Session): { error?: string } | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)
    if (event?.type === 'compaction/end') {
      return event.data as unknown as { error?: string }
    }
  }
  return undefined
}
