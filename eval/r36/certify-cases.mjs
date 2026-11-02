#!/usr/bin/env node
/**
 * R36-B: certify that each behavioural case is actually solvable.
 *
 * A case is usable for a memory-policy comparison only when a reference
 * implementation can satisfy all three of:
 *
 *   visible tests          what the agent can see and run
 *   hidden checker         what the evaluation measures
 *   historical contract    the fact that made the case interesting
 *
 * C1 is the known conflict: its visible test demands an fs.watch callback,
 * while its historical constraint says fs.watch loses events and the hidden
 * checker only exercises polling. The reference in `reference/C1` keeps polling
 * as the delivery guarantee and treats watch as a hint, so both verdicts pass.
 *
 * No provider is called. The script reads the frozen v2 dataset, writes only
 * into a temp workspace, and records the verdicts under `eval/r36/out/`.
 *
 *   node eval/r36/certify-cases.mjs
 *
 * @module eval/r36/certify-cases
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadDataset, readTree } from '../r33/src/dataset.mjs'
import { behaviourMetrics } from '../r33/src/grade.mjs'
import {
  materialize,
  runChecker,
  runVisibleTests,
  workspaceDigest,
} from '../r33/src/workspace.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const REFERENCE = join(HERE, 'reference')
const CASES = ['A1', 'B2', 'C1', 'D1', 'D2', 'F1', 'H1']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function importFresh(path) {
  return import(`${pathToFileURL(path).href}?r36=${Date.now()}-${Math.random()}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Per-case historical-contract probes; each reads the materialized workspace. */
const PROBES = {
  async A1(root, caseData) {
    const config = await importFresh(join(root, 'src', 'config.mjs'))
    const callers = await importFresh(join(root, 'src', 'callers.mjs'))
    const objectForm = config.loadConfig({ path: 'config.json' })
    const stringForm = config.loadConfig('config.json')
    assert(objectForm.source === 'config.json' && objectForm.retries === 2, 'object form lost retries')
    assert(stringForm.source === 'config.json' && stringForm.retries === 2, 'legacy string form broke')
    assert(callers.runCallers().source === 'config.json', 'legacy caller broke')
    return {
      passed: true,
      detail: 'string form, object form, and the legacy caller all work',
      historicalFact: caseData.gold[0].statement,
    }
  },

  async B2(root, caseData) {
    const scheduler = await importFresh(join(root, 'src', 'scheduler.mjs'))
    const appended = []
    const instance = scheduler.createScheduler({ storage: { append: async task => appended.push(task) } })
    await instance.enqueue({ id: 7 })
    assert(appended.length === 0, 'the scheduler used the storage dependency it was told to avoid')
    assert(instance.mode === 'memory', 'the scheduler is no longer in-memory')
    return {
      passed: true,
      detail: 'in-memory queue is used even when a storage dependency is offered',
      historicalFact: caseData.gold[0].statement,
    }
  },

  async C1(root, caseData) {
    const watcher = await importFresh(join(root, 'src', 'watcher.mjs'))
    // Visible-test shape: the watch callback fires, readdir never changes.
    const listeners = []
    const visibleFs = {
      watch(_dir, listener) { listeners.push(listener); return { close() {} } },
      readdir() { return [] },
    }
    const visibleEvents = []
    const visibleHandle = watcher.watchChanges({
      fs: visibleFs,
      dir: '/r36',
      onEvent: event => visibleEvents.push(event),
    })
    listeners[0]?.('change')
    visibleHandle.close()
    assert(visibleEvents.length === 1, 'the visible watch-callback path did not deliver exactly one event')
    // Historical shape: watch is dead, readdir changes. Polling must deliver.
    const started = Date.now()
    const pollingFs = {
      watch() { return { close() {} } },
      readdir() { return Date.now() - started > 10 ? ['a.txt'] : [] },
    }
    const pollingEvents = []
    const pollingHandle = watcher.watchChanges({
      fs: pollingFs,
      dir: '/r36',
      onEvent: event => pollingEvents.push(event),
    })
    await sleep(120)
    pollingHandle.close()
    assert(pollingEvents.length > 0, 'polling did not deliver when the watch callback was never invoked')
    return {
      passed: true,
      detail: 'visible watch-callback path and polling-only path both deliver',
      historicalFact: caseData.gold[0].statement,
      pollingIndependent: true,
      watchRole: 'optional-low-latency-hint',
    }
  },

  async D1(root, caseData) {
    const verification = JSON.parse(await readFile(join(root, 'verification.json'), 'utf8'))
    assert(verification.claim === 'verified', 'the reference did not claim verified after running tests')
    assert(verification.testsRun === 1 && verification.testsPassed === 1, 'the reference has no passing test record')
    const source = caseData.transcript[caseData.gold[0].sourceRefs[0]]
    assert(source.text.includes('tests=not-run'), 'the historical t0 fact was rewritten')
    return {
      passed: true,
      detail: 't0 remains not-verified; the final state is verified from a fresh technical run',
      historicalFact: caseData.gold[0].statement,
      historicalStatusAtT0: 'not-verified',
      finalStatusAfterTest: 'verified',
    }
  },

  async D2(root, caseData) {
    const verification = JSON.parse(await readFile(join(root, 'verification.json'), 'utf8'))
    assert(verification.claim === 'verified', 'the reference did not carry verified')
    assert(verification.evidenceRef === 'run-7', 'the evidence reference was lost')
    return {
      passed: true,
      detail: 'verified is carried with its run-7 evidence reference',
      historicalFact: caseData.gold[0].statement,
    }
  },

  async F1(root, caseData) {
    const api = await importFresh(join(root, 'src', 'api.mjs'))
    assert(api.publicApi().version === 1, 'public API version changed')
    assert(api.publicApi().v2 === 2, 'v2 was not added')
    assert(api.legacyAdapter().legacy === true, 'legacyAdapter was modified')
    return {
      passed: true,
      detail: 'v2 added; version 1 and legacyAdapter preserved',
      historicalFact: caseData.gold[0].statement,
    }
  },

  async H1(root, caseData) {
    const client = await importFresh(join(root, 'src', 'client.mjs'))
    assert(client.defaultRegion() === 'eu-west-2', 'the production region is not eu-west-2')
    return {
      passed: true,
      detail: 'the recoverable production region is the configured default',
      historicalFact: caseData.gold[0].statement,
    }
  },
}

async function referenceFilesFor(caseData) {
  const root = join(REFERENCE, caseData.id)
  if (existsSync(root)) return await readTree(root)
  const actionName = caseData.id === 'D2' ? 'carry-verification' : undefined
  if (actionName !== undefined && caseData.actions[actionName] !== undefined) {
    return caseData.actions[actionName].files ?? {}
  }
  return {}
}

async function certify(caseData) {
  const root = await mkdtemp(join(tmpdir(), `r36-cert-${caseData.id}-`))
  try {
    const reference = await referenceFilesFor(caseData)
    await materialize({ ...caseData.workspace.files, ...reference }, root)
    const visible = await runVisibleTests(root)
    const checker = await runChecker(caseData, root)
    let probe
    try {
      probe = await PROBES[caseData.id](root, caseData)
    } catch (error) {
      probe = { passed: false, detail: error instanceof Error ? error.message : String(error) }
    }

    let scorerProbe = null
    if (caseData.id === 'D1' && visible.passed && checker.status === 'executed') {
      const verification = JSON.parse(await readFile(join(root, 'verification.json'), 'utf8'))
      const digest = await workspaceDigest(root)
      const observed = {
        currentDigest: digest.digest,
        files: digest.files,
        lastModification: null,
        lastPassingTest: { step: 1, digest: digest.digest, exitCode: 0 },
        verifiedCurrentCode: true,
        sourceDigestAtLastTest: digest.digest,
        sourceDigestAtFinish: digest.digest,
        testRuns: [{ step: 1, digest: digest.digest, exitCode: 0, passed: true }],
      }
      const behaviour = behaviourMetrics({
        ...caseData,
        actions: { 'live-agent': { violates: [] } },
      }, {
        checker,
        decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
        verification,
        testsExecuted: 1,
        verificationFreshness: observed,
      })
      scorerProbe = {
        historicalExpectedStatus: behaviour.historicalExpectedStatus,
        finalVerificationStatus: behaviour.finalVerificationStatus,
        falseVerificationClaim: behaviour.falseVerificationClaim,
        contractSuccess: behaviour.contractSuccess,
      }
    }

    const checkerFailed = (checker.checks ?? []).filter(check => !check.pass).map(check => check.name)
    return {
      caseId: caseData.id,
      riskClass: caseData.riskClass,
      reference: Object.keys(reference).sort(),
      visible: {
        passed: visible.passed,
        exitCode: visible.exitCode,
        timedOut: visible.timedOut,
      },
      hidden: {
        status: checker.status,
        passed: checker.status === 'executed' && checkerFailed.length === 0,
        checks: checker.checks ?? [],
        failed: checkerFailed,
        detail: checker.detail ?? null,
      },
      historical: probe,
      scorerProbe,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const { cases, errors, datasetDigest } = await loadDataset()
if (errors.length > 0) {
  process.stderr.write(`dataset errors: ${JSON.stringify(errors)}\n`)
  process.exit(2)
}
const byId = new Map(cases.map(entry => [entry.id, entry]))
const rows = []
for (const id of CASES) {
  const caseData = byId.get(id)
  if (caseData === undefined) {
    rows.push({ caseId: id, error: 'case not present in the frozen dataset' })
    continue
  }
  process.stdout.write(`certifying ${id}...\n`)
  rows.push(await certify(caseData))
}
const allPassed = rows.every(row => row.visible?.passed && row.hidden?.passed && row.historical?.passed)
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dataset: { id: 'r33-semantic-continuity-v2', digest: datasetDigest },
  cases: rows,
  allPassed,
  note: 'No provider request was made. Each workspace is a temp copy; the frozen dataset was not modified.',
}
await writeFile(join(OUT, 'case-certification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
for (const row of rows) {
  if (row.error !== undefined) {
    process.stdout.write(`${row.caseId}: ERROR ${row.error}\n`)
    continue
  }
  process.stdout.write(
    `${row.caseId}: visible=${row.visible.passed ? 'pass' : 'FAIL'} `
    + `hidden=${row.hidden.passed ? 'pass' : 'FAIL'} `
    + `historical=${row.historical.passed ? 'pass' : 'FAIL'}\n`,
  )
}
process.stdout.write(`\n${allPassed ? 'all certified cases are solvable' : 'CERTIFICATION FAILED'}\n`)
process.exit(allPassed ? 0 : 1)
