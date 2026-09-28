/**
 * R1-B workloads: the five shapes docs/11 §6 requires before any conclusion
 * about "what context costs" can be trusted.
 *
 * R0-C's fixture grew one narrative turn per step, which proves that frozen
 * checkpoints charge a recurring cost but cannot show whether that cost is
 * *dominant*. A workload that only appends prose will always make prose look
 * like the main expense. These five workloads differ in what they stress:
 *
 *   W1 narrative-heavy   long prose trajectory (the R0-C baseline)
 *   W2 state-rich        many constraint/value/decision/supersession anchors
 *   W3 tool-heavy        large tool results (read/grep/test/build shaped)
 *   W4 recall-heavy      old folded material becomes relevant again
 *   W5 multi-agent       child-agent reports folded back into the parent
 *
 * Every workload is deterministic and keyless. Each `grow` runs INSIDE the
 * turn the runner opened, closes any step it opened, and leaves the turn open
 * (the pressure fold needs an open turn); turn lifecycle stays owned by the
 * runner.
 *
 * @module eval/workloads
 */

import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EventRef } from '../../src/state.ts'

const MODEL = 'workload-model'

/**
 * The provider/model every workload fixture routes to. Exported so a test
 * harness can register an adapter for it — a workload whose routed provider
 * has no adapter fails every fold, which would silently report zero cost.
 */
export const WORKLOAD_MODEL = MODEL

/** One workload definition; drives `runPairedBaseline` unchanged. */
export interface Workload {
  readonly id: string
  readonly label: string
  /** What cost this workload is designed to expose. */
  readonly purpose: string
  /** Fresh, identical starting history for each arm. */
  readonly createSession: () => Session
  /** Append one step of new history; the runner owns turn lifecycle. */
  readonly grow: (session: Session, step: number) => void
  /**
   * Anchors to declare for this step, if any. Runs after `grow` so an anchor
   * can cite the events the step just appended (provenance is mandatory).
   */
  readonly declareState?: (session: Session, step: number) => void
}

/** Deterministic prose of a requested size. */
function prose(tag: string, step: number, sentences: number): string {
  const unit = `${tag} step ${step} analysis `.repeat(12)
  return Array.from({ length: sentences }, (_, index) => `${unit}segment ${index}`).join('. ')
}

/** A tool result body of `lines` lines. */
function toolBody(tag: string, step: number, lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `${tag} line ${index} of step ${step}: ${'payload '.repeat(6)}`,
  ).join('\n')
}

/**
 * One model step inside the runner's open turn: opens a step, appends the
 * assistant message, closes the step. Closing matters — the token meter
 * refuses a `step/start` while a previous step is still open.
 */
function appendModelStep(
  session: Session,
  turn: number,
  step: number,
  content: ContentBlock[],
): void {
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

/** Append a user message plus one plain assistant reply. */
function growConversational(session: Session, step: number, tag: string, sentences: number): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${step}: ${prose(tag, step, sentences)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendModelStep(session, step, step, [{ type: 'text', text: `assistant ${step}: ${prose(tag, step, sentences)}` }])
}

/** Append a user message, one tool-calling model step, and the tool result. */
function growToolStep(
  session: Session,
  step: number,
  options: {
    readonly prompt: string
    readonly tool: string
    readonly args: Record<string, unknown>
    readonly resultText: string
    readonly isError?: boolean
  },
): void {
  const callId = ToolCallId(`call-${step}-${options.tool}`)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: options.prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendModelStep(session, step, step, [
    { type: 'text', text: `calling ${options.tool}` },
    { type: 'tool-call', id: callId, name: options.tool, arguments: JSON.stringify(options.args) },
  ])
  session.append('tool/call', {
    turn: step,
    step,
    callId,
    name: options.tool,
    arguments: JSON.stringify(options.args),
  })
  session.append('tool/result', {
    turn: step,
    step,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: options.resultText }],
      isError: options.isError ?? false,
    }),
  }, { surfaceOp: 'append' })
}

/** Seed history: `turns` closed turns, the first carrying the routed header. */
function seed(label: string, turns: number, tag: string): Session {
  const session = Session.create(SessionId(`ef-wl-${label}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `seed ${turn}: ${prose(tag, turn, 2)}` }],
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
        content: [{ type: 'text', text: `seed reply ${turn}: ${prose(tag, turn, 2)}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Seq of the last event of `type`, or 0 when none exists. */
function lastSeqOfType(session: Session, type: string): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    if (session.eventAt(seq as never)?.type === type) return seq
  }
  return 0
}

// ---------------------------------------------------------------------------
// W1 — narrative-heavy
// ---------------------------------------------------------------------------

export function narrativeHeavy(turns = 4): Workload {
  return {
    id: 'W1-narrative-heavy',
    label: 'W1 narrative-heavy',
    purpose: 'Long prose trajectory — the R0-C baseline, for continuity of comparison.',
    createSession: () => seed('w1', turns, 'narrative'),
    grow: (session, step) => growConversational(session, step, 'narrative', 4),
  }
}

// ---------------------------------------------------------------------------
// W2 — state-rich
// ---------------------------------------------------------------------------

const W2_PROPERTIES = ['public-api', 'dependencies', 'logging', 'timeout-policy', 'retry-policy']

/**
 * W2 declares real anchors each step through the sanctioned gate: a normative
 * constraint cited to the user message, plus a decision value at a STABLE
 * state key whose successor supersedes its predecessor. This is what makes
 * the checkpoint's machine-state payload — not its narrative — the thing
 * being measured, and it exercises supersession (the reducer must retire the
 * replaced head from every face).
 *
 * Prose stays deliberately small: if the state payload is expensive, this
 * workload makes that visible instead of hiding it behind a large narrative.
 */
export function stateRich(turns = 4): Workload {
  return {
    id: 'W2-state-rich',
    label: 'W2 state-rich',
    purpose: 'Many constraint/decision anchors with supersession, so leaf checkpoints carry real machine state.',
    createSession: () => seed('w2', turns, 'state'),
    grow: (session, step) => growConversational(session, step, 'state', 1),
    declareState: (session, step) => {
      const property = W2_PROPERTIES[step % W2_PROPERTIES.length]!
      session.append('ef/anchor', {
        op: 'declare',
        anchor: {
          id: `W2-constraint-${step}`,
          kind: 'constraint',
          stateKey: { namespace: 'policy', entity: 'service', property },
          value: `constraint ${property} set at step ${step}`,
          authority: 'normative',
          lifecycle: 'active',
          sourceRefs: [{ seq: lastSeqOfType(session, 'user/message') } as EventRef],
        },
      })
      // Same state key each step: the reducer replaces the previous head and
      // counts it as retired, so the head count stays bounded.
      session.append('ef/anchor', {
        op: 'declare',
        anchor: {
          id: `W2-batch-size-${step}`,
          kind: 'value',
          stateKey: { namespace: 'config', entity: 'worker', property: 'batch-size' },
          value: 100 + step,
          authority: 'decision',
          lifecycle: 'active',
          sourceRefs: [{ seq: lastSeqOfType(session, 'assistant/message') } as EventRef],
        },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// W3 — tool-heavy
// ---------------------------------------------------------------------------

/** Tool families a coding agent actually uses, with their output shapes. */
const W3_TOOLS = ['read', 'grep', 'test', 'build'] as const

/**
 * W3 emits realistic large tool results (a file read, a grep sweep, a test
 * run, a build log). This is the workload that answers whether tool output is
 * the real cost driver — the question an M1 tool-result oracle arm needs.
 */
export function toolHeavy(turns = 3, linesPerResult = 60): Workload {
  return {
    id: 'W3-tool-heavy',
    label: 'W3 tool-heavy',
    purpose: 'Large read/grep/test/build results, to test whether tool output dominates context cost.',
    createSession: () => seed('w3', turns, 'tooling'),
    grow: (session, step) => {
      const tool = W3_TOOLS[step % W3_TOOLS.length]!
      growToolStep(session, step, {
        prompt: `user ${step}: run ${tool}`,
        tool,
        args: { target: `src/mod-${step}.ts` },
        resultText: toolBody(`${tool} output`, step, linesPerResult),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// W4 — recall-heavy
// ---------------------------------------------------------------------------

/**
 * W4 models the shape that makes recall valuable: mostly small steps, with a
 * periodic re-examination of material folded long ago. Recall is expressed as
 * a real `context_recall` tool call plus its returned page, so its cost is
 * measured through the same path a model's own recall would take rather than
 * simulated as a number.
 */
export function recallHeavy(turns = 4, everyNSteps = 4): Workload {
  return {
    id: 'W4-recall-heavy',
    label: 'W4 recall-heavy',
    purpose: 'Folded material becomes relevant again; measures what recall costs when it is actually used.',
    createSession: () => seed('w4', turns, 'recall'),
    grow: (session, step) => {
      if (step % everyNSteps !== 0) {
        growConversational(session, step, 'recall', 1)
        return
      }
      growToolStep(session, step, {
        prompt: `user ${step}: what did we decide earlier about the parser?`,
        tool: 'context_recall',
        args: { ref: 'cp:earlier', depth: 'exact' },
        resultText: `recalled page:\n${toolBody('recall', step, 30)}`,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// W5 — multi-agent
// ---------------------------------------------------------------------------

/**
 * W5 models a parent agent delegating to children and folding their reports
 * back in. Child reports are tool results on the parent's surface, so this
 * workload sizes delegation payload cost — the shape M4 and hard-handoff
 * decisions depend on.
 */
export function multiAgent(turns = 3, reportLines = 40): Workload {
  return {
    id: 'W5-multi-agent',
    label: 'W5 multi-agent',
    purpose: 'Child-agent reports folded into the parent, to size delegation payload cost.',
    createSession: () => seed('w5', turns, 'delegation'),
    grow: (session, step) => {
      const child = `child-${step % 3}`
      growToolStep(session, step, {
        prompt: `user ${step}: delegate the ${child} workstream`,
        tool: 'delegate',
        args: { agent: child },
        resultText: `child ${child} report (step ${step}):\n${toolBody('child-report', step, reportLines)}`,
      })
    },
  }
}

/** Every workload, in docs/11 §6 order. */
export function allWorkloads(): readonly Workload[] {
  return [narrativeHeavy(), stateRich(), toolHeavy(), recallHeavy(), multiAgent()]
}
