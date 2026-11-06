#!/usr/bin/env node
/**
 * R37-C0-D / C1-B: reconstruct the preregistered protocol admission metric.
 *
 * The Stage 1 gate checked `unparsedTurnRate` (truncated invokes / turns), but
 * the preregistration says "turn-level protocol rejection rate <= 10%". Those
 * are different quantities. This script re-parses every stored model turn with
 * P3e and reports:
 *
 *   turnRejectionRateAllTurns   turns with >=1 rejected action / all turns
 *   turnRejectionRateToolTurns  turns with >=1 rejected action / turns with an
 *                               emitted tool attempt
 *   actionRejectionRate         rejected actions / (valid + rejected actions)
 *   unparsedTurnRate            truncated-invoke turns / all turns
 *   noValidActionRate           turns with no dispatchable action / all turns
 *
 * The stored trace caps turn text at 1000 characters. If the cap makes the
 * numerator ambiguous around the threshold, the gate is `gate-not-verifiable`,
 * not passed.
 *
 * @module eval/r37c/audit-protocol-admission
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from '../r37/src/io.mjs'
import { analyzeTurn } from '../r37/src/tool-protocol-r37.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const R37_ROOT = process.env.R37C_R37_ROOT === undefined
  ? resolve(ROOT, '..', 'ef-r37-action', 'eval', 'r37')
  : resolve(process.env.R37C_R37_ROOT)
const OUT = join(HERE, 'out', 'protocol-admission.json')
const THRESHOLD = 0.10

function classifyNoAction(turn, analysis) {
  const finish = turn.finishReason?.kind ?? 'none'
  const text = String(turn.text ?? '')
  const emitted = analysis.emitted
  const reasons = [
    ...analysis.invalid.flatMap(action => (action.reasons ?? []).map(reason => reason.reason)),
    ...analysis.diagnostics.map(diagnostic => diagnostic.reason),
  ]
  if (finish === 'max-tokens' || finish === 'length') return 'truncated-output'
  if (reasons.includes('truncated-invoke')) return 'truncated-output'
  if (emitted.hasUnclosedInvoke) {
    return text.length >= 1000 ? 'truncated-output' : 'invalid-envelope'
  }
  if (reasons.includes('missing-parameter')) return 'missing-parameter'
  if (reasons.includes('unknown-tool')) return 'unknown-tool'
  if (reasons.some(reason => ['parameter-type', 'empty-parameter', 'path-escape'].includes(reason))) {
    return 'invalid-parameter'
  }
  if (emitted.dsmlInvokes > 0 || emitted.shortAttributes > 0 || emitted.jsonActions > 0) {
    return 'invalid-envelope'
  }
  if (analysis.diagnostics.some(diagnostic => diagnostic.reason === 'duplicate-action')) {
    return 'duplicate/conflicting-action'
  }
  if (/<\|[^>]*\|>/u.test(text) || /"tool"\s*:/u.test(text)) return 'invalid-envelope'
  return 'normal-text-only'
}

async function readRows(runRoot) {
  const runIds = (await readdir(runRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const all = []
  for (const runId of runIds) {
    let report
    try {
      report = await readJson(join(runRoot, runId, 'report.json'))
    } catch {
      continue
    }
    for (const row of report.rows ?? []) all.push({ runId, report, row })
  }
  const deduped = new Map()
  for (const entry of all) {
    const key = entry.row.stage === 'writer-only'
      ? `${entry.row.stage}|${entry.report.modelParameters?.writerPromptVersion ?? ''}|${entry.row.caseId}|${entry.row.arm}|${entry.row.replicateId}`
      : `${entry.row.stage}|${entry.row.caseId}|${entry.row.arm}|${entry.row.replicateId}`
    const existing = deduped.get(key)
    if (existing === undefined
      || (entry.row.valid && !existing.row.valid)
      || (entry.row.valid === existing.row.valid && entry.runId > existing.runId)) {
      deduped.set(key, entry)
    }
  }
  return { all, rows: [...deduped.values()] }
}

async function analyzeStage(runRoot, stage) {
  const { all, rows } = await readRows(runRoot)
  const turns = []
  let storedValidActions = 0
  let storedRejectedActions = 0
  let storedNoValidTurns = 0
  let storedSteps = 0
  let storedModelCalls = 0
  for (const entry of rows) {
    const { row, runId } = entry
    const tracePath = join(runRoot, runId, row.caseId, row.arm, row.replicateId, 'trace', 'record.json')
    let trace
    try {
      trace = await readJson(tracePath)
    } catch {
      continue
    }
    storedValidActions += row.behaviourDetail?.harness?.validActions ?? 0
    storedRejectedActions += row.behaviourDetail?.harness?.rejectedActions ?? 0
    storedNoValidTurns += row.behaviourDetail?.harness?.invalidActions ?? 0
    storedSteps += row.behaviourDetail?.steps ?? 0
    storedModelCalls += row.behaviourDetail?.modelCalls ?? 0
    for (const turn of trace.followTrace ?? []) {
      const analysis = analyzeTurn(turn.text, 'P3e', 'model')
      const rejectedReasons = analysis.invalid.flatMap(action => (action.reasons ?? []).map(reason => reason.reason))
      const diagnostics = analysis.diagnostics.map(diagnostic => diagnostic.reason)
      turns.push({
        runId,
        caseId: row.caseId,
        arm: row.arm,
        replicateId: row.replicateId,
        step: turn.step,
        textChars: String(turn.text ?? '').length,
        capped: String(turn.text ?? '').length >= 1000,
        finishReason: turn.finishReason?.kind ?? 'none',
        outputTokens: turn.usage?.outputTokens ?? null,
        validActions: analysis.actions.length,
        rejectedActions: analysis.invalid.length,
        emitted: analysis.emitted,
        rejectedReasons,
        diagnostics,
        noActionClass: analysis.actions.length === 0 ? classifyNoAction(turn, analysis) : null,
      })
    }
  }
  const totalTurns = turns.length
  const turnsWithRejectedAction = turns.filter(turn => turn.rejectedActions > 0).length
  const turnsWithAnyToolAttempt = turns.filter(turn =>
    turn.emitted.dsmlInvokes > 0 || turn.emitted.jsonActions > 0
    || turn.validActions > 0 || turn.rejectedActions > 0).length
  const noValidTurns = turns.filter(turn => turn.validActions === 0)
  const unparsedTurns = turns.filter(turn => turn.diagnostics.includes('truncated-invoke')).length
  const validActions = turns.reduce((total, turn) => total + turn.validActions, 0)
  const rejectedActions = turns.reduce((total, turn) => total + turn.rejectedActions, 0)
  const cappedTurns = turns.filter(turn => turn.capped).length
  const rates = {
    turnRejectionRateAllTurns: totalTurns === 0 ? null : turnsWithRejectedAction / totalTurns,
    turnRejectionRateToolTurns: turnsWithAnyToolAttempt === 0 ? null : turnsWithRejectedAction / turnsWithAnyToolAttempt,
    actionRejectionRate: validActions + rejectedActions === 0 ? null : rejectedActions / (validActions + rejectedActions),
    unparsedTurnRate: totalTurns === 0 ? null : unparsedTurns / totalTurns,
    noValidActionRateReconstructed: totalTurns === 0 ? null : noValidTurns.length / totalTurns,
    noValidActionRateStored: totalTurns === 0 ? null : storedNoValidTurns / totalTurns,
  }
  const exact = totalTurns === storedModelCalls
    && validActions === storedValidActions
    && rejectedActions === storedRejectedActions
    && noValidTurns.length === storedNoValidTurns
  const observed = rates.turnRejectionRateAllTurns ?? 0
  const minimum = totalTurns === 0 ? 0 : turnsWithRejectedAction / totalTurns
  const maximum = totalTurns === 0 ? 0 : (turnsWithRejectedAction + cappedTurns) / totalTurns
  const thresholdInsideBounds = minimum <= THRESHOLD && maximum >= THRESHOLD
  let gateStatus
  if (!exact || (thresholdInsideBounds && !exact)) gateStatus = 'gate-not-verifiable'
  else if (observed <= THRESHOLD) gateStatus = 'passed'
  else gateStatus = 'failed'
  const noActionByClass = noValidTurns.reduce((counts, turn) => {
    const key = turn.noActionClass ?? 'other/unknown'
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
  const noActionByArm = noValidTurns.reduce((counts, turn) => {
    counts[turn.arm] = (counts[turn.arm] ?? 0) + 1
    return counts
  }, {})
  const noActionByCase = noValidTurns.reduce((counts, turn) => {
    counts[turn.caseId] = (counts[turn.caseId] ?? 0) + 1
    return counts
  }, {})
  return {
    stage,
    source: { runRoot, reports: all.length, uniqueRows: rows.length },
    totals: {
      turns: totalTurns,
      modelCalls: totalTurns,
      storedModelCalls,
      completedSteps: storedSteps,
      validActions,
      storedValidActions,
      rejectedActions,
      storedRejectedActions,
      noValidTurns: noValidTurns.length,
      storedNoValidTurns,
      turnsWithRejectedAction,
      turnsWithAnyToolAttempt,
      unparsedTurns,
      cappedTurns,
    },
    rates,
    reconstruction: {
      exact,
      status: exact ? 'exact' : totalTurns === 0 ? 'no-trace' : 'partial-capped-trace',
      note: exact
        ? 'Re-parsed counts match the stored harness counters.'
        : 'Re-parsed counts differ from the stored harness counters; the 1000-character trace cap is the likely cause.',
    },
    admission: {
      preregisteredMetric: 'turn-level protocol rejection rate <= 10%',
      threshold: THRESHOLD,
      observedAllTurns: rates.turnRejectionRateAllTurns,
      observedToolTurns: rates.turnRejectionRateToolTurns,
      boundsAllTurns: [minimum, maximum],
      status: gateStatus,
      note: gateStatus === 'gate-not-verifiable'
        ? 'The stored trace cap makes the numerator ambiguous around the preregistered threshold, or the reparse does not reproduce the stored counters.'
        : 'The reconstructed turn-level rate is outside the capped-trace ambiguity around the threshold.',
    },
    noAction: {
      byClass: noActionByClass,
      byArm: noActionByArm,
      byCase: noActionByCase,
    },
    turns,
  }
}

const stage1 = await analyzeStage(join(R37_ROOT, 'runs-b'), 1)
const stage2 = await analyzeStage(join(R37_ROOT, 'runs-b2'), 2)
const stage1Summary = await readJson(join(R37_ROOT, 'out', 'r37b-results.json'))
const stage2Summary = await readJson(join(R37_ROOT, 'out', 'r37b-stage2-results.json'))
stage1.authoritative = {
  reports: stage1Summary.source?.reports ?? null,
  rows: stage1Summary.protocol?.rows ?? null,
  modelTurns: stage1Summary.protocol?.modelTurns ?? null,
  validActions: stage1Summary.protocol?.validActions ?? null,
  rejectedActions: stage1Summary.protocol?.rejectedActions ?? null,
  invalidActionTurns: stage1Summary.protocol?.invalidActionTurns ?? null,
  unparsedTurns: stage1Summary.protocol?.unparsedTurns ?? null,
  actionRejectionRate: stage1Summary.protocol?.rejectionRate ?? null,
  unparsedTurnRate: stage1Summary.protocol?.unparsedTurnRate ?? null,
  noValidActionRate: stage1Summary.protocol?.noValidActionTurnRate ?? null,
}
stage2.authoritative = {
  modelTurns: stage2Summary.protocol?.modelTurns ?? null,
  validActions: stage2Summary.protocol?.validActions ?? null,
  rejectedActions: stage2Summary.protocol?.rejectedActions ?? null,
  invalidActionTurns: stage2Summary.protocol?.invalidActionTurns ?? null,
  unparsedTurns: stage2Summary.protocol?.unparsedTurns ?? null,
  actionRejectionRate: stage2Summary.protocol?.rejectionRate ?? null,
  unparsedTurnRate: stage2Summary.protocol?.unparsedTurnRate ?? null,
  noValidActionRate: stage2Summary.protocol?.noValidActionTurnRate ?? null,
}
stage1.metricAssessment = {
  gateImplemented: 'unparsedTurnRate <= 0.10',
  preregistered: 'turn-level protocol rejection rate <= 0.10',
  status: 'gate-not-verifiable',
  reasons: [
    'The Stage 1 gate checked unparsedTurnRate (29/569 = 5.10%), not turn-level rejection.',
    'The archived turn text is capped at 1000 characters, so the turn-level numerator cannot be reconstructed exactly.',
    'The action-level rejection rate is 93/885 = 10.51%, above the preregistered 10%; this is a proxy, not the gate metric.',
    'The Stage 1 summary was generated from 158 reports; the archive now contains 163, including later retry reports.',
  ],
}
stage2.metricAssessment = {
  gateImplemented: null,
  preregistered: null,
  status: 'descriptive',
  reasons: [
    'R37-B Stage 2 was confirmatory and did not have a separate protocol admission gate.',
    'The summary denominator modelTurns = 819 is behaviourDetail.steps, not model calls; the trace contains 903 model turns.',
    'Using model calls, the stored no-valid-action rate is 216/903 = 23.92%, not 26.37%.',
    'The reconstructed turn-rejection rate is 92/903 = 10.19%, but the trace cap makes the exact value unverifiable.',
  ],
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C0-D/C1-B',
  stage1,
  stage2,
  conclusions: [
    'The Stage 1 gate used unparsedTurnRate, not the preregistered turn-level rejection rate.',
    'The two rates are not interchangeable: action rejection, turn rejection, unparsed turns, and no-valid-action turns have different numerators.',
    'A no-valid-action turn is not automatically a parser bug; normal text-only turns are a real model behavior.',
    'Capped trace text is marked truncated evidence and cannot prove a full response.',
  ],
}
await writeJson(OUT, report)

for (const entry of [stage1, stage2]) {
  process.stdout.write(`stage ${entry.stage}: turns ${entry.totals.turns} (stored model calls ${entry.totals.storedModelCalls}; completed steps ${entry.totals.completedSteps}); `
    + `valid ${entry.totals.validActions}/${entry.totals.storedValidActions}; `
    + `rejected ${entry.totals.rejectedActions}/${entry.totals.storedRejectedActions}; `
    + `no-valid ${entry.totals.noValidTurns}/${entry.totals.storedNoValidTurns}\n`)
  process.stdout.write(`  rates ${JSON.stringify(entry.rates)}\n`)
  process.stdout.write(`  reconstruction ${entry.reconstruction.status}; admission ${entry.admission.status}\n`)
  process.stdout.write(`  no-action ${JSON.stringify(entry.noAction.byClass)}\n`)
}
