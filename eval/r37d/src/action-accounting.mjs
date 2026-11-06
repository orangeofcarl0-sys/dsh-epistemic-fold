/**
 * R37-D WP2: per-model-call action accounting.
 *
 * The runner's counters and the stored trace answer different questions:
 *
 *   modelCalls          one provider response, including a response with no
 *                       valid action
 *   completedSteps      one loop iteration; a finish accepted at step N means
 *                       N + 1 model calls
 *   toolCalls           non-finish actions actually dispatched
 *   validActions        parsed actions, valid or not yet executed
 *   rejectedActions     parsed actions the validator rejected
 *   noValidActionCalls  turns whose response produced no executable action
 *
 * The trace text is capped at 1,000 characters. A turn at the cap is labelled
 * `stored-prefix`; the accounting never claims the prefix is the full response.
 * `finishReason === max-tokens` is positive evidence of provider truncation.
 *
 * @module eval/r37d/src/action-accounting
 */

import { analyzeTurnStrict } from '../../r37c/src/dsml-codec.mjs'

export const NO_VALID_ACTION_CLASSES = [
  'natural-language-only',
  'invalid-envelope',
  'missing-parameter',
  'truncated-output',
  'unknown-tool',
  'duplicate-action',
  'unsupported-tool',
  'tool-dispatch-failure',
  'no-action-other',
  'unavailable-evidence',
]

const TOOL_MARKER = /<｜|<\|[^|]*\|>|"tool"\s*:/u

function hasToolMarker(text) {
  return TOOL_MARKER.test(text)
}

function diagnosticReasons(diagnostics) {
  return diagnostics.map(diagnostic => String(diagnostic?.reason ?? ''))
}

function invalidReasons(invalid) {
  return invalid.flatMap(action => (action.reasons ?? []).map(reason => String(reason?.reason ?? reason)))
}

/**
 * Classify a turn that produced no executable action.
 *
 * `truncated-output` is reserved for positive provider truncation. A model that
 * emits an unclosed tag and stops is `invalid-envelope`: the output is complete
 * as far as the harness is concerned, but it is not a valid request.
 *
 * @param {object} input
 * @param {string} input.text
 * @param {string} input.finishReason
 * @param {object[]} input.actions
 * @param {object[]} input.invalid
 * @param {object[]} input.diagnostics
 * @param {boolean} input.capped
 * @returns {string|null}
 */
export function classifyNoValidAction({ text, finishReason, actions, invalid, diagnostics, capped }) {
  if (actions.length > 0) return null
  if (finishReason === 'max-tokens' || finishReason === 'length') return 'truncated-output'
  const reasons = [...diagnosticReasons(diagnostics), ...invalidReasons(invalid)]
  if (reasons.includes('truncated-invoke')
    || reasons.includes('truncated-parameter')
    || reasons.includes('truncated-json')) return 'invalid-envelope'
  if (reasons.includes('missing-parameter') || reasons.includes('empty-invoke')) return 'missing-parameter'
  if (reasons.includes('unknown-tool')) return 'unknown-tool'
  if (reasons.includes('duplicate-action')) return 'duplicate-action'
  if (reasons.includes('unsupported-tool')) return 'unsupported-tool'
  if (reasons.includes('tool-dispatch-failure')) return 'tool-dispatch-failure'
  if (invalid.length > 0) return 'no-action-other'
  if (capped) return 'unavailable-evidence'
  if (hasToolMarker(text)) return 'invalid-envelope'
  return 'natural-language-only'
}

/**
 * Account one stored model turn.
 *
 * @param {object} input
 * @param {object} input.turn - `{step, text, finishReason}`.
 * @param {number} input.maxSteps
 * @param {number} input.index - zero-based model-call index.
 * @returns {object}
 */
export function accountTurn({ turn, maxSteps, index }) {
  const text = String(turn?.text ?? '')
  const finishReason = turn?.finishReason?.kind ?? 'none'
  const capped = text.length >= 1000
  const analysis = analyzeTurnStrict(text, 'model')
  const actions = analysis.actions ?? []
  const invalid = analysis.invalid ?? []
  const diagnostics = analysis.diagnostics ?? []
  const finishPosition = actions.findIndex(action => action.tool === 'finish')
  const finishRequested = finishPosition !== -1
  const nonFinish = actions.filter(action => action.tool !== 'finish')
  const noValidAction = actions.length === 0
  const noValidActionClass = classifyNoValidAction({
    text,
    finishReason,
    actions,
    invalid,
    diagnostics,
    capped,
  })
  const executionStatus = actions.length > 0
    ? invalid.length > 0 ? 'partially-rejected' : 'executed'
    : invalid.length > 0 ? 'rejected' : 'none'
  return {
    index,
    step: turn?.step ?? index,
    responseLength: text.length,
    responseCapped: capped,
    responseTruncated: finishReason === 'max-tokens' || finishReason === 'length',
    finishReason,
    remainingSteps: Math.max(0, maxSteps - (turn?.step ?? index) - 1),
    toolRequestEmitted: actions.length > 0 || invalid.length > 0 || diagnostics.length > 0 || hasToolMarker(text),
    toolRequestParsed: actions.length + invalid.length > 0,
    toolRequestValidated: actions.length > 0,
    toolRequestDispatched: actions.length > 0,
    toolResultReceived: nonFinish.length > 0,
    actions: actions.map(action => ({
      tool: action.tool,
      path: action.params?.path ?? null,
      hasParameters: Object.keys(action.params ?? {}).length > 0,
    })),
    invalidActions: invalid.map(action => ({
      tool: action.tool ?? null,
      reasons: (action.reasons ?? []).map(reason => String(reason?.reason ?? reason)),
    })),
    diagnostics: diagnosticReasons(diagnostics),
    executionStatus,
    noValidAction,
    noValidActionClass,
    mentionsVerificationWrite: text.includes('verification.json') && text.includes('write_file'),
    finishRequested,
    finishPosition: finishRequested ? finishPosition : null,
    finishAfterNonFinish: finishRequested && nonFinish.length > 0,
    evidence: capped ? 'stored-prefix' : 'complete',
  }
}

function countBy(list, selector) {
  const counts = {}
  for (const entry of list) {
    const key = selector(entry)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Account one cell.
 *
 * `detail` is the runner's authoritative counter block. `turns` is the stored
 * trace prefix. Budget positions are derived from the prefix and are labelled
 * when the prefix cannot prove a later action.
 *
 * @param {object} input
 * @param {object} input.cell
 * @param {object[]} input.turns - accounted turns.
 * @param {object} input.detail - `row.behaviourDetail`.
 * @param {object} input.harness - `detail.harness`.
 * @returns {object}
 */
export function summarizeCell({
  cell,
  turns,
  detail = {},
  harness = {},
  verificationArtifact = null,
  requiresVerificationArtifact = false,
}) {
  const maxSteps = harness.maxSteps ?? 8
  const validTurns = turns.filter(turn => turn.toolRequestValidated)
  const firstWrite = validTurns.find(turn => turn.actions.some(action => action.tool === 'write_file')) ?? null
  const firstTest = validTurns.find(turn => turn.actions.some(action => action.tool === 'run_tests')) ?? null
  const writeTurns = validTurns.filter(turn => turn.actions.some(action => action.tool === 'write_file'))
  const lastWrite = writeTurns.length === 0 ? null : writeTurns[writeTurns.length - 1]
  const readPaths = {}
  const writePaths = {}
  for (const turn of validTurns) {
    for (const action of turn.actions) {
      if (action.tool === 'read_file' && typeof action.path === 'string') {
        readPaths[action.path] = (readPaths[action.path] ?? 0) + 1
      }
      if (action.tool === 'write_file' && typeof action.path === 'string') {
        writePaths[action.path] = (writePaths[action.path] ?? 0) + 1
      }
    }
  }
  const listDirTurns = validTurns.filter(turn => turn.actions.some(action => action.tool === 'list_dir'))
  const noValidTurns = turns.filter(turn => turn.noValidAction)
  const invalidBeforeTest = firstTest === null
    ? null
    : noValidTurns.filter(turn => turn.step < firstTest.step).length
  const verificationWriteMentions = turns.filter(turn => turn.mentionsVerificationWrite === true)
  const verificationWriteValid = validTurns.filter(turn => turn.actions.some(action =>
    action.tool === 'write_file' && String(action.path ?? '').includes('verification.json')))
  const testsExecuted = detail.testsExecuted ?? 0
  const artifactPresent = verificationArtifact === true
    || (verificationArtifact !== null && typeof verificationArtifact === 'object')
  const stepLimit = harness.stepLimitTermination === true
  const modelCalls = detail.modelCalls ?? 0
  const steps = detail.steps ?? 0
  const toolCalls = detail.toolCalls ?? 0
  const validActions = harness.validActions ?? 0
  const rejectedActions = harness.rejectedActions ?? 0
  const noValidActionCalls = harness.invalidActions ?? 0

  let verificationFailurePhase = null
  if (requiresVerificationArtifact) {
    if (verificationWriteValid.length > 0) verificationFailurePhase = 'executed'
    else if (verificationWriteMentions.length > 0) verificationFailurePhase = 'tool-request-rejected'
    else if (stepLimit) verificationFailurePhase = 'budget-exhausted-before-request'
    else verificationFailurePhase = 'never-requested'
  }

  return {
    cellId: cell.cellId,
    caseId: cell.caseId,
    arm: cell.arm,
    guard: cell.guard,
    replicateId: cell.replicateId,
    modelCalls,
    completedSteps: steps,
    toolCalls,
    validActions,
    rejectedActions,
    noValidActionCalls,
    testsExecuted,
    testResultsReceived: testsExecuted,
    finishRequests: detail.finishGuard?.finishRequests ?? 0,
    modelCallsBeforeFirstWrite: firstWrite === null ? null : firstWrite.step,
    modelCallsBeforeFirstTest: firstTest === null ? null : firstTest.step,
    modelCallsAfterLastWrite: lastWrite === null ? null : modelCalls - (lastWrite.step + 1),
    modelCallsUntilTermination: modelCalls,
    invalidCallsBeforeFirstTest: invalidBeforeTest,
    invalidCallsTotal: noValidTurns.length,
    remainingBudgetAtFirstTest: firstTest === null ? null : Math.max(0, maxSteps - firstTest.step - 1),
    firstWriteStep: firstWrite?.step ?? null,
    firstTestStep: firstTest?.step ?? null,
    lastWriteStep: lastWrite?.step ?? null,
    readPaths,
    repeatedReadPaths: Object.fromEntries(Object.entries(readPaths).filter(([, count]) => count > 1)),
    listDirTurns: listDirTurns.length,
    writePaths,
    legalCodeNoTest: writeTurns.length > 0 && testsExecuted === 0,
    verificationWriteMentions: verificationWriteMentions.length,
    verificationWriteValid: verificationWriteValid.length,
    verificationArtifactPresent: artifactPresent,
    verificationFailurePhase,
    stepLimitTermination: stepLimit,
    providerFailure: harness.providerFailure ?? null,
    noValidActionClasses: countBy(noValidTurns, turn => turn.noValidActionClass ?? 'no-action-other'),
    turnEvidence: countBy(turns, turn => turn.evidence),
    turns,
  }
}
