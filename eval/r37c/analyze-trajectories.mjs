#!/usr/bin/env node
/**
 * R37-C2 trajectory forensics.
 *
 * The guard effect is an intention-to-treat difference. It does not tell us
 * whether the guard actually fired. This script reconstructs each cell's
 * action trajectory and separates:
 *
 *   guard opportunity   the agent requested finish
 *   guard action        the request was rejected
 *   recovery            the agent ran a test or finished after the rejection
 *   step-limit          the agent used all eight steps without finishing
 *
 * The trace text is capped at 1,000 characters; action sequences are marked
 * capped when the cap prevents a complete parse. The stored harness counters
 * remain authoritative for totals.
 *
 * @module eval/r37c/analyze-trajectories
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeTurnStrict } from './src/dsml-codec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, 'out', 'r37c-c2-results.json')
const OUT = join(HERE, 'out', 'r37c-c2-trajectories.json')

const results = JSON.parse(await readFile(RESULTS, 'utf8'))
const cells = []

for (const entry of results.results ?? []) {
  if (entry.status !== 'executed' || entry.reportPath === undefined) continue
  let report
  try {
    report = JSON.parse(await readFile(entry.reportPath, 'utf8'))
  } catch {
    continue
  }
  const row = report.rows?.[0]
  if (row === undefined) continue
  const base = join(
    dirname(entry.reportPath),
    entry.cell.caseId,
    entry.cell.arm,
    entry.cell.replicateId,
  )
  let trace = null
  try {
    trace = JSON.parse(await readFile(join(base, 'trace', 'record.json'), 'utf8'))
  } catch {
    trace = null
  }
  const behaviour = row.behaviourDetail ?? {}
  const guard = behaviour.finishGuard ?? {}
  const harness = behaviour.harness ?? {}
  const turns = (trace?.followTrace ?? []).map(turn => {
    const text = String(turn.text ?? '')
    const analysis = analyzeTurnStrict(text, 'model')
    return {
      step: turn.step,
      textChars: text.length,
      capped: text.length >= 1000,
      finishReason: turn.finishReason?.kind ?? 'none',
      tools: analysis.actions.map(action => action.tool),
      invalid: analysis.invalid.length,
      diagnostics: analysis.diagnostics.map(diagnostic => diagnostic.reason),
      noAction: analysis.actions.length === 0,
    }
  })
  const toolSequence = turns.flatMap(turn => turn.tools)
  const finishTurns = turns.filter(turn => turn.tools.includes('finish')).map(turn => turn.step)
  const testTurns = turns.filter(turn => turn.tools.includes('run_tests')).map(turn => turn.step)
  const writeTurns = turns.filter(turn => turn.tools.includes('write_file')).map(turn => turn.step)
  const testRunSteps = (behaviour.testRuns ?? []).map(run => run.step).filter(step => typeof step === 'number')
  const tests = behaviour.testsExecuted ?? 0
  const rejectionCheck = guard.rejections > 0
    ? (guard.checks ?? []).find(check => check.fresh === false) ?? null
    : null
  const firstRejection = rejectionCheck?.step ?? null
  const testsAtRejection = rejectionCheck?.testsExecuted ?? null
  const postRejectionTestCount = testsAtRejection === null ? null : Math.max(0, tests - testsAtRejection)
  const postRejectionTests = firstRejection === null
    ? []
    : testRunSteps.filter(step => step > firstRejection)
  const postRejectionFinish = firstRejection === null
    ? []
    : finishTurns.filter(step => step > firstRejection)
  const finished = behaviour.finished === true
  const steps = behaviour.steps ?? null
  const contract = row.behaviour?.contractSuccess === true
  const task = row.behaviour?.taskSuccess === true
  const failedChecks = row.behaviour?.failedChecks ?? []

  let archetype
  const laterFinishAccepted = (guard.finishRequests ?? 0) > (guard.rejections ?? 0)
  if (guard.rejections > 0 && (guard.assistedCompletion === true || laterFinishAccepted)) {
    archetype = 'guard-rejected-recovered-finish'
  } else if (guard.rejections > 0 && ((postRejectionTestCount ?? 0) > 0 || postRejectionTests.length > 0)) {
    archetype = 'guard-rejected-recovered-test'
  } else if (guard.rejections > 0) {
    archetype = 'guard-rejected-stalled'
  } else if (finished && tests > 0) {
    archetype = 'finish-with-test'
  } else if (finished && tests === 0) {
    archetype = 'finish-without-test'
  } else if (tests > 0) {
    archetype = 'test-no-finish'
  } else if ((harness.invalidActions ?? 0) >= 4) {
    archetype = 'protocol-stall-no-test'
  } else {
    archetype = 'no-test-no-finish'
  }

  cells.push({
    runId: entry.runId,
    cellId: entry.cell.cellId,
    caseId: entry.cell.caseId,
    arm: entry.cell.arm,
    guard: entry.cell.guard,
    contract,
    task,
    failedChecks,
    tests,
    steps,
    modelCalls: behaviour.modelCalls ?? null,
    finished,
    finishRequests: guard.finishRequests ?? 0,
    finishRejections: guard.rejections ?? 0,
    assistedCompletion: guard.assistedCompletion === true,
    invalidActionTurns: harness.invalidActions ?? 0,
    rejectedActions: harness.rejectedActions ?? 0,
    toolCounts: harness.toolCounts ?? {},
    toolSequence,
    finishTurns,
    testTurns,
    writeTurns,
    firstRejectionStep: firstRejection,
    testsAtRejection,
    postRejectionTestCount,
    postRejectionTests,
    postRejectionFinish,
    cappedTurns: turns.filter(turn => turn.capped).length,
    turns,
    archetype,
    delivery: entry.delivery ?? entry.row?.delivery ?? null,
    foldFallback: row.foldFallback ?? null,
  })
}

function countBy(list, selector) {
  const counts = {}
  for (const entry of list) {
    const key = selector(entry)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const failures = cells.filter(cell => !cell.contract || !cell.task)
const guardTriggered = cells.filter(cell => cell.finishRejections > 0)
const guardOpportunity = cells.filter(cell => cell.finishRequests > 0)
const noFinish = cells.filter(cell => cell.finishRequests === 0)
const contractFailures = cells.filter(cell => !cell.contract)
const contractFailuresNoFinish = contractFailures.filter(cell => cell.finishRequests === 0)
const contractFailuresGuardTriggered = contractFailures.filter(cell => cell.finishRejections > 0)

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C2-trajectory',
  source: RESULTS,
  cells: cells.length,
  summary: {
    contractSuccesses: cells.filter(cell => cell.contract).length,
    taskSuccesses: cells.filter(cell => cell.task).length,
    finishRequests: cells.filter(cell => cell.finishRequests > 0).length,
    noFinishRequests: noFinish.length,
    guardTriggered: guardTriggered.length,
    guardAssisted: cells.filter(cell => cell.assistedCompletion).length,
    guardOpportunity: guardOpportunity.length,
    contractFailures: contractFailures.length,
    contractFailuresNoFinish: contractFailuresNoFinish.length,
    contractFailuresGuardTriggered: contractFailuresGuardTriggered.length,
  },
  byArchetype: countBy(cells, cell => cell.archetype),
  byArmGuard: Object.fromEntries(
    ['B1', 'S'].flatMap(arm => ['G0', 'G1'].map(guard => {
      const selected = cells.filter(cell => cell.arm === arm && cell.guard === guard)
      return [`${arm}/${guard}`, {
        cells: selected.length,
        contract: selected.filter(cell => cell.contract).length,
        task: selected.filter(cell => cell.task).length,
        finishRequests: selected.filter(cell => cell.finishRequests > 0).length,
        guardTriggered: selected.filter(cell => cell.finishRejections > 0).length,
        assisted: selected.filter(cell => cell.assistedCompletion).length,
        archetypes: countBy(selected, cell => cell.archetype),
      }]
    })),
  ),
  guardTriggeredCells: guardTriggered.map(cell => ({
    cellId: cell.cellId,
    contract: cell.contract,
    task: cell.task,
    tests: cell.tests,
    steps: cell.steps,
    finishRequests: cell.finishRequests,
    finishRejections: cell.finishRejections,
    firstRejectionStep: cell.firstRejectionStep,
    postRejectionTests: cell.postRejectionTests,
    postRejectionFinish: cell.postRejectionFinish,
    assistedCompletion: cell.assistedCompletion,
    archetype: cell.archetype,
    failedChecks: cell.failedChecks,
  })),
  contractFailures: contractFailures.map(cell => ({
    cellId: cell.cellId,
    arm: cell.arm,
    guard: cell.guard,
    task: cell.task,
    tests: cell.tests,
    steps: cell.steps,
    finishRequests: cell.finishRequests,
    finishRejections: cell.finishRejections,
    invalidActionTurns: cell.invalidActionTurns,
    rejectedActions: cell.rejectedActions,
    failedChecks: cell.failedChecks,
    archetype: cell.archetype,
    toolSequence: cell.toolSequence,
    cappedTurns: cell.cappedTurns,
  })),
  cells,
  conclusions: [
    'The guard can only act when the agent requests finish.',
    'All five contract failures never requested finish, so the guard had no opportunity to cause or prevent them.',
    'The intention-to-treat guard difference is therefore not a guard mechanism effect in this pilot.',
    'The guard-triggered subset is four cells; three recovered enough to pass the contract without a second finish, one completed with a second finish.',
    'Most failures are step-limit or protocol-waste trajectories: the agent keeps reading or emitting invalid actions instead of running a test.',
    'A process prompt or a step/test-request intervention is a better next target than another guard.',
  ],
}

await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`R37-C C2 trajectories: ${OUT}\n`)
process.stdout.write(`cells ${cells.length}; contract ${report.summary.contractSuccesses}/${cells.length}; task ${report.summary.taskSuccesses}/${cells.length}\n`)
process.stdout.write(`finish requested ${report.summary.finishRequests}; guard triggered ${report.summary.guardTriggered}; assisted ${report.summary.guardAssisted}\n`)
process.stdout.write(`contract failures ${report.summary.contractFailures}; no finish ${report.summary.contractFailuresNoFinish}; guard triggered ${report.summary.contractFailuresGuardTriggered}\n`)
process.stdout.write(`archetypes ${JSON.stringify(report.byArchetype)}\n`)
