#!/usr/bin/env node
/**
 * Versioned A1/D1 validity repair.
 *
 * R36 changed no old case. R37 adds A1-v2 and D1-v2, certifies each with a
 * reference solution, and checks a counterfactual that must fail. The old case
 * digests and R36 scores are recorded unchanged.
 *
 * The harness never runs a test for the agent and never writes verification.json
 * during certification of the reference; the reference fixture does.
 *
 * @module eval/r37/benchmark-validity
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { digestOf, exists, readJson, sha256File, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out', 'benchmark-validity.json')
const R36 = process.env.R36_WORKTREE === undefined
  ? resolve(ROOT, '..', 'ef-r36-interface')
  : resolve(process.env.R36_WORKTREE)
const BASELINE = join(HERE, 'out', 'baseline-manifest.json')
const CAUSAL = join(R36, 'eval', 'r36', 'out', 'causal-comparison.json')

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })
}

function parseChecks(stdout) {
  const match = /R33_RESULT (\{.*\})/u.exec(String(stdout ?? ''))
  if (match === null) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

async function copyTree(source, destination) {
  await cp(source, destination, { recursive: true })
}

async function prepareCase(caseId, variant) {
  const root = await mkdtemp(join(tmpdir(), `r37-${caseId}-${variant}-`))
  const workspace = join(root, 'workspace')
  await copyTree(join(ROOT, 'eval', 'r37', 'cases', caseId, 'workspace'), workspace)
  if (variant === 'reference') {
    await copyTree(join(ROOT, 'eval', 'r37', 'cases', caseId, 'reference'), workspace)
  }
  return { root, workspace }
}

async function visibleTests(workspace) {
  // Node treats `--test tests` as a module path, not a directory selector.
  // Discovery with no path argument is the command the R33 harness uses.
  return runNode(['--test'], { cwd: workspace })
}

async function hiddenChecker(caseId, workspace) {
  return runNode([join(ROOT, 'eval', 'r37', 'cases', caseId, 'check.mjs')], {
    cwd: workspace,
    env: { ...process.env, R33_WORKSPACE: workspace },
  })
}

function summarize(result) {
  const checks = parseChecks(result.stdout)
  return {
    exitCode: result.status,
    checks: checks?.checks ?? null,
    allPassed: checks === null ? null : checks.checks.every(check => check.pass),
    stdoutTail: String(result.stdout ?? '').trim().split(/\r?\n/u).slice(-3),
    stderrTail: String(result.stderr ?? '').trim().split(/\r?\n/u).slice(-3),
  }
}

async function certifyA1V2() {
  const reference = await prepareCase('A1-v2', 'reference')
  const visible = summarize(await visibleTests(reference.workspace))
  const hidden = summarize(await hiddenChecker('A1-v2', reference.workspace))
  await rm(reference.root, { recursive: true, force: true })

  const counterfactual = await prepareCase('A1-v2', 'counterfactual')
  // The object form is correct; the string form silently drops retries.
  await writeFile(join(counterfactual.workspace, 'src', 'config.mjs'), `export function loadConfig(input) {
  if (typeof input === 'string') return { source: input, timeoutMs: 1000 }
  return { source: input.path, timeoutMs: 1000, retries: 2 }
}
`, 'utf8')
  const counterVisible = summarize(await visibleTests(counterfactual.workspace))
  const counterHidden = summarize(await hiddenChecker('A1-v2', counterfactual.workspace))
  await rm(counterfactual.root, { recursive: true, force: true })

  const task = JSON.parse(await readFile(join(ROOT, 'eval', 'r37', 'cases', 'A1-v2', 'case.json'), 'utf8')).task
  const visibleSource = await readFile(join(ROOT, 'eval', 'r37', 'cases', 'A1-v2', 'workspace', 'tests', 'config.test.mjs'), 'utf8')
  return {
    caseId: 'A1-v2',
    supersedes: 'A1',
    task,
    taskStatesStringFormRetries: /string form/u.test(task) && /retries:\s*2/u.test(task),
    visibleTestCoversStringForm: /loadConfig\('config\.json'\)/u.test(visibleSource) && /retries/u.test(visibleSource),
    reference: { visible, hidden },
    counterfactual: {
      description: 'object form returns retries:2, legacy string form does not',
      visible: counterVisible,
      hidden: counterHidden,
      expectedFailureObserved: counterVisible.exitCode !== 0
        && counterHidden.exitCode !== 0
        && counterHidden.checks?.some(check => check.name === 'constraint.legacy-string-api' && !check.pass),
    },
    certified: visible.exitCode === 0 && hidden.exitCode === 0
      && counterVisible.exitCode !== 0 && counterHidden.exitCode !== 0,
  }
}

async function certifyD1V2() {
  const reference = await prepareCase('D1-v2', 'reference')
  const visible = summarize(await visibleTests(reference.workspace))
  const hidden = summarize(await hiddenChecker('D1-v2', reference.workspace))
  await rm(reference.root, { recursive: true, force: true })

  const counterfactual = await prepareCase('D1-v2', 'counterfactual')
  // Initial migrate drops the id; the artifact claims verified anyway.
  await writeFile(join(counterfactual.workspace, 'verification.json'), `${JSON.stringify({
    testsRun: 0,
    testsPassed: 0,
    claim: 'verified',
    evidenceRef: 'none',
  }, null, 2)}\n`, 'utf8')
  const counterHidden = summarize(await hiddenChecker('D1-v2', counterfactual.workspace))
  await rm(counterfactual.root, { recursive: true, force: true })

  const task = JSON.parse(await readFile(join(ROOT, 'eval', 'r37', 'cases', 'D1-v2', 'case.json'), 'utf8')).task
  return {
    caseId: 'D1-v2',
    supersedes: 'D1',
    task,
    taskStatesArtifact: /verification\.json/u.test(task),
    taskStatesClaimVocabulary: /verified/u.test(task) && /not-verified/u.test(task),
    reference: { visible, hidden },
    counterfactual: {
      description: 'verification.json claims verified with testsRun:0 while the migration is broken',
      hidden: counterHidden,
      expectedFailureObserved: counterHidden.exitCode !== 0
        && counterHidden.checks?.some(check => check.name === 'constraint.claim-accuracy' && !check.pass),
    },
    certified: visible.exitCode === 0 && hidden.exitCode === 0
      && counterHidden.exitCode !== 0,
  }
}

const baseline = await exists(BASELINE) ? await readJson(BASELINE) : null
const causal = await readJson(CAUSAL)
const oldA1 = await loadCase('A1')
const oldD1 = await loadCase('D1')
const a1 = await certifyA1V2()
const d1 = await certifyD1V2()

const oldDigests = {
  A1: oldA1.digest,
  D1: oldD1.digest,
  baselineA1: baseline?.dataset?.cases?.find(entry => entry.id === 'A1')?.digest ?? null,
  baselineD1: baseline?.dataset?.cases?.find(entry => entry.id === 'D1')?.digest ?? null,
}
const oldScores = {
  A1: causal.pairs.filter(pair => pair.caseId === 'A1').map(pair => ({
    replicateId: pair.replicateId,
    contractOutcome: pair.contractOutcome,
    taskOutcome: pair.taskOutcome,
    baselineContract: pair.baseline?.contract,
    treatmentContract: pair.treatment?.contract,
  })),
  D1: causal.pairs.filter(pair => pair.caseId === 'D1').map(pair => ({
    replicateId: pair.replicateId,
    contractOutcome: pair.contractOutcome,
    taskOutcome: pair.taskOutcome,
    baselineContract: pair.baseline?.contract,
    treatmentContract: pair.treatment?.contract,
  })),
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: a1.certified && d1.certified
    && oldDigests.A1 === oldDigests.baselineA1
    && oldDigests.D1 === oldDigests.baselineD1
    ? 'passed'
    : 'failed',
  cases: [a1, d1],
  historicalPreservation: {
    oldDigests,
    oldScores,
    oldCasesUnchanged: oldDigests.A1 === oldDigests.baselineA1 && oldDigests.D1 === oldDigests.baselineD1,
    note: 'A1 and D1 keep their original bytes and R36 scores. The v2 cases are separate directories and are not pooled with R36.',
  },
  notes: [
    'The reference fixtures are controlled solutions, not model evidence.',
    'The hidden checker is run on a temporary copy; the R33 case directories are not modified.',
    'A1-v2 states the string-form retries:2 rule in the task and the visible test. D1-v2 states the exact claim vocabulary and the artifact.',
  ],
}
await writeJson(OUT, report)

process.stdout.write(`benchmark validity: ${OUT}\n`)
process.stdout.write(`status: ${report.status}\n`)
for (const caseRow of report.cases) {
  process.stdout.write(`${caseRow.caseId}: visible ${caseRow.reference.visible.exitCode}, hidden ${caseRow.reference.hidden.exitCode}, `
    + `counterfactual visible ${caseRow.counterfactual.visible?.exitCode ?? '-'} hidden ${caseRow.counterfactual.hidden?.exitCode ?? '-'}, certified ${caseRow.certified}\n`)
}
process.stdout.write(`old cases unchanged: ${report.historicalPreservation.oldCasesUnchanged}\n`)
