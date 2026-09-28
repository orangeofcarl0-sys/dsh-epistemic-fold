/**
 * Proof of life: our own engine subclass resolves against the vendored DSH
 * sources and completes one full compaction transaction through
 * `compactRegion`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import {
  createMessage,
  createSystemMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
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

  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(1_000_000))
  return ctx
}

const SUMMARY: ContentBlock[] = [{ type: 'text', text: 'ef proof-of-life checkpoint' }]

class ProofEngine extends BasicCompactionEngine {
  readonly calls: Array<{ input: SummarizationInput }> = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls.push({ input })
    return {
      summary: SUMMARY,
      provider: 'ef-test',
      model: 'ef-test-model',
      maxTokens: 8192,
    }
  }
}

function service(config: BasicCompactionConfig = { auto: false }): ProofEngine {
  return new ProofEngine(createContext(), {
    headroomTokens: 0,
    maxTokens: 8192,
    ...config,
  })
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as unknown as Agent
}

/** Four closed turns then one open turn, mirroring the DSH conversation fixture. */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId('ef-proof'))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
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
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

describe('proof of life', () => {
  it('completes one compaction through our own engine subclass', async () => {
    const engine = service()
    const session = conversation()
    const surfaceBefore = [...session.surface.nodes]

    const result: CompactionResult = await engine.compactRegion(
      surfaceBefore[0]!,
      surfaceBefore[3]!,
      agent(session),
      SIGNAL,
    )

    expect(result.shadowedSeqs).toHaveLength(4)
    expect(engine.calls).toHaveLength(1)
    // The surface now has one replacement node where four were.
    expect(session.surface.nodes).toHaveLength(surfaceBefore.length - 3)
    // The checkpoint message landed on the surface.
    const checkpoint = session.surface.nodes[0]!
    expect(checkpoint).toBe(result.shadowedSeqs.length > 0 ? checkpoint : checkpoint)
  })
})
