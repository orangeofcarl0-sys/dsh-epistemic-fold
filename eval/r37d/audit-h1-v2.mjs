#!/usr/bin/env node
/**
 * R37-D WP6: independent H1-v2 leakage and history-necessity audit.
 *
 * The R37-C certificate says H1-v2 is certified. This script re-reads the case
 * files and re-runs the visible and hidden checks on four workspaces:
 *
 *   default        the shipped stale default
 *   reference      eu-west-2
 *   stale          the false-memory default (us-east-1)
 *   alternative    us-west-2, a plausible region that is not the gold
 *
 * The alternative is the important addition. It shows that a visible test that
 * only forbids us-east-1 is not sufficient: an agent can pass it with a wrong
 * AWS-shaped region. The hidden checker still needs the historical fact.
 *
 * Output:
 *   eval/r37d/out/h1-v2-audit.json
 *
 * @module eval/r37d/audit-h1-v2
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
const OUT = join(HERE, 'out', 'h1-v2-audit.json')
const CASE_ROOT = join(REPO, 'eval', 'r37c', 'cases')

const caseData = await loadCase('H1-v2', CASE_ROOT)
const gold = caseData.gold[0]
const transcriptText = caseData.transcript[gold.sourceRefs[0]]?.text ?? ''
const workspaceText = Object.values(caseData.workspace.files).join('\n')
const visibleTest = caseData.workspace.files['tests/client.test.mjs'] ?? ''
const checkerSource = caseData.checker.source
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
  packageNamesGold: has(caseData.workspace.files['package.json'] ?? '', gold.visibleNeedle),
  transcriptHasGold: has(transcriptText, gold.visibleNeedle),
  checkerContainsGold: has(checkerSource, gold.visibleNeedle),
  checkerInsideWorkspace: Object.keys(caseData.workspace.files).some(path => path.includes('check')),
  visibleTestUsesGenericPattern: /\^\[a-z\]\{2\}-\[a-z\]\+-\\d\$|\^\[a-z\]\{2\}-\[a-z\]\+-\\d\$/u.test(visibleTest),
  visibleTestForbidsStale: has(visibleTest, 'us-east-1'),
}

async function runVariant(name, files) {
  const root = await mkdtemp(join(tmpdir(), `r37d-h1v2-${name}-`))
  try {
    await materialize({ ...caseData.workspace.files, ...files }, root)
    const visible = await runVisibleTests(root)
    const hidden = await runChecker(caseData, root)
    return {
      visible: {
        exitCode: visible.exitCode,
        passed: visible.passed,
      },
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
const referenceRun = await runVariant('reference', caseData.actions['use-eu'].files)
const staleRun = await runVariant('stale', caseData.actions['use-us'].files)
const alternativeRun = await runVariant('alternative', {
  'src/client.mjs': "export function defaultRegion() {\n  return 'us-west-2'\n}\n",
})

const historyNecessary = referenceRun.visible.passed
  && referenceRun.hidden.allPassed
  && !staleRun.visible.passed
  && !staleRun.hidden.allPassed
  && alternativeRun.visible.passed
  && !alternativeRun.hidden.allPassed

const checks = [
  { id: 'gold-grounded', pass: leakage.transcriptHasGold, detail: 'the transcript sourceRef contains the gold region' },
  { id: 'task-no-leak', pass: !leakage.taskNamesGold, detail: 'the task does not name the region' },
  { id: 'workspace-no-leak', pass: !leakage.workspaceNamesGold, detail: 'the initial workspace does not name the region' },
  { id: 'visible-no-leak', pass: !leakage.visibleTestNamesGold, detail: 'the visible test does not name the region' },
  { id: 'handoff-no-leak', pass: !leakage.writerHandoffNamesGold, detail: 'the writer handoff does not name the region' },
  { id: 'checker-hidden', pass: !leakage.checkerInsideWorkspace, detail: 'the hidden checker is not in the workspace' },
  { id: 'checker-consistent', pass: caseData.checker.expectedChecks.includes('region.production')
    && checkerSource.includes('region.production'), detail: 'the checker emits the declared check' },
  { id: 'reference-passes', pass: referenceRun.visible.passed && referenceRun.hidden.allPassed,
    detail: `visible ${referenceRun.visible.exitCode}, hidden ${referenceRun.hidden.allPassed}` },
  { id: 'stale-fails', pass: !staleRun.visible.passed && !staleRun.hidden.allPassed,
    detail: `visible ${staleRun.visible.exitCode}, hidden ${staleRun.hidden.allPassed}` },
  { id: 'alternative-passes-visible', pass: alternativeRun.visible.passed,
    detail: 'us-west-2 passes the visible test' },
  { id: 'alternative-fails-hidden', pass: !alternativeRun.hidden.allPassed,
    detail: 'us-west-2 fails the hidden checker' },
  { id: 'history-necessary', pass: historyNecessary,
    detail: 'a plausible non-gold region passes visible and fails hidden' },
]

const certificate = JSON.parse(await readFile(join(REPO, 'eval', 'r37c', 'out', 'h1-v2-validity.json'), 'utf8'))
const certificateAgreement = {
  status: certificate.status,
  properties: certificate.properties,
  agrees: certificate.certified === true
    && certificate.properties.goldGrounded === true
    && certificate.properties.visibleTestDoesNotNameFact === true
    && certificate.properties.historicalMemoryNecessary === true,
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP6-h1-v2-audit',
  caseId: 'H1-v2',
  status: checks.every(check => check.pass) ? 'passed' : 'failed',
  gold: {
    factId: gold.factId,
    statement: gold.statement,
    visibleNeedle: gold.visibleNeedle,
    sourceRef: gold.sourceRefs[0],
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
  certificateAgreement,
  notes: [
    'H1-v2 remains a benchmark certification, not a model result.',
    'The alternative run uses us-west-2, a region that is not in the case. It is a synthetic control, not an action in the dataset.',
    'The visible test forbids us-east-1 and accepts any AWS-shaped region; only the hidden checker requires eu-west-2.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`R37-D H1-v2 audit: ${OUT}\n`)
process.stdout.write(`status ${report.status}; reference ${referenceRun.visible.exitCode}/`
  + `${referenceRun.hidden.allPassed}; stale ${staleRun.visible.exitCode}/${staleRun.hidden.allPassed}; `
  + `alternative ${alternativeRun.visible.exitCode}/${alternativeRun.hidden.allPassed}\n`)
process.stdout.write(`leaks task ${leakage.taskNamesGold} workspace ${leakage.workspaceNamesGold} `
  + `visible ${leakage.visibleTestNamesGold} handoff ${leakage.writerHandoffNamesGold}; `
  + `history necessary ${historyNecessary}\n`)
process.exit(report.status === 'passed' ? 0 : 1)
