/**
 * Paired continuation runner (R0-C2, work-order §9-§11): three arms —
 *   B1    DSH Basic (full-summary checkpoints)
 *   E3a0  EF state-only (semanticMode=none, zero LLM calls)
 *   E3aR  EF state + rationale-only auxiliary call
 * all starting from the SAME deterministic pre-boundary session, running the
 * scripted keyless continuation, and ending in machine-verified results.
 *
 * Keyless mode proves infrastructure determinism (work-order §10): identical
 * starting state, deterministic action capture, deterministic verifier.
 * The scripted continuation is NOT intelligence simulation — it exercises
 * the post-fold state/recall plumbing deterministically per arm.
 *
 * @module eval/paired-runner
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import SessionStore, { type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { EpistemicFoldEngine } from '../src/engine.ts'
import { createAnchorService } from '../src/anchor-service.ts'
import { registerEpistemicFoldProjection, currentFoldState } from '../src/projection.ts'
import { recall } from '../src/recall.ts'
import { emptyCurrentState } from '../src/state.ts'
import type { FoldCurrentState } from '../src/state.ts'
import { FileBundleStore } from '../src/bundle-store.ts'
import { evaluateOracles, type VerifierWorld } from './src/verifier.ts'
import { markDuplicates, normalizeAction } from './src/actions.ts'
import type { EvalRunResult } from './src/schema.ts'
import type { ScenarioDefinition } from './scenarios/index.ts'

export type ArmId = 'B1' | 'E3a0' | 'E3aR'

export const EVAL_ARMS: readonly ArmId[] = ['B1', 'E3a0', 'E3aR']

const MODEL = 'eval-model'
const SIGNAL = new AbortController().signal

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly compactionText: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: this.compactionText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.compactionText } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface MountedArm {
  readonly arm: ArmId
  readonly ctx: Context
  readonly engine: EpistemicFoldEngine | BasicCompactionEngine
  readonly anchors: ReturnType<typeof createAnchorService>
}

async function mountArm(arm: ArmId, bundleRoot: string): Promise<MountedArm> {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const compactionText = arm === 'B1'
    ? 'basic full checkpoint: the fixture work completed all four turns'
    : `rationale: the fixture work proceeded deterministically (${arm})`
  ctx.llm.registerAdapter([MODEL], new ScriptedAdapter(compactionText))

  const anchors = createAnchorService()
  const engine: EpistemicFoldEngine | BasicCompactionEngine = arm === 'B1'
    ? new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_048 })
    : new EpistemicFoldEngine(ctx, {
        auto: false,
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: 0,
        maxTokens: 2_048,
        semanticMode: arm === 'E3a0' ? 'none' : 'rationale',
        bundleRoot,
      })
  if (engine instanceof EpistemicFoldEngine) registerEpistemicFoldProjection(ctx)
  // Eval sessions are detached (built in-process, not store-live): the manual
  // durability checkpoint is observable through the flush record, mirroring
  // the DSH manual-compaction suite's flush spy.
  ctx.sessions.flush = async () => true
  return { arm, ctx, engine, anchors }
}

/** Seq of the LAST user message — the citable raw source for anchors. */
function lastUserMessageSeq(session: Session): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    if (session.eventAt(seq as never)!.type === 'user/message') return seq
  }
  return 0
}

/** Whether a seq is a user message (the gate needs a RAW authoritative kind). */
function isUserMessageSeq(session: Session, seq: number): boolean {
  return session.eventAt(seq as never)?.type === 'user/message'
}

/** Seq of the LAST assistant message — the citable hypothesis/decision source. */
function lastAssistantMessageSeq(session: Session): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    if (session.eventAt(seq as never)!.type === 'assistant/message') return seq
  }
  return 0
}

/** Seq of the LAST non-error tool result — the empirical evidence source. */
function lastSuccessfulToolResultSeq(session: Session): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { isError?: boolean } }).message
    if (message?.isError !== true) return seq
  }
  return 0
}

/** Surface checkpoint ids, parsed exclusively through the marker protocol. */
function checkpointIdsOf(session: Session): string[] {
  const ids: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null || message.role !== 'user') continue
    const source = (message as unknown as { source?: { kind?: string } }).source
    if (source?.kind !== 'compact-checkpoint') continue
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    const match = /id=([0-9a-f-]{36})/u.exec(text)
    if (match !== null) ids.push(match[1]!)
  }
  return ids
}

function verifiedFailureIds(session: Session): Set<string> {
  const ids = new Set<string>()
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type === 'ef/anchor' && (event.data as { failureState?: string }).failureState === 'verified') {
      ids.add((event.data as { anchorId: string }).anchorId)
    }
  }
  return ids
}

export interface PairedCaseOutcome {
  readonly caseId: string
  readonly results: Readonly<Record<ArmId, EvalRunResult>>
  readonly oracleVerdicts: Readonly<Record<ArmId, readonly { passed: boolean; detail: string }[]>>
}

/** Run one scenario across all three arms. */
export async function runPairedCase(scenario: ScenarioDefinition, replicate = 0): Promise<PairedCaseOutcome> {
  const results: Partial<Record<ArmId, EvalRunResult>> = {}
  const verdicts: Partial<Record<ArmId, readonly { passed: boolean; detail: string }[]>> = {}

  for (const arm of EVAL_ARMS) {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ef-eval-'))
    const mounted = await mountArm(arm, bundleRoot)
    const session = scenario.buildSession()
    const agent = { session, options: { provider: MODEL, model: MODEL } } as unknown as Agent

    // Pre-boundary anchors through the REAL authority gate. Declared BEFORE
    // the fold (they cite pre-boundary raw events), then the fold proves the
    // anchors SURVIVE it — that is the capability under test.
    const declareAnchors = (): void => {
      if (scenario.declareAnchors === undefined || !(mounted.engine instanceof EpistemicFoldEngine)) return
      scenario.declareAnchors(session, mounted.anchors, {
        seq: (offsetFromEnd: number) => ({
          seq: Math.max(0, session.seq - 1 - offsetFromEnd) as never,
        }),
        lastUser: () => {
          const seq = lastUserMessageSeq(session)
          if (!isUserMessageSeq(session, seq)) {
            throw new Error(`eval: scenario ${scenario.id} has no user message to cite (seq ${seq})`)
          }
          return seq
        },
        lastAssistant: () => lastAssistantMessageSeq(session),
        lastSuccessfulToolResult: () => lastSuccessfulToolResultSeq(session),
      })
    }
    declareAnchors()

    // The fold: same span for every arm (leaf over the leading balanced span,
    // or a manual root for root-mode scenarios).
    const nodes = [...session.surface.nodes]
    let foldResult: CompactionResult | null
    // Root/manual folds require NO open turn; leaf folds require one. The
    // fixtures leave a turn open, so root arms close it first (work-order:
    // the fold mode decides the admissible session shape).
    if (scenario.sidecar.fold.mode === 'root' || !(mounted.engine instanceof EpistemicFoldEngine)) {
      closeOpenTurn(session)
      foldResult = await mounted.engine.compactNow(idleAgent(session), SIGNAL)
    } else {
      foldResult = await mounted.engine.compactRegion(nodes[0]!, balancedLeafEnd(session, nodes), agent, SIGNAL)
    }

    // Scripted keyless continuation: identical stimulus + actions per arm.
    const continuationActions = []
    let actionIndex = 0
    const foldedIds = checkpointIdsOf(session)
    for (const stimulus of scenario.sidecar.continuation.input) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: stimulus }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      if (scenario.sidecar.recall.required) {
        for (const checkpointId of foldedIds) {
          continuationActions.push(normalizeAction({
            index: actionIndex,
            toolName: 'context_recall',
            target: `cp:${checkpointId}`,
            beforeEnvironment: 'eval-env',
            afterEnvironment: 'eval-env',
          }))
          actionIndex += 1
        }
      } else {
        continuationActions.push(normalizeAction({
          index: actionIndex,
          toolName: 'read',
          target: 'workspace/state',
          beforeEnvironment: 'eval-env',
          afterEnvironment: 'eval-env',
        }))
        actionIndex += 1
      }
      void stimulus
    }
    const markedActions = markDuplicates(continuationActions)

    // Recall the folded checkpoints into the verifier world.
    const recallTexts: Record<string, string> = {}
    let recallCalls = 0
    const store = mounted.engine instanceof EpistemicFoldEngine
      ? mounted.engine.bundleStore
      : new FileBundleStore(bundleRoot)
    for (const checkpointId of foldedIds) {
      const summary = await recall({ store, sessionId: session.id, checkpointId, depth: 'summary' })
      const chunks: string[] = []
      if (summary?.text !== undefined) {
        chunks.push(summary.text)
        recallCalls += 1
      }
      // Protocol §13: a recall-required case must recover facts that are NOT
      // on the active checkpoint surface — page the exact archive too.
      let offset: number | undefined = 0
      while (offset !== undefined) {
        const page = await recall({
          store,
          sessionId: session.id,
          checkpointId,
          depth: 'exact',
          offset,
          limit: 20,
        })
        if (page?.page === undefined) break
        recallCalls += 1
        for (const message of page.page.messages) {
          chunks.push(message.content.map(block => block.type === 'text' ? block.text : '').join(String.fromCharCode(10)))
        }
        offset = page.page.nextOffset
      }
      if (chunks.length > 0) recallTexts[checkpointId] = chunks.join(String.fromCharCode(10))
    }

    // Build the machine-verifier world from the ACTUAL post-fold state.
    const state: FoldCurrentState = mounted.engine instanceof EpistemicFoldEngine
      ? currentFoldState(mounted.ctx, session)
      : emptyCurrentState()
    const retiredIds = verifiedFailureIds(session)
    const world: VerifierWorld = {
      commandExitCodes: {},
      fileHashes: {},
      baselineFileHashes: {},
      existingPaths: new Set(),
      stateValues: Object.fromEntries(
        Object.entries(state.stateHeads).map(([key, anchor]) => [key, anchor.value]),
      ),
      activeAnchorIds: new Set([
        ...(state.objective !== undefined ? [state.objective.id] : []),
        ...Object.values(state.stateHeads).filter(a => a.lifecycle === 'active').map(a => a.id),
        ...Object.values(state.constraints).filter(a => a.lifecycle === 'active').map(a => a.id),
      ]),
      openFailureIds: new Set(Object.keys(state.openFailures)),
      retiredFailureIds: retiredIds,
      openObligationIds: new Set(Object.keys(state.openObligations)),
      recallTexts,
      crossSessionRecallAttempted: false,
      actions: markedActions.map(action => ({
        family: action.family,
        ...(action.target === undefined ? {} : { target: action.target }),
      })),
    }

    // Keyless tier scope (work-order §10): state-based oracles verify the EF
    // arms' architecture. The B1 arm has no EF state projection — its
    // checkpoint is opaque summary text — so those oracles are not
    // applicable and are reported as such rather than as failures.
    const applicable = mounted.engine instanceof EpistemicFoldEngine
      ? scenario.sidecar.oracle.success
      : scenario.sidecar.oracle.success.filter(oracle => !isEfOnlyOracle(oracle))
    // Protocol §13: a recall-required oracle names RECALL_TARGET; resolve it
    // to the folded checkpoint the run actually produced.
    const resolved = applicable.map(oracle =>
      oracle.type === 'recall-contains' && oracle.checkpointId === 'RECALL_TARGET'
        ? { ...oracle, checkpointId: foldedIds[0] ?? '' }
        : oracle)
    const evaluation = evaluateOracles(resolved, world)
    const duplicateActions = markedActions.filter(action => action.duplicate === true).length
    const promptTokens = harnessTokens(mounted.ctx, session)

    const raw: EvalRunResult = {
      runVersion: 1,
      caseId: scenario.id,
      arm,
      replicate,
      efCommit: process.env.EF_COMMIT ?? 'dev',
      dshCommit: '477b4f420553e8a52c2fbccc464d7561b239c443',
      model: MODEL,
      success: evaluation.passed,
      correctness: { criticalViolations: evaluation.failures.filter(failure => failure.includes('forbidden-path-unchanged')) },
      context: {
        promptTokensTotal: promptTokens,
        peakPromptTokens: promptTokens,
        p95PromptTokens: promptTokens,
        sharedPrefixTokensTotal: 0,
        invalidatedSuffixTokensTotal: foldResult?.shadowedTokenCount ?? 0,
        reclaimedTokensTotal: foldResult?.shadowedTokenCount ?? 0,
      },
      behavior: {
        actions: markedActions.length,
        duplicateActions,
        duplicateWorkRate: markedActions.length === 0 ? 0 : duplicateActions / markedActions.length,
        recallCalls,
      },
    }
    results[arm] = raw
    verdicts[arm] = evaluation.verdicts
    void randomUUID
  }

  return {
    caseId: scenario.id,
    results: results as Record<ArmId, EvalRunResult>,
    oracleVerdicts: verdicts as Record<ArmId, readonly { passed: boolean; detail: string }[]>,
  }
}

/**
 * Largest balanced leaf-fold end for the fixture shape (each closed turn
 * contributes 3 surface nodes: user, assistant, and — when the turn has a
 * tool call — the result). Keeps the span inside the closed history.
 */
/**
 * The last surface node that is a BALANCED fold boundary: walk left from the
 * tail until the tool-pairing check passes (a step must not be split and the
 * trailing open turn must stay outside the span).
 */
function balancedLeafEnd(session: Session, nodes: readonly SessionSeq[]): SessionSeq {
  // The transaction's own balance rule decides the end boundary: walk left
  // from the tail (excluding the fixture's open turn) until it accepts.
  for (let index = nodes.length - 2; index >= 1; index -= 1) {
    const seq = nodes[index]!
    if (toolPairingBalancedBefore(session, seq) && toolPairingBalancedAfter(session, seq)) {
      return seq
    }
  }
  return nodes[0]!
}

/** Oracles that only an EF-state arm can satisfy. */
function isStateOracle(type: string): boolean {
  return type === 'anchor-active'
    || type === 'state-key-equals'
    || type === 'failure-open'
    || type === 'failure-retired'
    || type === 'obligation-open'
    // EF checkpoint recovery: Basic checkpoints carry no EF bundle, so
    // exact/structured recall of EF checkpoint ids is EF-arm-only.
    || type === 'recall-contains'
}

/** Oracle types that only an EF arm can satisfy (recall tooling). */
function isEfOnlyOracle(oracle: { type: string; family?: string }): boolean {
  return isStateOracle(oracle.type)
    || (oracle.type === 'tool-action-present' && oracle.family === 'recall')
}

/** Close the fixture's trailing open turn so idle folds are admissible. */
function closeOpenTurn(session: Session): void {
  let openTurn: number | null = null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type === 'turn/end') return
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      break
    }
  }
  if (openTurn !== null) {
    session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  }
}

function harnessTokens(ctx: Context, session: Session): number {
  return ctx.tokenMeter.measure(session).totalTokens
}

function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(SIGNAL),
  } as unknown as Agent
}
