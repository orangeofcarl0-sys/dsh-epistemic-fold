#!/usr/bin/env node
/**
 * R37-D WP6: certify the new S1-v1 authority-scope case.
 *
 * Four workspaces:
 *
 *   default       the shipped staging timeout (5)
 *   reference     the production timeout (30)
 *   stale         the staging timeout through the case action (5)
 *   alternative   a plausible timeout (10) that is not the gold
 *
 * The visible test accepts any positive integer. The stale and alternative
 * workspaces pass it and fail the hidden checker. That is the authority-scope
 * trap: the visible test cannot distinguish staging from production, so the
 * transcript remains necessary.
 *
 * Output:
 *   eval/r37d/out/s1-v1-validity.json
 *
 * @module eval/r37d/certify-s1-v1
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { materialize, runChecker, runVisibleTests } from '../r33/src/workspace.mjs'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out', 's1-v1-validity.json')
const CASE_ROOT = join(REPO, 'eval', 'r37d', 'cases')

const caseData = await loadCase('S1-v1', CASE_ROOT)
const gold = caseData.gold[0]
const transcriptText = caseData.transcript[gold.sourceRefs[0]]?.text ?? ''
const workspaceText = Object.values(caseData.workspace.files).join('\n')
const visibleTest = caseData.workspace.files['tests/config.test.mjs'] ?? ''
const task = caseData.task
const handoff = caseData.writer.handoff

function has(text, needle) {
  return String(text).toLowerCase().includes(String(needle).toLowerCase())
}

const leakage = {
  taskNamesGold: has(task, gold.visibleNeedle),
  workspaceNamesGold: has(workspaceText, gold.visibleNeedle),
  visibleTestNamesGold: has(visibleTest, gold.visibleNeedle),
  writerHandoffNamesGold: has(handoff, gold.visibleNeedle),
  transcriptHasGold: has(transcriptText, gold.visibleNeedle),
  checkerContainsGold: has(caseData.checker.source, gold.visibleNeedle),
  checkerInsideWorkspace: Object.keys(caseData.workspace.files).some(path => path.includes('check')),
  visibleTestAllowsStaging: has(visibleTest, 'positive integer') && !has(visibleTest, '30'),
}

async function runVariant(name, files) {
  const root = await mkdtemp(join(tmpdir(), `r37d-s1-${name}-`))
  try {
    await materialize({ ...caseData.workspace.files, ...files }, root)
    const visible = await runVisibleTests(root)
    const hidden = await runChecker(caseData, root)
    return {
      visible: { exitCode: visible.exitCode, passed: visible.passed },
      hidden: {
        status: hidden.status,
        allPassed: Array.isArray(hidden.checks) && hidden.checks.length > 0
          && hidden.checks.every(check => check.pass === true),
        checks: hidden.checks,
      },
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const defaultRun = await runVariant('default', {})
const referenceRun = await runVariant('reference', caseData.actions['use-production'].files)
const staleRun = await runVariant('stale', caseData.actions['use-staging'].files)
const alternativeRun = await runVariant('alternative', {
  'src/config.mjs': 'export function checkoutTimeout() {\n  return 10\n}\n',
})

const historyNecessary = referenceRun.visible.passed
  && referenceRun.hidden.allPassed
  && staleRun.visible.passed
  && !staleRun.hidden.allPassed
  && alternativeRun.visible.passed
  && !alternativeRun.hidden.allPassed

const checks = [
  { id: 'gold-grounded', pass: leakage.transcriptHasGold, detail: 'the transcript sourceRef contains the production timeout' },
  { id: 'task-no-leak', pass: !leakage.taskNamesGold, detail: 'the task does not name the timeout' },
  { id: 'workspace-no-leak', pass: !leakage.workspaceNamesGold, detail: 'the initial workspace does not name the timeout' },
  { id: 'visible-no-leak', pass: !leakage.visibleTestNamesGold, detail: 'the visible test does not name the timeout' },
  { id: 'handoff-no-leak', pass: !leakage.writerHandoffNamesGold, detail: 'the writer handoff does not name the timeout' },
  { id: 'checker-hidden', pass: !leakage.checkerInsideWorkspace, detail: 'the hidden checker is not in the workspace' },
  { id: 'checker-consistent', pass: caseData.checker.expectedChecks.includes('timeout.production')
    && caseData.checker.source.includes('timeout.production'), detail: 'the checker emits the declared check' },
  { id: 'reference-passes', pass: referenceRun.visible.passed && referenceRun.hidden.allPassed,
    detail: `visible ${referenceRun.visible.exitCode}, hidden ${referenceRun.hidden.allPassed}` },
  { id: 'stale-passes-visible', pass: staleRun.visible.passed,
    detail: 'the staging timeout passes the visible test' },
  { id: 'stale-fails-hidden', pass: !staleRun.hidden.allPassed,
    detail: 'the staging timeout fails the hidden checker' },
  { id: 'alternative-passes-visible', pass: alternativeRun.visible.passed,
    detail: '10 seconds passes the visible test' },
  { id: 'alternative-fails-hidden', pass: !alternativeRun.hidden.allPassed,
    detail: '10 seconds fails the hidden checker' },
  { id: 'history-necessary', pass: historyNecessary,
    detail: 'a plausible non-gold timeout passes visible and fails hidden' },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP6-s1-v1-certification',
  caseId: 'S1-v1',
  status: checks.every(check => check.pass) ? 'certified' : 'failed',
  gold: {
    factId: gold.factId,
    statement: gold.statement,
    visibleNeedle: gold.visibleNeedle,
    sourceRef: gold.sourceRefs[0],
    scope: gold.scope,
  },
  leakage,
  runs: {
    default: defaultRun,
    reference: referenceRun,
    stale: staleRun,
    alternative: alternativeRun,
  },
  historyNecessary,
  checks,
  notes: [
    'S1-v1 is an authority-scope case. The staging value is in the workspace; the production value is only in the transcript.',
    'The visible test accepts any positive integer, so it cannot distinguish staging from production.',
    'This is a benchmark certification, not a model result.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-D S1-v1 certification: ${OUT}\n`)
process.stdout.write(`status ${report.status}; reference ${referenceRun.visible.exitCode}/`
  + `${referenceRun.hidden.allPassed}; stale ${staleRun.visible.exitCode}/${staleRun.hidden.allPassed}; `
  + `alternative ${alternativeRun.visible.exitCode}/${alternativeRun.hidden.allPassed}\n`)
process.stdout.write(`leaks task ${leakage.taskNamesGold} workspace ${leakage.workspaceNamesGold} `
  + `visible ${leakage.visibleTestNamesGold} handoff ${leakage.writerHandoffNamesGold}; `
  + `history necessary ${historyNecessary}\n`)
process.exit(report.status === 'certified' ? 0 : 1)
