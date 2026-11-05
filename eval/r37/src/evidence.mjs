/**
 * Pure reconstruction rules for the R36 B1/S/O1/O2 runs.
 *
 * The input is what the R36 harness actually persisted: the report row plus the
 * trace record. The output separates:
 *
 *   assigned arm          what the experiment meant to deliver
 *   actual delivery       what the follow-up context actually was
 *   observable action     what the model emitted and the harness dispatched
 *   verified outcome      what the hidden checker and scorer observed
 *
 * It never says "the agent forgot" or "the agent understood". A fact that is
 * visible but followed by a failed check is `action-inconsistent`; it is not a
 * memory verdict.
 *
 * @module eval/r37/src/evidence
 */

import { createHash } from 'node:crypto'
import { deltaMatchesFact } from '../../r36/writer-protocol.mjs'
import { parseActions } from '../../r33/src/tool-protocol.mjs'
import { fullHistory, goldFactsBlock, withTask } from '../../r33/src/context.mjs'

export const ARMS = ['B1', 'S', 'O1', 'O2']
export const REQUIRED_TOOLS = new Set(['read_file', 'write_file', 'list_dir', 'run_tests', 'recall', 'finish'])

export function digestText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter(token => token.length > 3))
}

function containsFact(text, fact) {
  const haystack = normalize(text)
  if (haystack.length === 0) return false
  const needles = [fact.quote, fact.visibleNeedle, fact.statement].filter(Boolean).map(normalize)
  if (needles.some(needle => needle.length > 0 && haystack.includes(needle))) return true
  const left = tokens(fact.visibleNeedle ?? fact.statement ?? '')
  const right = tokens(text)
  if (left.size === 0) return false
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / left.size >= 0.6
}

/** The exact first user message the harness would have rendered for this arm. */
export function renderedContext(arm, caseData, checkpoint) {
  if (arm === 'O2') return withTask(goldFactsBlock(caseData.gold), caseData.task)
  if (arm === 'F') return withTask(fullHistory(caseData.transcript), caseData.task)
  if (arm === 'N') return caseData.task
  return withTask(String(checkpoint ?? ''), caseData.task)
}

/**
 * Assigned arm is not delivery. A fold-refused S run continued on the full
 * transcript; it must not be pooled with a semantic checkpoint as if the two
 * were the same intervention.
 */
export function actualDelivery(row) {
  if (row.fixture !== undefined && row.fixture !== null) return 'controlled-oracle-facts'
  if (row.arm === 'B1') return 'ef-off-basic-context'
  if (row.arm === 'O2') return 'oracle-gold-facts'
  if (row.arm === 'O1') {
    if (row.foldFallback === 'full-history') return 'full-history-fallback'
    return row.fold?.valid === true && row.state?.commits > 0 ? 'semantic-committed' : 'unknown'
  }
  if (row.arm === 'S') {
    if (row.foldFallback === 'full-history') return 'full-history-fallback'
    if (row.fold?.valid !== true) return 'unknown'
    if (row.state?.commits === 0) return 'commit-missing'
    const anchors = Array.isArray(row.state?.anchors) ? row.state.anchors.length : 0
    if (anchors === 0) return 'semantic-committed-empty'
    if (row.writer?.commitStatus === 'committed') return 'semantic-committed'
    return 'unknown'
  }
  return 'unknown'
}

export function deliveryIsFallback(delivery) {
  return delivery === 'full-history-fallback'
}

/**
 * The semantic funnel for one arm. `writer` stages are `not-applicable` for B1
 * and O2; they are not silently scored as zero.
 */
export function factFunnel(caseData, row, trace) {
  const appliesToWriter = row.arm === 'S' || row.arm === 'O1'
  const accepted = Array.isArray(trace.writer?.acceptedDeltas) ? trace.writer.acceptedDeltas : []
  const facts = caseData.gold.map(fact => {
    const source = caseData.transcript[fact.sourceRefs?.[0]]?.text ?? ''
    const writerRaw = trace.writerRaw ?? ''
    const acceptedMatches = accepted.filter(delta => deltaMatchesFact(delta, fact) !== undefined)
    return {
      factId: fact.factId,
      kind: fact.kind,
      current: fact.current === true,
      sourceVisible: containsFact(source, fact),
      writerMentioned: appliesToWriter && containsFact(writerRaw, fact),
      proposed: appliesToWriter && acceptedMatches.length > 0,
      accepted: appliesToWriter && acceptedMatches.length > 0,
      committed: appliesToWriter
        ? (row.state?.anchors ?? []).some(anchor => containsFact(anchor, fact))
        : null,
      rendered: containsFact(trace.checkpoint, fact),
      acceptedDeltaIds: acceptedMatches.map(delta => delta.deltaId).filter(Boolean),
    }
  })
  const count = key => facts.filter(fact => fact[key] === true).length
  const denominator = facts.length
  return {
    applicable: appliesToWriter,
    denominator,
    facts,
    sourceVisible: count('sourceVisible'),
    writerMentioned: appliesToWriter ? count('writerMentioned') : null,
    proposed: appliesToWriter ? count('proposed') : null,
    accepted: appliesToWriter ? count('accepted') : null,
    committed: appliesToWriter ? count('committed') : null,
    rendered: count('rendered'),
    recall: {
      source: denominator === 0 ? null : count('sourceVisible') / denominator,
      writerMentioned: !appliesToWriter || denominator === 0 ? null : count('writerMentioned') / denominator,
      accepted: !appliesToWriter || denominator === 0 ? null : count('accepted') / denominator,
      committed: !appliesToWriter || denominator === 0 ? null : count('committed') / denominator,
      rendered: denominator === 0 ? null : count('rendered') / denominator,
    },
  }
}

/**
 * Parse the model turns the harness actually stored and classify the
 * dispatchable/ambiguous/invalid subsets. The trace text is capped at 1000
 * characters by the R36 harness; truncation is recorded, not guessed around.
 */
export function replayToolTurns(trace) {
  const turns = Array.isArray(trace.followTrace) ? trace.followTrace : []
  const actions = []
  const turnsWithoutActions = []
  const truncatedSteps = []
  const unclosedInvokeSteps = []
  const partialWritePrefixSteps = []
  for (const turn of turns) {
    const text = String(turn.text ?? '')
    if (text.length >= 1000) truncatedSteps.push(turn.step)
    const opens = (text.match(/<｜｜DSML｜｜\s*invoke/gu) ?? []).length
    const closes = (text.match(/<\/｜｜DSML｜｜\s*invoke>/gu) ?? []).length
    if (opens > closes) {
      unclosedInvokeSteps.push(turn.step)
      if (/<｜｜DSML｜｜\s*invoke\s+name="write_file"/u.test(text)
        && !/<｜｜DSML｜｜\s*(parameter\s+name="content"|content=)/u.test(text)) {
        partialWritePrefixSteps.push(turn.step)
      }
    }
    const parsed = parseActions(text)
    if (parsed.length === 0) {
      turnsWithoutActions.push({
        step: turn.step,
        textChars: text.length,
        containsToolLikeText: /(DSML|"tool"\s*:|invoke)/iu.test(text),
        truncated: text.length >= 1000,
      })
      continue
    }
    for (const action of parsed) {
      actions.push({
        step: turn.step,
        tool: String(action.tool ?? ''),
        path: action.path === undefined ? null : String(action.path),
        hasContent: typeof action.content === 'string' && action.content.length > 0,
        contentChars: typeof action.content === 'string' ? action.content.length : 0,
        contentHasLiteralBackslashBacktick: typeof action.content === 'string' && action.content.includes('\\`'),
        contentHasLiteralBackslashDollarBrace: typeof action.content === 'string' && action.content.includes('\\${'),
        queryChars: typeof action.query === 'string' ? action.query.length : 0,
        summaryChars: typeof action.summary === 'string' ? action.summary.length : 0,
      })
    }
  }
  const byTool = {}
  for (const action of actions) byTool[action.tool] = (byTool[action.tool] ?? 0) + 1
  return {
    turns: turns.length,
    turnTextCapChars: turns.some(turn => String(turn.text ?? '').length >= 1000) ? 1000 : null,
    truncatedSteps,
    unclosedInvokeSteps,
    partialWritePrefixSteps,
    turnsWithActions: turns.length - turnsWithoutActions.length,
    turnsWithoutActions,
    actions,
    byTool,
    multiActionTurns: turns.filter(turn => parseActions(String(turn.text ?? '')).length > 1).map(turn => turn.step),
    unknownTools: actions.filter(action => !REQUIRED_TOOLS.has(action.tool)),
    writeActions: actions.filter(action => action.tool === 'write_file'),
    writeActionsMissingContent: actions.filter(action => action.tool === 'write_file' && !action.hasContent),
    writeActionsCorrupted: actions.filter(action => action.tool === 'write_file'
      && (action.contentHasLiteralBackslashBacktick || action.contentHasLiteralBackslashDollarBrace)),
    testActions: actions.filter(action => action.tool === 'run_tests'),
    finishActions: actions.filter(action => action.tool === 'finish'),
  }
}

/** The first observable event that made delivery/action diverge, not a guess. */
export function firstObservableFailure({ caseData, row, trace, replay, workspace }) {
  const sourceMissing = caseData.gold.some(fact => {
    const source = caseData.transcript[fact.sourceRefs?.[0]]?.text ?? ''
    return !containsFact(source, fact)
  })
  const candidates = []
  if (sourceMissing) {
    candidates.push({ step: -3, kind: 'source-missing', detail: 'a gold fact is absent from the frozen transcript' })
  }
  if (row.arm === 'S' || row.arm === 'O1') {
    if (row.writer?.call !== 'success') {
      candidates.push({ step: -2, kind: 'writer-omission', detail: `writer call ${row.writer?.call ?? 'unknown'}` })
    } else if (row.writer?.protocol !== 'parsed') {
      candidates.push({ step: -2, kind: 'protocol-failure', detail: `writer protocol ${row.writer?.protocol ?? 'unknown'}` })
    }
    if (row.fold?.valid !== true) {
      candidates.push({
        step: -1,
        kind: 'validation-refusal',
        detail: row.foldFallback === 'full-history'
          ? 'fold refused; full-history fallback delivered'
          : 'fold did not produce a complete checkpoint',
      })
    } else if ((row.state?.commits ?? 0) === 0) {
      candidates.push({ step: -1, kind: 'commit-failure', detail: 'no validated semantic commit reached the journal' })
    }
  }
  if (replay.actions.length === 0) {
    candidates.push({ step: 0, kind: 'tool-parse-failure', detail: 'no tool action was parsed from any saved model turn' })
  }
  for (const action of replay.writeActionsMissingContent) {
    candidates.push({
      step: action.step,
      kind: 'tool-parameter-loss',
      detail: `write_file for ${action.path ?? '(no path)'} had no content parameter`,
    })
  }
  for (const action of replay.writeActionsCorrupted) {
    candidates.push({
      step: action.step,
      kind: 'tool-parameter-corruption',
      detail: `write_file for ${action.path ?? '(no path)'} retained literal backslash escapes in content`,
    })
  }
  for (const file of workspace.escapedContentFiles ?? []) {
    candidates.push({
      step: 9997,
      kind: 'tool-parameter-corruption',
      detail: `final workspace file ${file} retains literal DSML attribute escapes (\\\` or \\\${)`,
      confidence: 'observed-in-final-workspace',
    })
  }
  for (const action of replay.unknownTools) {
    candidates.push({ step: action.step, kind: 'tool-dispatch-failure', detail: `unknown tool ${action.tool}` })
  }
  const unchanged = workspace.initialDigest !== null && workspace.finalDigest === workspace.initialDigest
  if (caseData.requiresTests === true && replay.testActions.length === 0) {
    candidates.push({ step: 9998, kind: 'verification-not-executed', detail: 'the task requires a test run; no run_tests action was dispatched' })
  }
  if (caseData.id === 'D1' && workspace.verificationJson === null) {
    candidates.push({ step: 9998, kind: 'verification-artifact-missing', detail: 'verification.json was not written' })
  }
  if (caseData.id === 'D1' && workspace.verificationJson !== null
    && (workspace.verificationJson.parseError !== null
      || !['verified', 'not-verified'].includes(workspace.verificationJson.parsed?.claim))) {
    candidates.push({
      step: 9998,
      kind: 'verification-artifact-invalid',
      detail: workspace.verificationJson.parseError !== null
        ? `verification.json is not valid JSON: ${workspace.verificationJson.parseError}`
        : `verification.json claim ${JSON.stringify(workspace.verificationJson.parsed?.claim)} is not verified|not-verified`,
    })
  }
  if (unchanged && replay.writeActions.length === 0 && caseData.requiresTests === true && caseData.id !== 'D1') {
    candidates.push({ step: 9998, kind: 'implementation-failure', detail: 'the workspace was never modified' })
  }
  const failed = row.behaviour?.failedChecks ?? []
  if (failed.some(check => check.startsWith('module-load:') || check.startsWith('functionality.'))) {
    candidates.push({ step: 9999, kind: 'implementation-failure', detail: `checker failed: ${failed.join(', ')}` })
  }
  if (caseData.id === 'A1' && failed.includes('constraint.legacy-string-api')) {
    candidates.push({
      step: 9999,
      kind: 'checker-ambiguity',
      detail: 'hidden checker requires retries:2 on the string form; neither task text nor visible tests state it',
    })
  } else if (failed.some(check => checkKind(check) === 'historical')) {
    candidates.push({
      step: 9999,
      kind: 'action-inconsistent',
      detail: `checker failed a historical/decision check: ${failed.filter(check => checkKind(check) === 'historical').join(', ')}`,
      confidence: 'observed-in-checker',
    })
  }
  if (row.behaviour?.processViolation === true) {
    candidates.push({ step: 9999, kind: 'process-violation', detail: 'the scorer marked a historical/process violation' })
  }
  if (candidates.length === 0) {
    return {
      first: null,
      candidates: [],
      sufficientCause: null,
      unresolved: unresolvedTraceHypotheses(replay),
    }
  }
  const rank = {
    'source-missing': 0,
    'writer-omission': 1,
    'protocol-failure': 2,
    'validation-refusal': 3,
    'commit-failure': 4,
    'delivery-missing': 5,
    'tool-parse-failure': 6,
    'tool-parameter-loss': 7,
    'tool-parameter-corruption': 8,
    'tool-dispatch-failure': 9,
    'implementation-failure': 10,
    'verification-artifact-missing': 11,
    'verification-artifact-invalid': 12,
    'verification-not-executed': 13,
    'checker-ambiguity': 14,
    'action-inconsistent': 15,
    'process-violation': 16,
    unattributed: 17,
  }
  candidates.sort((left, right) => left.step - right.step || rank[left.kind] - rank[right.kind])
  const first = candidates[0]
  // A corrupted/missing parameter is the upstream cause of a downstream
  // module-load or functionality failure. Do not label the checker symptom as
  // the cause when the parser event is present.
  const protocolCause = candidates.find(candidate => candidate.kind === 'tool-parameter-corruption')
    ?? candidates.find(candidate => candidate.kind === 'tool-parameter-loss')
    ?? candidates.find(candidate => candidate.kind === 'tool-parse-failure')
  const sufficient = protocolCause
    ?? candidates.find(candidate => candidate.kind === 'implementation-failure')
    ?? candidates.find(candidate => candidate.kind === 'verification-artifact-missing')
    ?? candidates.find(candidate => candidate.kind === 'verification-artifact-invalid')
    ?? candidates.find(candidate => candidate.kind === 'verification-not-executed')
    ?? candidates.find(candidate => candidate.kind === 'checker-ambiguity')
    ?? candidates.find(candidate => candidate.kind === 'action-inconsistent')
    ?? candidates.find(candidate => candidate.kind === 'process-violation')
    ?? first
  return {
    first,
    candidates,
    sufficientCause: sufficient,
    unresolved: unresolvedTraceHypotheses(replay),
  }
}

/**
 * Trace truncation is an evidence limit, not a failure. It is kept separate
 * from the classified candidates so it cannot be counted as a cause.
 */
function unresolvedTraceHypotheses(replay) {
  const unresolved = []
  if (replay.truncatedSteps.length > 0) {
    unresolved.push({
      kind: 'trace-truncated',
      steps: replay.truncatedSteps,
      detail: `the R36 trace stores at most ${replay.turnTextCapChars ?? 1000} characters per turn; `
        + 'the rest of the model output is not available for offline replay',
    })
  }
  if (replay.unclosedInvokeSteps.length > 0) {
    unresolved.push({
      kind: 'unclosed-invoke-prefix',
      steps: replay.unclosedInvokeSteps,
      detail: 'the saved prefix has no closing invoke tag; this may be model truncation or the trace cap, '
        + 'so it is not classified as a parse failure',
    })
  }
  if (replay.partialWritePrefixSteps.length > 0) {
    unresolved.push({
      kind: 'write-prefix-without-content',
      steps: replay.partialWritePrefixSteps,
      detail: 'the saved prefix shows a write invoke without a content parameter, but the closing tag is beyond the cap',
    })
  }
  return unresolved
}

function checkKind(check) {
  if (check.startsWith('module-load:') || check.startsWith('functionality.')) return 'implementation'
  if (check.startsWith('constraint.claim-known') || check.startsWith('constraint.claim-accuracy')
    || check.startsWith('constraint.tests-or-evidence')
    || check.startsWith('constraint.evidence-bound')) return 'verification'
  if (check.startsWith('constraint.') || check.startsWith('decision.') || check.startsWith('region.')
    || check.startsWith('authority.')) return 'historical'
  return 'other'
}

export function outcomeClass(row) {
  if (row.valid !== true) return { classification: 'invalid-measurement', actionConsistency: 'unattributed' }
  if (row.behaviour?.contractSuccess === true) {
    return { classification: 'contract-success', actionConsistency: 'action-consistent' }
  }
  const failed = row.behaviour?.failedChecks ?? []
  const kinds = new Set(failed.map(checkKind))
  let classification
  if (kinds.has('implementation')) classification = 'implementation-invalid'
  else if (kinds.has('verification')) classification = 'verification-missing'
  else if (kinds.has('historical')) classification = 'action-inconsistent'
  else if (row.behaviour?.processViolation === true) classification = 'process-violation'
  else classification = 'unattributed'
  let actionConsistency = 'unattributed'
  if (classification === 'action-inconsistent') actionConsistency = 'action-inconsistent'
  else if (classification === 'contract-success') actionConsistency = 'action-consistent'
  else if (classification === 'verification-missing') actionConsistency = 'verification-missing'
  else if (classification === 'implementation-invalid') actionConsistency = 'implementation-invalid'
  return { classification, actionConsistency }
}

export function pairOutcome(baseline, treatment, selector) {
  if (baseline.valid !== true || treatment.valid !== true) return 'invalid'
  const left = selector(baseline) === true
  const right = selector(treatment) === true
  if (right && !left) return 'rescue'
  if (!right && left) return 'damage'
  return right ? 'both' : 'neither'
}
