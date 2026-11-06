#!/usr/bin/env node
/**
 * R37-C3: certify H1-v2 without leaking the historical fact.
 *
 * H1's visible test only checked the type, so an agent could pass it while
 * shipping the stale us-east-1 default. H1-v2's visible test rejects us-east-1
 * and requires an AWS-shaped region, but does not name eu-west-2. The hidden
 * checker still requires eu-west-2. The historical transcript remains the only
 * source of the exact value.
 *
 * @module eval/r37c/certify-h1-v2
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CASE_ROOT = join(HERE, 'cases', 'H1-v2')
const OUT = join(HERE, 'out', 'h1-v2-validity.json')

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000, ...options })
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

async function prepare(action) {
  const root = await mkdtemp(join(tmpdir(), `r37c-h1v2-${action ?? 'default'}-`))
  const workspace = join(root, 'workspace')
  await cp(join(CASE_ROOT, 'workspace'), workspace, { recursive: true })
  if (action !== null) await cp(join(CASE_ROOT, 'actions', action), workspace, { recursive: true })
  return { root, workspace }
}

async function visible(workspace) {
  return summarize(runNode(['--test'], { cwd: workspace }))
}

async function hidden(workspace) {
  return summarize(runNode([join(CASE_ROOT, 'check.mjs')], {
    cwd: workspace,
    env: { ...process.env, R33_WORKSPACE: workspace },
  }))
}

const caseData = await loadCase('H1-v2', join(HERE, 'cases'))
const visibleSource = await readFile(join(CASE_ROOT, 'workspace', 'tests', 'client.test.mjs'), 'utf8')
const transcript = caseData.transcript.map(entry => entry.text).join('\n')

const defaultRun = await prepare(null)
const defaultVisible = await visible(defaultRun.workspace)
const defaultHidden = await hidden(defaultRun.workspace)
await rm(defaultRun.root, { recursive: true, force: true })

const reference = await prepare('use-eu')
const referenceVisible = await visible(reference.workspace)
const referenceHidden = await hidden(reference.workspace)
await rm(reference.root, { recursive: true, force: true })

const counterfactual = await prepare('use-us')
const counterVisible = await visible(counterfactual.workspace)
const counterHidden = await hidden(counterfactual.workspace)
await rm(counterfactual.root, { recursive: true, force: true })

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C3',
  caseId: 'H1-v2',
  supersedes: 'H1',
  status: 'certified',
  properties: {
    goldGrounded: transcript.includes('Production deployment region: eu-west-2'),
    taskSolvable: referenceVisible.exitCode === 0 && referenceHidden.exitCode === 0,
    visibleTestDoesNotNameFact: !visibleSource.includes('eu-west-2'),
    staleDefaultFailsVisible: defaultVisible.exitCode !== 0,
    staleDefaultFailsHidden: defaultHidden.exitCode !== 0,
    counterfactualFailsVisible: counterVisible.exitCode !== 0,
    counterfactualFailsHidden: counterHidden.exitCode !== 0,
    historicalMemoryNecessary: !visibleSource.includes('eu-west-2') && transcript.includes('eu-west-2'),
  },
  runs: {
    default: { visible: defaultVisible, hidden: defaultHidden },
    reference: { visible: referenceVisible, hidden: referenceHidden },
    counterfactual: { visible: counterVisible, hidden: counterHidden },
  },
  notes: [
    'The visible test forbids us-east-1 and requires an AWS-shaped region; it does not name eu-west-2.',
    'The hidden checker still requires eu-west-2, so the transcript remains necessary.',
    'H1 is unchanged; H1-v2 is a separate versioned case.',
    'This is a benchmark certification, not a model result.',
  ],
}
report.certified = Object.values(report.properties).every(Boolean)
report.status = report.certified ? 'certified' : 'failed'
await writeJson(OUT, report)

process.stdout.write(`H1-v2 validity: ${OUT}\n`)
process.stdout.write(`status ${report.status}; properties ${JSON.stringify(report.properties)}\n`)
for (const [name, entry] of Object.entries(report.runs)) {
  process.stdout.write(`${name}: visible ${entry.visible.exitCode}, hidden ${entry.hidden.exitCode}\n`)
}
process.exit(report.certified ? 0 : 1)
