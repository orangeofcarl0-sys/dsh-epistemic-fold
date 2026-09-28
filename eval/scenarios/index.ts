/**
 * R0-C1 hard-gate boundary corpus (B01-B12): keyless, process-internal
 * scenarios. Each case = deterministic pre-boundary Session + sidecar +
 * machine oracles + scripted keyless continuation. No provider credentials.
 *
 * The Session fixtures are built programmatically with the same event
 * vocabulary the DSH Session uses; per work-order §6 the DSH
 * session-snapshot formats remain the canonical serialization — these
 * builders are the in-process adapter for the keyless tier.
 *
 * @module eval/scenarios
 */

import { createUserMessage, createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AnchorService } from '../../src/anchor-service.ts'
import type { EventRef } from '../../src/state.ts'
import type { BoundaryCase } from '../src/schema.ts'

const MODEL = 'eval-model'
const TEXT = 'work item '.repeat(14)

/** One closed turn of fixture conversation. */
function closedTurn(session: Session, turn: number, body: string, withHeader = false, toolCall?: { callId: ToolCallId; failed: boolean }): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${TEXT} user ${turn}: ${body}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (withHeader) {
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
  }
  if (toolCall !== undefined) {
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `running ${toolCall.callId} ${TEXT}` },
          { type: 'tool-call', id: toolCall.callId, name: 'test', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId: toolCall.callId, name: 'test', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: toolCall.callId,
        content: [{
          type: 'text',
          text: toolCall.failed
            ? `Error: 2 tests failed
${TEXT}
${TEXT}`
            : `all tests pass
${TEXT}
${TEXT}`,
        }],
        isError: toolCall.failed,
      }),
    }, { surfaceOp: 'append' })
  } else {
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${TEXT} assistant ${turn}: done with ${body}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Four closed turns with a routed header, plus a fresh open turn. */
export function baseConversation(label: string, turns = 4): Session {
  const session = Session.create(SessionId(`ef-eval-${label.replace(/[^a-zA-Z0-9._-]+/gu, '-')}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    closedTurn(session, turn, `${label} work`, turn === 1)
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Citable raw sources resolved against the pre-boundary session. */
export interface ScenarioSequences {
  /** The LAST user message — grounded normative source. */
  readonly lastUser: () => number
  /** The LAST assistant message — the hypothesis/decision source. */
  readonly lastAssistant: () => number
  /** The LAST successful tool result — the empirical evidence source. */
  readonly lastSuccessfulToolResult: () => number
  /** Any event seq by raw log offset (for tool results etc.). */
  readonly seq: (offsetFromEnd: number) => EventRef
}

export interface ScenarioDefinition {
  readonly id: string
  readonly sidecar: BoundaryCase
  /** Build the pre-boundary session (fresh per arm). */
  readonly buildSession: () => Session
  /** Anchors declared through the REAL authority gate before the fold. */
  readonly declareAnchors?: (session: Session, service: AnchorService, seqs: ScenarioSequences) => void
}

/** Scenario inputs, with the boilerplate defaults applied by {@link scenario}. */
interface ScenarioInput {
  readonly id: string
  readonly workload: BoundaryCase['workload']
  readonly tier: BoundaryCase['tier']
  readonly boundaryLabel: string
  readonly foldMode: BoundaryCase['fold']['mode']
  readonly continuation: readonly string[]
  readonly oracles: BoundaryCase['oracle']['success']
  readonly buildSession: () => Session
  readonly maxActions?: number
  readonly duplicateRules?: BoundaryCase['behavior']['duplicateRules']
  readonly recallRequired?: boolean
  readonly capabilities: readonly string[]
  readonly declareAnchors?: ScenarioDefinition['declareAnchors']
}

/**
 * Build one boundary scenario, applying the corpus-wide defaults (version,
 * session role, fold target, behavior rules, recall flag) so each definition
 * states only what is specific to it.
 */
function scenario(input: ScenarioInput): ScenarioDefinition {
  return {
    id: input.id,
    sidecar: {
      version: 1,
      id: input.id,
      workload: input.workload,
      tier: input.tier,
      source: { sessionRole: 'parent', boundaryLabel: input.boundaryLabel },
      fold: { mode: input.foldMode, target: input.foldMode === 'root' ? 'full-history' : 'oldest-safe-span' },
      continuation: { input: [...input.continuation], maxActions: input.maxActions ?? 4 },
      oracle: { success: [...input.oracles] },
      behavior: { duplicateRules: input.duplicateRules ?? [] },
      recall: { required: input.recallRequired ?? false },
      classification: { expectedCapability: [...input.capabilities] },
    },
    buildSession: input.buildSession,
    ...(input.declareAnchors === undefined ? {} : { declareAnchors: input.declareAnchors }),
  }
}

// ---------------------------------------------------------------------------
// B01-B12
// ---------------------------------------------------------------------------

const b01 = scenario({
  id: 'B01-explicit-api-constraint',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'before-shortcut-task',
  foldMode: 'leaf',
  continuation: ['Implement the faster shortcut.'],
  oracles: [{ type: 'anchor-active', anchorId: 'B01-constraint' },
      { type: 'state-key-equals', stateKey: 'scope/work/public-api', value: 'do not change the public API' }],
  buildSession: () => baseConversation('b01'),
  maxActions: 6,
  duplicateRules: [{ family: 'read' }, { family: 'test' }],
  capabilities: ['constraint-retention'],
  declareAnchors: (session, service, seqs) => {
    service.declare(session, {
      id: 'B01-constraint',
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
      value: 'do not change the public API',
      authority: 'normative',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
  },
})

const b02 = scenario({
  id: 'B02-superseded-timeout',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-second-value',
  foldMode: 'leaf',
  continuation: ['Apply the current timeout.'],
  oracles: [{ type: 'state-key-equals', stateKey: 'config/server/timeout', value: 60 }],
  buildSession: () => baseConversation('b02', 3),
  duplicateRules: [{ family: 'read' }],
  capabilities: ['current-state-singularity'],
  declareAnchors: (session, service, seqs) => {
    const timeout = { namespace: 'config', entity: 'server', property: 'timeout' }
    service.declare(session, {
      id: 'B02-timeout-30',
      kind: 'value', stateKey: timeout, value: 30, authority: 'normative',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
    service.declare(session, {
      id: 'B02-timeout-60',
      kind: 'value', stateKey: timeout, value: 60, authority: 'normative',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
  },
})

const b03 = scenario({
  id: 'B03-evidence-vs-narrative',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-failed-tests',
  foldMode: 'leaf',
  continuation: ['Continue and report test status.'],
  oracles: [{ type: 'failure-open', failureId: 'failure:call-2' }],
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b03'))
    closedTurn(session, 1, 'run the suite', true)
    closedTurn(session, 2, 'run the suite again', true, { callId: ToolCallId('call-2'), failed: true })
    closedTurn(session, 3, 'probably fixed by now', true)
    session.append('turn/start', { turn: 4 })
    return session
  },
  duplicateRules: [{ family: 'test' }],
  capabilities: ['empirical-authority'],
})

const b04 = scenario({
  id: 'B04-failure-resolution',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-verification',
  foldMode: 'leaf',
  continuation: ['Continue with the next task.'],
  oracles: [{ type: 'failure-retired', failureId: 'failure:call-1' }],
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b04'))
    closedTurn(session, 1, 'run the suite', true, { callId: ToolCallId('call-1'), failed: true })
    closedTurn(session, 2, 'fix and re-run', true, { callId: ToolCallId('retest-1'), failed: false })
    session.append('turn/start', { turn: 3 })
    return session
  },
  duplicateRules: [{ family: 'test' }],
  capabilities: ['failure-lifecycle'],
  declareAnchors: (session, service, seqs) => {
    // VERIFIED with empirical evidence (the successful retest tool result).
    service.verifyFailure(session, 'failure:call-1', [{ seq: seqs.lastSuccessfulToolResult() as never }])
  },
})

const b05 = scenario({
  id: 'B05-pending-obligation',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'before-integration-test',
  foldMode: 'leaf',
  continuation: ['Continue.'],
  oracles: [{ type: 'obligation-open', obligationId: 'B05-obligation' }],
  buildSession: () => baseConversation('b05', 3),
  duplicateRules: [{ family: 'test' }],
  capabilities: ['obligation-continuity'],
  declareAnchors: (session, service, seqs) => {
    service.declare(session, {
      id: 'B05-obligation',
      kind: 'obligation',
      stateKey: { namespace: 'workflow', entity: 'b05', property: 'integration-test' },
      value: 'run integration test X after the edit',
      authority: 'normative',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
  },
})

const b06 = scenario({
  id: 'B06-exact-identifier',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-artifact-creation',
  foldMode: 'leaf',
  continuation: ['Reference the artifact hash exactly.'],
  oracles: [{ type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'sha256:9f2c1e' }],
  buildSession: () => baseConversation('b06 artifact sha256:9f2c1e committed', 4),
  maxActions: 6,
  duplicateRules: [{ family: 'read' }],
  recallRequired: true,
  capabilities: ['exact-recoverability'],
})

const b07 = scenario({
  id: 'B07-tool-pairing-boundary',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'near-tool-pair',
  foldMode: 'leaf',
  continuation: ['Continue.'],
  oracles: [{ type: 'tool-action-present', family: 'read' }],
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b07'))
    closedTurn(session, 1, 'read the file', true, { callId: ToolCallId('call-1'), failed: false })
    closedTurn(session, 2, 'run the tool again', true, { callId: ToolCallId('call-2'), failed: false })
    session.append('turn/start', { turn: 3 })
    return session
  },
  capabilities: ['structural-legality'],
})

const b08 = scenario({
  id: 'B08-repeated-leaf-folds',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-leaf-accumulation',
  foldMode: 'leaf',
  continuation: ['Continue.'],
  oracles: [{ type: 'tool-action-present', family: 'read' }],
  buildSession: () => baseConversation('b08', 8),
  capabilities: ['monotonic-fold-frontier'],
})

const b09 = scenario({
  id: 'B09-root-rebase',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'after-leaf-accumulation',
  foldMode: 'root',
  continuation: ['Continue.'],
  oracles: [{ type: 'tool-action-present', family: 'read' }],
  buildSession: () => baseConversation('b09', 6),
  capabilities: ['leaf-root-lifecycle', 'provenance-exactness'],
})

const b10 = scenario({
  id: 'B10-session-isolation',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'two-sessions',
  foldMode: 'leaf',
  continuation: ['Recall the other session checkpoint.'],
  oracles: [{ type: 'no-cross-session-recall' }],
  buildSession: () => baseConversation('b10', 4),
  capabilities: ['tenant-session-separation'],
})

const b11 = scenario({
  id: 'B11-restart',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'before-restart',
  foldMode: 'leaf',
  continuation: ['Continue after restart.'],
  oracles: [{ type: 'tool-action-present', family: 'recall' }],
  buildSession: () => baseConversation('b11', 4),
  recallRequired: true,
  capabilities: ['durable-recall'],
})

const b12 = scenario({
  id: 'B12-state-only-checkpoint',
  workload: 'coding',
  tier: 'hard',
  boundaryLabel: 'zero-llm-fold',
  foldMode: 'leaf',
  continuation: ['Continue.'],
  oracles: [{ type: 'state-key-equals', stateKey: 'scope/work/public-api', value: 'do not change the public API' },
      { type: 'anchor-active', anchorId: 'B12-constraint' }],
  buildSession: () => baseConversation('b12', 4),
  capabilities: ['deterministic-machine-handoff'],
  declareAnchors: (session, service, seqs) => {
    service.declare(session, {
      id: 'B12-constraint',
      kind: 'constraint',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
      value: 'do not change the public API',
      authority: 'normative',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
  },
})

/** X-class exploratory scenarios (diagnostic; failures produce incidents). */
const x01 = scenario({
  id: 'X01-rejected-approach-resurfaces',
  workload: 'research',
  tier: 'exploratory',
  boundaryLabel: 'after-rejection',
  foldMode: 'leaf',
  continuation: ['Consider all approaches again.'],
  oracles: [{ type: 'anchor-active', anchorId: 'X01-rejection' }],
  buildSession: () => baseConversation('x01 approach B rejected for speed', 4),
  maxActions: 6,
  capabilities: ['rejected-branch-retention'],
  declareAnchors: (session, service, seqs) => {
    service.declare(session, {
      id: 'X01-rejection',
      kind: 'decision',
      stateKey: { namespace: 'design', entity: 'x01', property: 'approach' },
      value: 'approach B rejected: too slow for the deadline',
      authority: 'decision',
      sourceRefs: [{ seq: seqs.lastUser() as never }],
    })
  },
})

const x02 = scenario({
  id: 'X02-uncertainty-across-folds',
  workload: 'research',
  tier: 'exploratory',
  boundaryLabel: 'open-hypothesis',
  foldMode: 'leaf',
  continuation: ['What is the root cause?'],
  oracles: [{ type: 'state-key-equals', stateKey: 'hypothesis/x01/root-cause', value: 'race condition (unconfirmed)' }],
  buildSession: () => baseConversation('x01 race condition suspected but unconfirmed', 4),
  capabilities: ['uncertainty-retention'],
  declareAnchors: (session, service, seqs) => {
    service.declare(session, {
      id: 'X02-hypothesis',
      kind: 'value',
      stateKey: { namespace: 'hypothesis', entity: 'x01', property: 'root-cause' },
      value: 'race condition (unconfirmed)',
      authority: 'hypothesis',
      sourceRefs: [{ seq: seqs.lastAssistant() as never }],
    })
  },
})

const x06 = scenario({
  id: 'X06-child-agent-handoff',
  workload: 'multi-agent',
  tier: 'exploratory',
  boundaryLabel: 'after-child-result',
  foldMode: 'leaf',
  continuation: ['Use the child result.'],
  oracles: [{ type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'child-agent result' }],
  buildSession: () => baseConversation('x01 child-agent result: benchmark complete, 12 scenarios pass', 4),
  maxActions: 6,
  recallRequired: true,
  capabilities: ['child-agent-handoff'],
})

export const HARD_SCENARIOS: readonly ScenarioDefinition[] = [
  b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11, b12,
]

const x03 = scenario({
  id: 'X03-cross-checkpoint-dependency',
  workload: 'coding',
  tier: 'exploratory',
  boundaryLabel: 'dependency-across-folds',
  foldMode: 'leaf',
  continuation: ['Apply the change discussed before the first fold.'],
  oracles: [{ type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'dependency fact' }],
  buildSession: () => baseConversation('x03 dependency fact recorded before any fold', 4),
  maxActions: 6,
  recallRequired: true,
  capabilities: ['cross-checkpoint-dependency'],
})

const x04 = scenario({
  id: 'X04-long-distance-rationale',
  workload: 'research',
  tier: 'exploratory',
  boundaryLabel: 'rationale-needed-later',
  foldMode: 'leaf',
  continuation: ['Explain why the current design was chosen.'],
  oracles: [{ type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'rationale' }],
  buildSession: () => baseConversation('x04 rationale: the design was chosen for determinism', 4),
  recallRequired: true,
  capabilities: ['rationale-durability'],
})

const x05 = scenario({
  id: 'X05-old-search-evidence-resurfaces',
  workload: 'search',
  tier: 'exploratory',
  boundaryLabel: 'evidence-resurfaces',
  foldMode: 'leaf',
  continuation: ['Reuse the earlier search evidence.'],
  oracles: [{ type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'search evidence' }],
  buildSession: () => baseConversation('x05 search evidence: the upstream issue was fixed in 0.1.7', 4),
  maxActions: 6,
  duplicateRules: [{ family: 'search' }],
  recallRequired: true,
  capabilities: ['search-evidence-continuity'],
})

export const EXPLORATORY_SCENARIOS: readonly ScenarioDefinition[] = [x01, x02, x03, x04, x05, x06]

export const ALL_SCENARIOS: readonly ScenarioDefinition[] = [...HARD_SCENARIOS, ...EXPLORATORY_SCENARIOS]
