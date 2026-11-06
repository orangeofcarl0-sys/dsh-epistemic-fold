#!/usr/bin/env node
/**
 * R37-D WP1: compute layered operational completion without rewriting legacy
 * scores.
 *
 * Two datasets:
 *
 *   C2   24 continuation cells, audited in WP0
 *   R37-B Stage 2   218 rows; 146 continuation, 72 writer-only
 *
 * Writer-only rows have no agent workspace and are recorded as
 * `not-applicable`, not as failures.
 *
 * Output:
 *   eval/r37d/out/operational-completion.json
 *
 * @module eval/r37d/operational-completion
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyOperationalCompletion,
  OPERATIONAL_SCORER_VERSION,
} from './src/operational-completion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const R37C = process.env.R37C_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37c-closure'
const R37B = process.env.R37B_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37-action'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function casePath(caseId) {
  for (const candidate of [
    join(REPO, 'eval', 'r37', 'cases', caseId, 'case.json'),
    join(REPO, 'eval', 'r33', 'cases', caseId, 'case.json'),
    join(R37C, 'eval', 'r37c', 'cases', caseId, 'case.json'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const caseCache = new Map()
async function loadCase(caseId) {
  if (caseCache.has(caseId)) return caseCache.get(caseId)
  const path = casePath(caseId)
  const data = path === null ? null : await readJson(path)
  caseCache.set(caseId, data)
  return data
}

async function readVerification(workspace) {
  const path = join(workspace, 'verification.json')
  if (!existsSync(path)) return undefined
  try {
    return await readJson(path)
  } catch {
    return { malformed: true }
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

function transitions(rows) {
  const table = {
    legacyPassOperationalPass: 0,
    legacyPassOperationalFail: 0,
    legacyFailOperationalPass: 0,
    legacyFailOperationalFail: 0,
  }
  for (const row of rows) {
    if (row.legacy.contractSuccess && row.operationalCompletion) table.legacyPassOperationalPass += 1
    else if (row.legacy.contractSuccess && !row.operationalCompletion) table.legacyPassOperationalFail += 1
    else if (!row.legacy.contractSuccess && row.operationalCompletion) table.legacyFailOperationalPass += 1
    else table.legacyFailOperationalFail += 1
  }
  return table
}

function summarize(rows) {
  return {
    rows: rows.length,
    legacyContractSuccesses: rows.filter(row => row.legacy.contractSuccess).length,
    legacyTaskSuccesses: rows.filter(row => row.legacy.taskSuccess).length,
    operationalCompletions: rows.filter(row => row.operationalCompletion).length,
    operationalStrictFinish: rows.filter(row => row.operationalCompletionStrictFinish).length,
    artifactCorrect: rows.filter(row => row.artifact.artifactCorrectness).length,
    verificationComplete: rows.filter(row => row.verification.verificationCompleteness).length,
    acceptableTermination: rows.filter(row => row.termination.acceptableTermination).length,
    finishAccepted: rows.filter(row => row.termination.finishAccepted).length,
    stepLimitTermination: rows.filter(row => row.termination.stepLimitTermination).length,
    firstFailingLayer: countBy(rows, row => row.firstFailingLayer ?? 'none'),
    terminationReason: countBy(rows, row => row.termination.terminationReason),
    transitions: transitions(rows),
  }
}

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

const c2Results = await readJson(join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'))
const c2Rows = []
for (const entry of c2Results.results) {
  if (entry.status !== 'executed' || !existsSync(entry.reportPath)) continue
  const report = await readJson(entry.reportPath)
  const row = report.rows?.[0]
  if (row === undefined) continue
  const caseData = await loadCase(entry.cell.caseId)
  const base = join(
    dirname(entry.reportPath),
    entry.cell.caseId,
    entry.cell.arm,
    entry.cell.replicateId,
  )
  const verification = await readVerification(join(base, 'workspace'))
  const classified = classifyOperationalCompletion({
    caseData: caseData ?? { id: entry.cell.caseId, requiresTests: true },
    behaviour: row.behaviour ?? {},
    detail: row.behaviourDetail ?? {},
    checker: row.checker ?? {},
    run: entry.run ?? null,
    verification,
  })
  c2Rows.push({
    source: 'C2',
    cellId: entry.cell.cellId,
    caseId: entry.cell.caseId,
    arm: entry.cell.arm,
    guard: entry.cell.guard,
    replicateId: entry.cell.replicateId,
    testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
    steps: row.behaviourDetail?.steps ?? 0,
    modelCalls: row.behaviourDetail?.modelCalls ?? 0,
    ...classified,
  })
}

// ---------------------------------------------------------------------------
// R37-B Stage 2
// ---------------------------------------------------------------------------

const runsRoot = join(R37B, 'eval', 'r37', 'runs-b2')
const runNames = existsSync(runsRoot)
  ? (await readdir(runsRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  : []
const r37bRows = []
const r37bNotApplicable = []
for (const runName of runNames) {
  const reportPath = join(runsRoot, runName, 'report.json')
  if (!existsSync(reportPath)) continue
  const report = await readJson(reportPath)
  for (const row of report.rows ?? []) {
    if (row.stage !== 'continuation') {
      r37bNotApplicable.push({
        runId: runName,
        stage: row.stage,
        arm: row.arm,
        caseId: row.caseId,
        reason: 'writer-only row has no agent workspace',
      })
      continue
    }
    const caseData = await loadCase(row.caseId)
    const base = join(dirname(reportPath), row.caseId, row.arm, row.replicateId)
    const verification = await readVerification(join(base, 'workspace'))
    const classified = classifyOperationalCompletion({
      caseData: caseData ?? { id: row.caseId, requiresTests: true },
      behaviour: row.behaviour ?? {},
      detail: row.behaviourDetail ?? {},
      checker: row.checker ?? {},
      run: null,
      verification,
    })
    r37bRows.push({
      source: 'R37-B-stage2',
      cellId: `${row.runId}/${row.caseId}/${row.arm}/${row.replicateId}`,
      runId: row.runId,
      caseId: row.caseId,
      arm: row.arm,
      stage: row.stage,
      replicateId: row.replicateId,
      valid: row.valid,
      testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
      steps: row.behaviourDetail?.steps ?? 0,
      modelCalls: row.behaviourDetail?.modelCalls ?? 0,
      ...classified,
    })
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const c2Summary = summarize(c2Rows)
const r37bSummary = summarize(r37bRows)
const r37bByArm = Object.fromEntries(
  [...new Set(r37bRows.map(row => row.arm))].sort().map(arm => [
    arm,
    summarize(r37bRows.filter(row => row.arm === arm)),
  ]),
)

const discrepancies = []
for (const row of [...c2Rows, ...r37bRows]) {
  if (row.operationalCompletion && !row.artifact.artifactCorrectness) {
    discrepancies.push({ cellId: row.cellId, detail: 'operational completion without artifact correctness' })
  }
  if (row.operationalCompletion && !row.verification.verificationCompleteness) {
    discrepancies.push({ cellId: row.cellId, detail: 'operational completion without verification completeness' })
  }
  if (row.operationalCompletion && !row.termination.acceptableTermination) {
    discrepancies.push({ cellId: row.cellId, detail: 'operational completion with unacceptable termination' })
  }
}

const legacyGap = {
  c2: c2Rows
    .filter(row => row.legacy.contractSuccess && !row.operationalCompletion)
    .map(row => ({
      cellId: row.cellId,
      firstFailingLayer: row.firstFailingLayer,
      testsExecuted: row.testsExecuted,
      lastTestPassed: row.verification.lastTestPassed,
      lastTestFresh: row.verification.lastTestFresh,
      verificationClaim: row.verification.claim,
      verificationCompleteness: row.verification.verificationCompleteness,
      terminationReason: row.termination.terminationReason,
    })),
  r37bStage2: r37bRows
    .filter(row => row.legacy.contractSuccess && !row.operationalCompletion)
    .map(row => ({
      cellId: row.cellId,
      arm: row.arm,
      caseId: row.caseId,
      firstFailingLayer: row.firstFailingLayer,
      testsExecuted: row.testsExecuted,
      lastTestPassed: row.verification.lastTestPassed,
      lastTestFresh: row.verification.lastTestFresh,
      verificationClaim: row.verification.claim,
      verificationCompleteness: row.verification.verificationCompleteness,
      terminationReason: row.termination.terminationReason,
    })),
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP1-operational-completion',
  scorerVersion: OPERATIONAL_SCORER_VERSION,
  sources: {
    c2Results: join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'),
    r37bRuns: runsRoot,
  },
  contracts: {
    note: 'requiresTests comes from the case; the verification artifact and termination contract are declared in eval/r37d/src/operational-completion.mjs',
    verificationArtifactCases: ['D1', 'D1-v2', 'D2'],
    termination: {
      'finish-optional': 'finish accepted, or a step limit after the work is complete; efficiency is reported separately',
      'finish-required': 'only an accepted finish is acceptable',
    },
  },
  c2: {
    summary: c2Summary,
    rows: c2Rows,
  },
  r37bStage2: {
    summary: r37bSummary,
    byArm: r37bByArm,
    notApplicable: r37bNotApplicable,
    rows: r37bRows,
  },
  legacyGap,
  discrepancies,
  notes: [
    'Legacy contractSuccess is copied, never recomputed or rewritten.',
    'Operational completion requires artifact correctness, verification completeness, and acceptable termination.',
    'A step-limit termination after complete work is acceptable but not efficient; efficientTermination is reported separately.',
    'The R37-B Stage 2 rows are descriptive. This artifact does not revise the preregistered R37-B result.',
    'Writer-only rows are not-applicable, not failures.',
  ],
}

await writeFile(join(OUT, 'operational-completion.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

process.stdout.write(`R37-D operational completion: ${join(OUT, 'operational-completion.json')}\n`)
process.stdout.write(`C2: ${c2Summary.rows} rows; legacy contract ${c2Summary.legacyContractSuccesses}; `
  + `operational ${c2Summary.operationalCompletions}; strict-finish ${c2Summary.operationalStrictFinish}; `
  + `legacy-pass/operational-fail ${c2Summary.transitions.legacyPassOperationalFail}\n`)
process.stdout.write(`C2 first failing layer ${JSON.stringify(c2Summary.firstFailingLayer)}\n`)
process.stdout.write(`R37-B Stage 2: ${r37bSummary.rows} continuation rows; legacy contract `
  + `${r37bSummary.legacyContractSuccesses}; operational ${r37bSummary.operationalCompletions}; `
  + `legacy-pass/operational-fail ${r37bSummary.transitions.legacyPassOperationalFail}\n`)
process.stdout.write(`R37-B first failing layer ${JSON.stringify(r37bSummary.firstFailingLayer)}\n`)
process.stdout.write(`discrepancies ${discrepancies.length}\n`)
process.exit(discrepancies.length === 0 ? 0 : 1)
