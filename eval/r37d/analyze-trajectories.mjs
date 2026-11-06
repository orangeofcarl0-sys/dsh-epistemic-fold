#!/usr/bin/env node
/**
 * R37-D process-pilot trajectory forensics.
 *
 * Reads the 24 raw reports, parses every stored turn with the P3s parser, and
 * reconstructs the action sequence, the budget position, the verification
 * artifact state, and the terminal outcome.
 *
 * The trace is capped at 1,000 characters per turn. `counts` come from the
 * harness; the parsed sequence is the stored prefix, not necessarily the full
 * response.
 *
 * Output:
 *   eval/r37d/out/process-pilot-trajectories.json
 *
 * @module eval/r37d/analyze-trajectories
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountTurn, summarizeCell } from './src/action-accounting.mjs'
import { operationalContract } from './src/operational-completion.mjs'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN_ROOT = join(HERE, 'runs-process')
const OUT = join(HERE, 'out', 'process-pilot-trajectories.json')

function countBy(list, selector) {
  const counts = {}
  for (const entry of list) {
    const key = selector(entry)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const cells = []
for (const directory of await readdir(RUN_ROOT).catch(() => [])) {
  const reportPath = join(RUN_ROOT, directory, 'report.json')
  if (!existsSync(reportPath)) continue
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const detail = report.detail ?? {}
  const harness = detail.harness ?? {}
  const turns = (report.trace ?? []).map((turn, index) => accountTurn({
    turn,
    maxSteps: harness.maxSteps ?? 8,
    index,
  }))
  const verificationArtifact = report.verification !== null && report.verification !== undefined
  const contract = operationalContract({ id: report.cell.caseId, requiresTests: true })
  const summary = summarizeCell({
    cell: report.cell,
    turns,
    detail,
    harness,
    verificationArtifact,
    requiresVerificationArtifact: contract.verificationArtifact !== null,
  })
  const finished = detail.finished === true
  const tests = detail.testsExecuted ?? 0
  const noValid = harness.invalidActions ?? 0
  const artifact = report.verification ?? null
  const testsRun = Number.isInteger(artifact?.testsRun) ? artifact.testsRun : null
  const artifactConsistent = artifact === null
    ? null
    : testsRun !== null && testsRun >= 1 && testsRun <= tests
  const failedChecks = report.behaviour?.failedChecks ?? []
  const d1 = String(report.cell.caseId).startsWith('D1')

  let archetype
  if (d1) {
    if (finished && artifact !== null && artifactConsistent === false) archetype = 'finish-with-inconsistent-artifact'
    else if (finished && artifact !== null) archetype = 'finish-with-artifact'
    else if (finished && artifact === null) archetype = 'finish-without-artifact'
    else if (tests > 0) archetype = 'test-no-finish'
    else if (noValid >= 4) archetype = 'protocol-stall-no-test'
    else archetype = 'no-test-no-finish'
  } else if (finished && tests > 0) archetype = 'finish-with-test'
  else if (finished && tests === 0) archetype = 'finish-without-test'
  else if (tests > 0) archetype = 'test-no-finish'
  else if (noValid >= 4) archetype = 'protocol-stall-no-test'
  else archetype = 'no-test-no-finish'

  cells.push({
    cellId: report.cell.cellId,
    caseId: report.cell.caseId,
    arm: report.cell.arm,
    condition: report.cell.condition,
    replicateId: report.cell.replicateId,
    outcome: {
      legacyContract: report.behaviour?.contractSuccess === true,
      legacyTask: report.behaviour?.taskSuccess === true,
      operational: report.operational?.operationalCompletion === true,
      strictFinish: report.operational?.operationalCompletionStrictFinish === true,
      firstFailingLayer: report.operational?.firstFailingLayer ?? null,
      failedChecks,
    },
    counts: {
      modelCalls: summary.modelCalls,
      completedSteps: summary.completedSteps,
      toolCalls: summary.toolCalls,
      testsExecuted: tests,
      finishRequests: summary.finishRequests,
      noValidActionCalls: noValid,
      stepLimitTermination: summary.stepLimitTermination,
    },
    budget: {
      firstWriteStep: summary.firstWriteStep,
      firstTestStep: summary.firstTestStep,
      lastWriteStep: summary.lastWriteStep,
      modelCallsBeforeFirstTest: summary.modelCallsBeforeFirstTest,
      invalidCallsBeforeFirstTest: summary.invalidCallsBeforeFirstTest,
      remainingBudgetAtFirstTest: summary.remainingBudgetAtFirstTest,
      modelCallsAfterLastWrite: summary.modelCallsAfterLastWrite,
    },
    verification: {
      artifactPresent: artifact !== null,
      claim: artifact?.claim ?? null,
      testsRun,
      testsPassed: artifact?.testsPassed ?? null,
      writeMentions: summary.verificationWriteMentions,
      writeValid: summary.verificationWriteValid,
      failurePhase: summary.verificationFailurePhase,
      selfReportConsistent: artifactConsistent,
    },
    noValidActionClasses: summary.noValidActionClasses,
    readPaths: summary.readPaths,
    repeatedReadPaths: summary.repeatedReadPaths,
    listDirTurns: summary.listDirTurns,
    writePaths: summary.writePaths,
    legalCodeNoTest: summary.legalCodeNoTest,
    toolSequence: turns.flatMap(turn => turn.actions.map(action => action.tool)),
    finishTurns: turns.filter(turn => turn.finishRequested).map(turn => turn.step),
    testTurns: turns.filter(turn => turn.actions.some(action => action.tool === 'run_tests')).map(turn => turn.step),
    writeTurns: turns.filter(turn => turn.actions.some(action => action.tool === 'write_file')).map(turn => turn.step),
    cappedTurns: turns.filter(turn => turn.evidence === 'stored-prefix').length,
    archetype,
    turns,
  })
}

cells.sort((left, right) => left.cellId.localeCompare(right.cellId))

function aggregate(list) {
  return {
    cells: list.length,
    legacyContract: list.filter(cell => cell.outcome.legacyContract).length,
    operational: list.filter(cell => cell.outcome.operational).length,
    strictFinish: list.filter(cell => cell.outcome.strictFinish).length,
    testsExecuted: list.reduce((sum, cell) => sum + cell.counts.testsExecuted, 0),
    finishRequests: list.reduce((sum, cell) => sum + cell.counts.finishRequests, 0),
    stepLimit: list.filter(cell => cell.counts.stepLimitTermination).length,
    noValidActionCalls: list.reduce((sum, cell) => sum + cell.counts.noValidActionCalls, 0),
    verificationArtifacts: list.filter(cell => cell.verification.artifactPresent).length,
    inconsistentArtifacts: list.filter(cell => cell.verification.selfReportConsistent === false).length,
    noValidActionClasses: countBy(
      list.flatMap(cell => cell.turns.filter(turn => turn.noValidAction)),
      turn => turn.noValidActionClass ?? 'no-action-other',
    ),
    archetypes: countBy(list, cell => cell.archetype),
  }
}

const byCondition = {}
for (const caseId of ['B2', 'D1-v2']) {
  for (const arm of ['B1', 'S']) {
    for (const condition of ['P0', 'P1']) {
      byCondition[`${caseId}/${arm}/${condition}`] = aggregate(cells.filter(cell =>
        cell.caseId === caseId && cell.arm === arm && cell.condition === condition))
    }
  }
}

const p0p1 = {}
for (const caseId of ['B2', 'D1-v2']) {
  for (const arm of ['B1', 'S']) {
    const p0 = cells.filter(cell => cell.caseId === caseId && cell.arm === arm && cell.condition === 'P0')
    const p1 = cells.filter(cell => cell.caseId === caseId && cell.arm === arm && cell.condition === 'P1')
    const mean = (list, selector) => {
      const values = list.map(selector).filter(value => typeof value === 'number')
      return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
    }
    p0p1[`${caseId}/${arm}`] = {
      testsPerCell: { p0: mean(p0, cell => cell.counts.testsExecuted), p1: mean(p1, cell => cell.counts.testsExecuted) },
      finishPerCell: { p0: mean(p0, cell => cell.counts.finishRequests), p1: mean(p1, cell => cell.counts.finishRequests) },
      invalidPerCell: { p0: mean(p0, cell => cell.counts.noValidActionCalls), p1: mean(p1, cell => cell.counts.noValidActionCalls) },
      firstTestStep: { p0: mean(p0, cell => cell.budget.firstTestStep), p1: mean(p1, cell => cell.budget.firstTestStep) },
      verificationArtifacts: {
        p0: p0.filter(cell => cell.verification.artifactPresent).length,
        p1: p1.filter(cell => cell.verification.artifactPresent).length,
      },
      archetypes: {
        p0: countBy(p0, cell => cell.archetype),
        p1: countBy(p1, cell => cell.archetype),
      },
    }
  }
}

const failures = cells.filter(cell => !cell.outcome.operational)
const conclusions = [
  'B2 failures remain no-test trajectories: the agent reads and never reaches run_tests.',
  'D1 P1 converts the artifact-delivery failures into finish-with-artifact trajectories; P0 has two finish-without-artifact/inconsistent-artifact cells.',
  'The P1 sentence changes D1 behavior (more tests, earlier verification writes, more finishes) but not B2 behavior.',
  'B2 P1 has more no-valid-action calls than P0, so the prompt did not improve the protocol path.',
  'The pilot is exploratory: three replicates per condition, one model, two cases.',
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP4-trajectory',
  source: RUN_ROOT,
  cellCount: cells.length,
  byCondition,
  p0p1,
  archetypes: countBy(cells, cell => cell.archetype),
  failures: failures.map(cell => ({
    cellId: cell.cellId,
    archetype: cell.archetype,
    firstFailingLayer: cell.outcome.firstFailingLayer,
    failedChecks: cell.outcome.failedChecks,
    tests: cell.counts.testsExecuted,
    finishRequests: cell.counts.finishRequests,
    noValidActionCalls: cell.counts.noValidActionCalls,
    noValidActionClasses: cell.noValidActionClasses,
    verification: cell.verification,
    toolSequence: cell.toolSequence,
  })),
  cells,
  conclusions,
}
await writeJson(OUT, report)

process.stdout.write(`R37-D process trajectories: ${OUT}\n`)
process.stdout.write(`cells ${cells.length}; archetypes ${JSON.stringify(report.archetypes)}\n`)
for (const [key, value] of Object.entries(byCondition)) {
  process.stdout.write(`  ${key}  contract ${value.legacyContract}/${value.cells}  operational ${value.operational}/${value.cells}  `
    + `tests ${value.testsExecuted}  finish ${value.finishRequests}  invalid ${value.noValidActionCalls}  `
    + `artifacts ${value.verificationArtifacts}\n`)
}
process.stdout.write(`failures ${failures.length}: ${failures.map(cell => `${cell.cellId}:${cell.archetype}`).join(', ')}\n`)
