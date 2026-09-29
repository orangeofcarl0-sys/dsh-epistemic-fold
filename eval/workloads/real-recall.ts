/**
 * R4-A: W4R — REAL recall workloads.
 *
 * R3's `W4-recall-heavy` does not test recall. It appends a tool call whose
 * ref is the literal string `cp:earlier` — which is NOT a bundle checkpoint —
 * and whose "result" is 30 synthetic lines generated inline. No
 * `FoldBundleStore`, no `context_search`, no `context_recall`, no `RecallPage`
 * is involved anywhere.
 *
 * So R3's finding ("Basic recall 25 434 vs EF 33 533") only supports the claim
 * that *recall-shaped tool results* are carried more expensively on an EF
 * surface. It does NOT support the claim that **real** recall is what produces
 * the remaining 0.2%. Acting on the second claim would be building a mechanism
 * for a problem that has not been measured.
 *
 * This module supplies the two experiments R4 §7 requires, because they answer
 * different questions and must not be conflated:
 *
 * **W4R-COMMON** — both arms receive BYTE-IDENTICAL recall materialization from
 * a benchmark-owned archive, through the same tool. Only the arms' policies
 * differ. This is the fair PRICE benchmark: it measures what carrying the same
 * recalled material costs under each policy.
 *
 * **W4R-NATIVE** — only EF runs, and it runs the REAL product chain end to end:
 * real fold → real `CheckpointBundle` → real `cp:<uuid>` → `context_search` →
 * `context_recall` → real `RecallPage`, all dispatched through `ctx.tools` so
 * the measured cost includes tool schema, JSON rendering, call/result pairing,
 * and true tool-result lifecycle. This validates the product, not a price
 * ratio.
 *
 * @module eval/workloads/real-recall
 */

import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EventRef } from '../../src/state.ts'
import { EXACT_PAGE_LIMIT } from '../../src/recall.ts'

const MODEL = 'workload-model'

/**
 * The archive W4R-COMMON recalls from: ONE immutable payload, materialized
 * identically into both arms. Keeping it owned by the benchmark (rather than
 * produced by EF's own fold) is what makes the comparison a price comparison
 * instead of a comparison of two different archives.
 */
export interface SharedRecallArchive {
  /** The archived conversation, as exact messages. */
  readonly messages: readonly string[]
  /** How many messages one exact page returns. */
  readonly pageSize: number
}

/** Deterministic archived payload: plausible engineering history, not filler. */
export function sharedArchive(pages = 3): SharedRecallArchive {
  const messages: string[] = []
  for (let index = 0; index < pages * EXACT_PAGE_LIMIT; index += 1) {
    messages.push(
      `archived message ${index}: the parser rewrite touched `
      + `${['lexer', 'grammar', 'emitter', 'diagnostics', 'source-map'][index % 5]} `
      + `and recorded decision D-${100 + index} with rationale ${'detail '.repeat(12)}`,
    )
  }
  return { messages, pageSize: EXACT_PAGE_LIMIT }
}

/**
 * The exact page a given offset materializes, rendered the way the tool
 * renders it. Both arms call this, so both receive identical bytes.
 */
export function materializePage(
  archive: SharedRecallArchive,
  offset: number,
): { ref: string; offset: number; nextOffset?: number; lines: readonly string[] } {
  const slice = archive.messages.slice(offset, offset + archive.pageSize)
  const next = offset + archive.pageSize
  return {
    ref: 'cp:shared-archive',
    offset,
    ...(next < archive.messages.length ? { nextOffset: next } : {}),
    lines: slice,
  }
}

/** JSON rendering of one page, mirroring what the recall tool returns. */
export function renderPage(page: ReturnType<typeof materializePage>): string {
  return `recalled page:\n${page.lines.map(line => `- ${line}`).join('\n')}`
}

/** Appends one model step inside the runner's open turn. */
function appendModelStep(
  session: Session,
  turn: number,
  step: number,
  content: Parameters<typeof createMessage>[0]['content'],
): void {
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: MODEL, model: MODEL } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

/**
 * Append one recall step whose RESULT is supplied by the caller.
 *
 * The tool name and call shape are identical across arms; only the materialized
 * result differs, and for W4R-COMMON it does not differ at all.
 */
function growRecallStep(
  session: Session,
  step: number,
  options: { readonly ref: string; readonly depth: string; readonly resultText: string },
): void {
  const callId = ToolCallId(`recall-${step}`)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${step}: what did we decide earlier about the parser?` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendModelStep(session, step, step, [
    { type: 'text', text: 'Recalling the archived parser discussion.' },
    { type: 'tool-call', id: callId, name: 'context_recall', arguments: JSON.stringify({ ref: options.ref, depth: options.depth }) },
  ])
  session.append('tool/call', {
    turn: step, step, callId, name: 'context_recall',
    arguments: JSON.stringify({ ref: options.ref, depth: options.depth }),
  })
  session.append('tool/result', {
    turn: step,
    step,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: options.resultText }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

/** Seed history shared by both W4R-COMMON arms. */
function seed(label: string): Session {
  const session = Session.create(SessionId(`ef-w4r-${label}`))
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `seed ${turn}: ${'context '.repeat(80)}` }],
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
        content: [{ type: 'text', text: `seed reply ${turn}: ${'ack '.repeat(60)}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  return session
}

/**
 * W4R-COMMON: the fair price benchmark.
 *
 * Every arm gets the SAME archive, the SAME page size, the SAME call frequency
 * and byte-identical materialized results. Only the fold policy differs, so the
 * resulting cost ratio is attributable to the policy and nothing else.
 */
export function realRecallCommon(options: { readonly everyNSteps?: number; readonly pages?: number } = {}) {
  const everyNSteps = options.everyNSteps ?? 4
  const archive = sharedArchive(options.pages ?? 3)
  return {
    id: 'W4R-common',
    label: 'W4R common-materialization recall',
    purpose:
      'Identical recalled bytes in both arms; isolates the cost of CARRYING the same '
      + 'recall materialization under each policy. This is the price benchmark.',
    archive,
    createSession: () => seed('common'),
    grow: (session: Session, step: number) => {
      if (step % everyNSteps !== 0) {
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `user ${step}: routine check ${'note '.repeat(40)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        appendModelStep(session, step, step, [{ type: 'text', text: `acknowledged ${step}` }])
        return
      }
      // Which page is materialized depends only on how many recalls happened,
      // so every arm materializes the same sequence of pages.
      const pageIndex = Math.floor(step / everyNSteps) - 1
      const offset = (pageIndex % Math.ceil(archive.messages.length / archive.pageSize)) * archive.pageSize
      const page = materializePage(archive, offset)
      growRecallStep(session, step, {
        ref: page.ref,
        depth: 'exact',
        resultText: renderPage(page),
      })
    },
  }
}

/**
 * W4R-NATIVE: the real product chain, EF arms only.
 *
 * NOT a price-ratio benchmark against Basic — Basic has no bundles to recall
 * from, so a ratio here would compare EF's real chain against nothing. What it
 * measures is whether the chain WORKS and what it costs in absolute terms:
 * search finds the checkpoint, exact recall restores the page, re-recall works,
 * and the returned tokens are attributable.
 */
export function realRecallNative(options: { readonly everyNSteps?: number } = {}) {
  const everyNSteps = options.everyNSteps ?? 4
  return {
    id: 'W4R-native',
    label: 'W4R native Bundle-backed recall',
    purpose:
      'Real fold → Bundle → cp:<uuid> → context_search → context_recall → RecallPage, dispatched '
      + 'through ctx.tools. Validates the product chain and its true materialized cost.',
    createSession: () => seed('native'),
    /** Placeholder grow: the native driver replaces it once a checkpoint exists. */
    grow: (session: Session, step: number) => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `user ${step}: routine check ${'note '.repeat(40)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      appendModelStep(session, step, step, [{ type: 'text', text: `acknowledged ${step}` }])
    },
    everyNSteps,
  }
}

/** A fact planted for the native chain to recover, with its grounding ref. */
export interface NativeRecallFact {
  readonly plant: string
  readonly anchor: {
    readonly kind: 'constraint' | 'value'
    readonly authority: 'normative' | 'decision'
    readonly value: unknown
    readonly stateKey: { readonly namespace: string; readonly entity: string; readonly property: string }
  }
  /** A distinctive token that must survive into the recalled page. */
  readonly marker: string
}

/** The single fact W4R-NATIVE folds away and then recovers by exact recall. */
export const NATIVE_FACT: NativeRecallFact = {
  plant:
    'Hard constraint for the parser work: keep diagnostic code PARSE-7741 stable, because downstream '
    + 'tooling matches on it exactly. This must not be renamed or renumbered.',
  marker: 'PARSE-7741',
  anchor: {
    kind: 'constraint',
    authority: 'normative',
    value: 'diagnostic code PARSE-7741 must stay stable',
    stateKey: { namespace: 'scope', entity: 'parser', property: 'diagnostic-code' },
  },
}

/** The seq of the last event of a type, for provenance refs. */
export function lastSeqOfType(session: Session, type: string): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    if (session.eventAt(seq as never)?.type === type) return seq
  }
  return 0
}

/** Cite the planted user message as the fact's normative source. */
export function nativeFactRefs(session: Session): readonly EventRef[] {
  return [{ seq: lastSeqOfType(session, 'user/message') } as EventRef]
}
