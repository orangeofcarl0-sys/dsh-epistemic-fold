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

// ---------------------------------------------------------------------------
// B01-B12
// ---------------------------------------------------------------------------

const b01: ScenarioDefinition = {
  id: 'B01-explicit-api-constraint',
  sidecar: {
    version: 1,
    id: 'B01-explicit-api-constraint',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'before-shortcut-task' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Implement the faster shortcut.'], maxActions: 6 },
    oracle: { success: [
      { type: 'anchor-active', anchorId: 'B01-constraint' },
      { type: 'state-key-equals', stateKey: 'scope/work/public-api', value: 'do not change the public API' },
    ] },
    behavior: { duplicateRules: [{ family: 'read' }, { family: 'test' }] },
    recall: { required: false },
    classification: { expectedCapability: ['constraint-retention'] },
  },
  buildSession: () => baseConversation('b01'),
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
}

const b02: ScenarioDefinition = {
  id: 'B02-superseded-timeout',
  sidecar: {
    version: 1,
    id: 'B02-superseded-timeout',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-second-value' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Apply the current timeout.'], maxActions: 4 },
    oracle: { success: [
      { type: 'state-key-equals', stateKey: 'config/server/timeout', value: 60 },
    ] },
    behavior: { duplicateRules: [{ family: 'read' }] },
    recall: { required: false },
    classification: { expectedCapability: ['current-state-singularity'] },
  },
  buildSession: () => baseConversation('b02', 3),
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
}

const b03: ScenarioDefinition = {
  id: 'B03-evidence-vs-narrative',
  sidecar: {
    version: 1,
    id: 'B03-evidence-vs-narrative',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-failed-tests' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue and report test status.'], maxActions: 4 },
    oracle: { success: [
      { type: 'failure-open', failureId: 'failure:call-2' },
    ] },
    behavior: { duplicateRules: [{ family: 'test' }] },
    recall: { required: false },
    classification: { expectedCapability: ['empirical-authority'] },
  },
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b03'))
    closedTurn(session, 1, 'run the suite', true)
    closedTurn(session, 2, 'run the suite again', true, { callId: ToolCallId('call-2'), failed: true })
    closedTurn(session, 3, 'probably fixed by now', true)
    session.append('turn/start', { turn: 4 })
    return session
  },
}

const b04: ScenarioDefinition = {
  id: 'B04-failure-resolution',
  sidecar: {
    version: 1,
    id: 'B04-failure-resolution',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-verification' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue with the next task.'], maxActions: 4 },
    oracle: { success: [
      { type: 'failure-retired', failureId: 'failure:call-1' },
    ] },
    behavior: { duplicateRules: [{ family: 'test' }] },
    recall: { required: false },
    classification: { expectedCapability: ['failure-lifecycle'] },
  },
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b04'))
    closedTurn(session, 1, 'run the suite', true, { callId: ToolCallId('call-1'), failed: true })
    closedTurn(session, 2, 'fix and re-run', true, { callId: ToolCallId('retest-1'), failed: false })
    session.append('turn/start', { turn: 3 })
    return session
  },
  declareAnchors: (session, service, seqs) => {
    // VERIFIED with empirical evidence (the successful retest tool result).
    service.verifyFailure(session, 'failure:call-1', [{ seq: seqs.lastSuccessfulToolResult() as never }])
  },
}

const b05: ScenarioDefinition = {
  id: 'B05-pending-obligation',
  sidecar: {
    version: 1,
    id: 'B05-pending-obligation',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'before-integration-test' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue.'], maxActions: 4 },
    oracle: { success: [
      { type: 'obligation-open', obligationId: 'B05-obligation' },
    ] },
    behavior: { duplicateRules: [{ family: 'test' }] },
    recall: { required: false },
    classification: { expectedCapability: ['obligation-continuity'] },
  },
  buildSession: () => baseConversation('b05', 3),
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
}

const b06: ScenarioDefinition = {
  id: 'B06-exact-identifier',
  sidecar: {
    version: 1,
    id: 'B06-exact-identifier',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-artifact-creation' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Reference the artifact hash exactly.'], maxActions: 6 },
    oracle: { success: [
      { type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'sha256:9f2c1e' },
    ] },
    behavior: { duplicateRules: [{ family: 'read' }] },
    recall: { required: true },
    classification: { expectedCapability: ['exact-recoverability'] },
  },
  buildSession: () => baseConversation('b06 artifact sha256:9f2c1e committed', 4),
}

const b07: ScenarioDefinition = {
  id: 'B07-tool-pairing-boundary',
  sidecar: {
    version: 1,
    id: 'B07-tool-pairing-boundary',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'near-tool-pair' },
    fold: { mode: 'leaf', target: 'balanced-span' },
    continuation: { input: ['Continue.'], maxActions: 4 },
    oracle: { success: [
      { type: 'tool-action-present', family: 'read' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['structural-legality'] },
  },
  buildSession: () => {
    const session = Session.create(SessionId('ef-eval-b07'))
    closedTurn(session, 1, 'read the file', true, { callId: ToolCallId('call-1'), failed: false })
    closedTurn(session, 2, 'run the tool again', true, { callId: ToolCallId('call-2'), failed: false })
    session.append('turn/start', { turn: 3 })
    return session
  },
}

const b08: ScenarioDefinition = {
  id: 'B08-repeated-leaf-folds',
  sidecar: {
    version: 1,
    id: 'B08-repeated-leaf-folds',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-leaf-accumulation' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue.'], maxActions: 4 },
    oracle: { success: [
      { type: 'tool-action-present', family: 'read' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['monotonic-fold-frontier'] },
  },
  buildSession: () => baseConversation('b08', 8),
}

const b09: ScenarioDefinition = {
  id: 'B09-root-rebase',
  sidecar: {
    version: 1,
    id: 'B09-root-rebase',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'after-leaf-accumulation' },
    fold: { mode: 'root', target: 'full-history' },
    continuation: { input: ['Continue.'], maxActions: 4 },
    oracle: { success: [
      { type: 'tool-action-present', family: 'read' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['leaf-root-lifecycle', 'provenance-exactness'] },
  },
  buildSession: () => baseConversation('b09', 6),
}

const b10: ScenarioDefinition = {
  id: 'B10-session-isolation',
  sidecar: {
    version: 1,
    id: 'B10-session-isolation',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'two-sessions' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Recall the other session checkpoint.'], maxActions: 4 },
    oracle: { success: [
      { type: 'no-cross-session-recall' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['tenant-session-separation'] },
  },
  buildSession: () => baseConversation('b10', 4),
}

const b11: ScenarioDefinition = {
  id: 'B11-restart',
  sidecar: {
    version: 1,
    id: 'B11-restart',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'before-restart' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue after restart.'], maxActions: 4 },
    oracle: { success: [
      { type: 'tool-action-present', family: 'recall' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: true },
    classification: { expectedCapability: ['durable-recall'] },
  },
  buildSession: () => baseConversation('b11', 4),
}

const b12: ScenarioDefinition = {
  id: 'B12-state-only-checkpoint',
  sidecar: {
    version: 1,
    id: 'B12-state-only-checkpoint',
    workload: 'coding',
    tier: 'hard',
    source: { sessionRole: 'parent', boundaryLabel: 'zero-llm-fold' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Continue.'], maxActions: 4 },
    oracle: { success: [
      { type: 'state-key-equals', stateKey: 'scope/work/public-api', value: 'do not change the public API' },
      { type: 'anchor-active', anchorId: 'B12-constraint' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['deterministic-machine-handoff'] },
  },
  buildSession: () => baseConversation('b12', 4),
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
}

/** X-class exploratory scenarios (diagnostic; failures produce incidents). */
const x01: ScenarioDefinition = {
  id: 'X01-rejected-approach-resurfaces',
  sidecar: {
    version: 1,
    id: 'X01-rejected-approach-resurfaces',
    workload: 'research',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'after-rejection' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Consider all approaches again.'], maxActions: 6 },
    oracle: { success: [
      { type: 'anchor-active', anchorId: 'X01-rejection' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['rejected-branch-retention'] },
  },
  buildSession: () => baseConversation('x01 approach B rejected for speed', 4),
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
}

const x02: ScenarioDefinition = {
  id: 'X02-uncertainty-across-folds',
  sidecar: {
    version: 1,
    id: 'X02-uncertainty-across-folds',
    workload: 'research',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'open-hypothesis' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['What is the root cause?'], maxActions: 4 },
    oracle: { success: [
      { type: 'state-key-equals', stateKey: 'hypothesis/x01/root-cause', value: 'race condition (unconfirmed)' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: false },
    classification: { expectedCapability: ['uncertainty-retention'] },
  },
  buildSession: () => baseConversation('x01 race condition suspected but unconfirmed', 4),
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
}

const x06: ScenarioDefinition = {
  id: 'X06-child-agent-handoff',
  sidecar: {
    version: 1,
    id: 'X06-child-agent-handoff',
    workload: 'multi-agent',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'after-child-result' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Use the child result.'], maxActions: 6 },
    oracle: { success: [
      { type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'child-agent result' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: true },
    classification: { expectedCapability: ['child-agent-handoff'] },
  },
  buildSession: () => baseConversation('x01 child-agent result: benchmark complete, 12 scenarios pass', 4),
}

export const HARD_SCENARIOS: readonly ScenarioDefinition[] = [
  b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11, b12,
]

const x03: ScenarioDefinition = {
  id: 'X03-cross-checkpoint-dependency',
  sidecar: {
    version: 1,
    id: 'X03-cross-checkpoint-dependency',
    workload: 'coding',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'dependency-across-folds' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Apply the change discussed before the first fold.'], maxActions: 6 },
    oracle: { success: [
      { type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'dependency fact' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: true },
    classification: { expectedCapability: ['cross-checkpoint-dependency'] },
  },
  buildSession: () => baseConversation('x03 dependency fact recorded before any fold', 4),
}

const x04: ScenarioDefinition = {
  id: 'X04-long-distance-rationale',
  sidecar: {
    version: 1,
    id: 'X04-long-distance-rationale',
    workload: 'research',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'rationale-needed-later' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Explain why the current design was chosen.'], maxActions: 4 },
    oracle: { success: [
      { type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'rationale' },
    ] },
    behavior: { duplicateRules: [] },
    recall: { required: true },
    classification: { expectedCapability: ['rationale-durability'] },
  },
  buildSession: () => baseConversation('x04 rationale: the design was chosen for determinism', 4),
}

const x05: ScenarioDefinition = {
  id: 'X05-old-search-evidence-resurfaces',
  sidecar: {
    version: 1,
    id: 'X05-old-search-evidence-resurfaces',
    workload: 'search',
    tier: 'exploratory',
    source: { sessionRole: 'parent', boundaryLabel: 'evidence-resurfaces' },
    fold: { mode: 'leaf', target: 'oldest-safe-span' },
    continuation: { input: ['Reuse the earlier search evidence.'], maxActions: 6 },
    oracle: { success: [
      { type: 'recall-contains', checkpointId: 'RECALL_TARGET', substring: 'search evidence' },
    ] },
    behavior: { duplicateRules: [{ family: 'search' }] },
    recall: { required: true },
    classification: { expectedCapability: ['search-evidence-continuity'] },
  },
  buildSession: () => baseConversation('x05 search evidence: the upstream issue was fixed in 0.1.7', 4),
}

export const EXPLORATORY_SCENARIOS: readonly ScenarioDefinition[] = [x01, x02, x03, x04, x05, x06]

export const ALL_SCENARIOS: readonly ScenarioDefinition[] = [...HARD_SCENARIOS, ...EXPLORATORY_SCENARIOS]
