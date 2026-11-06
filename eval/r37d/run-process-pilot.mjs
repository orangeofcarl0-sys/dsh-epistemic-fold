#!/usr/bin/env node
/**
 * R37-D WP4 execution: the frozen 24-cell process-prompt pilot.
 *
 * The batch is fixed in `process-pilot-manifest.json` and authorized by
 * `authorization.json` (which must name the manifest SHA-256). This runner:
 *
 *   - verifies the authorization and every frozen digest before any request
 *   - materializes the case workspace per cell
 *   - reuses the frozen context text; it does NOT regenerate a writer
 *   - calls the shared `followUp` loop with the real provider adapter
 *   - enforces the per-cell admission ledger and the global observed caps
 *   - scores the legacy behaviour and the layered operational completion
 *   - stops on provider failure, scorer failure, or a reached cap
 *
 *   node eval/r37d/run-process-pilot.mjs --check   verify only
 *   node eval/r37d/run-process-pilot.mjs --run     execute the authorized batch
 *
 * @module eval/r37d/run-process-pilot
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCase } from '../r33/src/dataset.mjs'
import { materialize, readVerification, runChecker } from '../r33/src/workspace.mjs'
import { behaviourMetrics } from '../r33/src/grade.mjs'
import { BudgetLedger } from '../r33/src/budget.mjs'
import { classifyOperationalCompletion } from './src/operational-completion.mjs'
import { writeJson } from '../r37/src/io.mjs'
import { resolveLiveRoute, assertRouteRoutable } from '../live/dist/zcode-config.js'
import { OpenAiCompatibleAdapter } from '../live/dist/openai-adapter.js'

process.env.R37_TOOL_PROTOCOL = 'P3s'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const MANIFEST_PATH = join(HERE, 'out', 'process-pilot-manifest.json')
const AUTH_PATH = join(HERE, 'authorization.json')
const RUN_ROOT = join(HERE, 'runs-process')
const CHECK_ONLY = !process.argv.includes('--run')

const PER_CELL = {
  requests: 36,
  inputTokens: 1_100_000,
  outputTokens: 20_000,
  wallClockMs: 180_000,
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hashFiles(files) {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const [path, content] of entries) {
    hash.update(path, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(content, 'utf8')
    hash.update('\0', 'utf8')
  }
  return hash.digest('hex')
}

function fail(message) {
  process.stderr.write(`R37-D process pilot: ${message}\n`)
  process.exit(2)
}

const manifestText = await readFile(MANIFEST_PATH, 'utf8')
const manifest = JSON.parse(manifestText)
const manifestSha256 = sha256(manifestText)

if (!existsSync(AUTH_PATH)) fail('authorization.json is missing; no request was made')
const authorization = JSON.parse(await readFile(AUTH_PATH, 'utf8'))
if (authorization.granted !== true) fail('authorization is not granted; no request was made')
if (authorization.manifestSha256 !== manifestSha256) {
  fail('authorization does not name this manifest SHA-256; no request was made')
}
if (authorization.cells !== 24 || manifest.cells?.length !== 24) {
  fail('authorization and manifest disagree on the cell count; no request was made')
}

const caseDataById = {}
const preflight = []
for (const caseId of manifest.design.cases) {
  const root = [join(REPO, 'eval', 'r37', 'cases', caseId), join(REPO, 'eval', 'r33', 'cases', caseId)]
    .find(candidate => existsSync(join(candidate, 'case.json')))
  if (root === undefined) fail(`case root not found for ${caseId}`)
  const caseData = await loadCase(caseId, dirname(root))
  caseDataById[caseId] = caseData
  const workspaceDigest = hashFiles(caseData.workspace.files)
  const expected = manifest.workspace?.[caseId]?.digest
  preflight.push({ id: `workspace-${caseId}`, pass: workspaceDigest === expected, detail: workspaceDigest })
  if (workspaceDigest !== expected) fail(`workspace digest mismatch for ${caseId}; no request was made`)
}

const fixtureCache = new Map()
for (const cell of manifest.cells) {
  if (sha256(cell.task) !== cell.taskDigest) fail(`task digest mismatch for ${cell.cellId}`)
  if (!fixtureCache.has(cell.fixture)) {
    const text = await readFile(join(REPO, cell.fixture), 'utf8')
    if (sha256(text) !== cell.fixtureDigest) fail(`fixture digest mismatch for ${cell.fixture}`)
    fixtureCache.set(cell.fixture, text)
  }
  if (cell.guard !== false || cell.steps !== 8 || cell.outputTokens !== 1024) {
    fail(`cell ${cell.cellId} is outside the frozen design`)
  }
}
preflight.push({ id: 'cells', pass: true, detail: `${manifest.cells.length} cells` })

const route = resolveLiveRoute({ model: manifest.design.model })
if (route === undefined) fail('no live route resolved; no request was made')
assertRouteRoutable(route)
preflight.push({ id: 'route', pass: true, detail: `${route.origin} -> ${route.baseUrl}` })

if (CHECK_ONLY) {
  process.stdout.write('R37-D process pilot preflight: ok\n')
  for (const check of preflight) process.stdout.write(`  ${check.id}: ${check.detail}\n`)
  process.stdout.write(`authorization ${authorization.statement}; manifest ${manifestSha256.slice(0, 12)}…\n`)
  process.stdout.write('no provider request was made (pass --run to execute)\n')
  process.exit(0)
}

const { followUp, baseAdapter } = await import('../r33/live.mjs')
const limits = manifest.limits
const used = { requests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 }
const results = []
let stopReason = null

function remaining() {
  return {
    requests: Math.max(0, limits.httpAttempts - used.requests),
    inputTokens: Math.max(0, limits.inputTokens - used.inputTokens),
    outputTokens: Math.max(0, limits.outputTokens - used.outputTokens),
    wallClockMs: Math.max(0, limits.wallClockMs - used.wallClockMs),
  }
}

await mkdir(RUN_ROOT, { recursive: true })

for (const cell of manifest.cells) {
  if (stopReason !== null) {
    results.push({ cell, status: 'not-executed', reason: stopReason })
    continue
  }
  const left = remaining()
  if (left.requests === 0 || left.inputTokens === 0 || left.outputTokens === 0 || left.wallClockMs === 0) {
    stopReason = 'budget-exhausted-before-cell'
    results.push({ cell, status: 'not-executed', reason: stopReason })
    continue
  }

  const caseData = { ...caseDataById[cell.caseId], task: cell.task }
  const checkpoint = fixtureCache.get(cell.fixture)
  const cellRoot = join(RUN_ROOT, cell.cellId)
  const workspace = join(cellRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  await materialize(caseData.workspace.files, workspace)

  const ledger = new BudgetLedger({
    requests: PER_CELL.requests,
    inputTokens: PER_CELL.inputTokens,
    outputTokens: PER_CELL.outputTokens,
    wallClockMs: Math.max(1, Math.min(PER_CELL.wallClockMs, left.wallClockMs)),
  })
  const inner = new OpenAiCompatibleAdapter({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: cell.model,
    contextWindow: 131_072,
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    budget: ledger,
  })
  const log = { entries: [], record(entry) { this.entries.push(entry) } }
  const adapter = baseAdapter({ live: true, inner, ledger, log, caseData, plan: null, writerPayload: null })

  let follow = null
  let checker = null
  let verification = undefined
  let behaviour = null
  let operational = null
  let error = null
  try {
    follow = await followUp({
      adapter,
      model: cell.model,
      caseData,
      arm: cell.arm,
      checkpoint,
      fixtureContext: undefined,
      workspaceRoot: workspace,
      maxSteps: cell.steps,
      maxTokens: cell.outputTokens,
      finishGuard: cell.guard,
      runtime: cell.runtime,
    })
    checker = await runChecker(caseData, workspace)
    verification = await readVerification(workspace)
    behaviour = behaviourMetrics(caseData, {
      checker,
      decision: { action: 'live-agent', matchedProbe: null, basis: 'model' },
      verification,
      testsExecuted: follow.testsExecuted,
      verificationFreshness: follow.verificationFreshness,
      finishGuard: follow.finishGuard,
      harness: follow.harness,
    })
    operational = classifyOperationalCompletion({
      caseData,
      behaviour,
      detail: follow,
      checker,
      run: { exitCode: 0, signal: null, timedOut: false },
      verification,
    })
  } catch (thrown) {
    error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  }

  const snapshot = ledger.snapshot()
  const usage = {
    requests: snapshot.used.requests,
    inputTokens: snapshot.used.inputTokens,
    outputTokens: snapshot.used.outputTokens,
    wallClockMs: snapshot.elapsedMs,
    retries: snapshot.used.retries,
    unknownUsage: snapshot.used.unknownUsage,
  }
  used.requests += usage.requests
  used.inputTokens += usage.inputTokens
  used.outputTokens += usage.outputTokens
  used.wallClockMs += usage.wallClockMs

  const providerFailure = follow?.harness?.providerFailure ?? null
  const measurement = error !== null
    ? 'runner-error'
    : providerFailure !== null
      ? 'provider-invalid'
      : checker?.status !== 'executed'
        ? 'scorer-invalid'
        : 'valid'
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cell,
    measurement,
    error,
    providerFailure,
    behaviour,
    operational,
    detail: follow === null ? null : {
      steps: follow.steps,
      modelCalls: follow.modelCalls,
      toolCalls: follow.toolCalls,
      testsExecuted: follow.testsExecuted,
      testRuns: follow.testRuns,
      finished: follow.finished,
      finishGuard: follow.finishGuard,
      harness: follow.harness,
      verificationFreshness: follow.verificationFreshness,
    },
    checker: checker === null ? null : {
      status: checker.status,
      exitCode: checker.exitCode ?? null,
      timedOut: checker.timedOut === true,
      checks: checker.checks,
      agentError: checker.agentError ?? null,
    },
    verification: verification ?? null,
    usage,
    trace: follow?.trace ?? [],
    log: log.entries,
  }
  await writeJson(join(cellRoot, 'report.json'), report)

  results.push({
    cell,
    status: 'executed',
    measurement,
    usage,
    reportPath: join(cellRoot, 'report.json'),
    summary: behaviour === null || operational === null ? null : {
      legacyTaskSuccess: behaviour.taskSuccess === true,
      legacyContractSuccess: behaviour.contractSuccess === true,
      operationalCompletion: operational.operationalCompletion === true,
      operationalStrictFinish: operational.operationalCompletionStrictFinish === true,
      firstFailingLayer: operational.firstFailingLayer,
      testsExecuted: follow.testsExecuted,
      finishRequests: follow.finishGuard.finishRequests,
      stepLimitTermination: follow.harness.stepLimitTermination === true,
      noValidActionCalls: follow.harness.invalidActions,
    },
  })

  if (error !== null) stopReason = 'runner-error'
  else if (providerFailure !== null) stopReason = 'provider-failure'
  else if (checker?.status !== 'executed') stopReason = 'scorer-invalid'
  else {
    const after = remaining()
    if (after.requests === 0) stopReason = 'budget-http'
    else if (after.inputTokens === 0) stopReason = 'budget-input'
    else if (after.outputTokens === 0) stopReason = 'budget-output'
    else if (after.wallClockMs === 0) stopReason = 'budget-wall'
  }
}

const executed = results.filter(entry => entry.status === 'executed')
const rows = executed.filter(entry => entry.summary !== null).map(entry => entry.summary)
const byCondition = {}
for (const entry of executed) {
  const key = `${entry.cell.caseId}/${entry.cell.arm}/${entry.cell.condition}`
  const bucket = byCondition[key] ?? {
    cells: 0,
    legacyContract: 0,
    operational: 0,
    strictFinish: 0,
    testsExecuted: 0,
    finishRequests: 0,
    stepLimit: 0,
    noValidActionCalls: 0,
  }
  bucket.cells += 1
  if (entry.summary?.legacyContractSuccess) bucket.legacyContract += 1
  if (entry.summary?.operationalCompletion) bucket.operational += 1
  if (entry.summary?.operationalStrictFinish) bucket.strictFinish += 1
  bucket.testsExecuted += entry.summary?.testsExecuted ?? 0
  bucket.finishRequests += entry.summary?.finishRequests ?? 0
  if (entry.summary?.stepLimitTermination) bucket.stepLimit += 1
  bucket.noValidActionCalls += entry.summary?.noValidActionCalls ?? 0
  byCondition[key] = bucket
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP4-process-pilot-execution',
  status: stopReason === null && executed.length === 24
    ? 'complete'
    : executed.length === 0 ? 'failed' : 'partial',
  stopReason,
  model: manifest.design.model,
  toolProtocol: manifest.design.toolProtocol,
  runtime: manifest.design.runtime,
  scorerVersion: manifest.design.scorerVersion,
  authorization: {
    granted: true,
    statement: authorization.statement,
    grantedAt: authorization.grantedAt,
    manifestSha256,
  },
  route: {
    origin: route.origin,
    baseUrl: route.baseUrl,
    headers: Object.keys(route.headers ?? {}),
  },
  limits,
  budget: {
    used,
    remaining: remaining(),
    perCellAdmission: PER_CELL,
    note: 'Per-cell admission uses the 131,072-token context reserve; global caps are enforced on observed usage after each cell.',
  },
  summary: {
    cells: manifest.cells.length,
    executed: executed.length,
    notExecuted: results.length - executed.length,
    measurements: executed.reduce((counts, entry) => {
      counts[entry.measurement] = (counts[entry.measurement] ?? 0) + 1
      return counts
    }, {}),
    legacyContractSuccesses: rows.filter(row => row.legacyContractSuccess).length,
    operationalCompletions: rows.filter(row => row.operationalCompletion).length,
    strictFinish: rows.filter(row => row.operationalStrictFinish).length,
    testsExecuted: rows.reduce((sum, row) => sum + (row.testsExecuted ?? 0), 0),
    finishRequests: rows.reduce((sum, row) => sum + (row.finishRequests ?? 0), 0),
    stepLimitCells: rows.filter(row => row.stepLimitTermination).length,
    noValidActionCalls: rows.reduce((sum, row) => sum + (row.noValidActionCalls ?? 0), 0),
    byCondition,
  },
  results,
  notes: [
    'The fixed context is the frozen WP3 checkpoint; no writer was regenerated.',
    'The guard is off in every cell.',
    'The run stops before the next cell when a global cap is reached.',
    'A provider-invalid or scorer-invalid cell stops the batch.',
  ],
}
await writeJson(join(HERE, 'out', 'process-pilot-results.json'), report)

process.stdout.write(`R37-D process pilot: ${report.status}\n`)
process.stdout.write(`executed ${executed.length}/${manifest.cells.length}; stop ${stopReason ?? 'none'}\n`)
process.stdout.write(`legacy contract ${report.summary.legacyContractSuccesses}; `
  + `operational ${report.summary.operationalCompletions}; strict finish ${report.summary.strictFinish}\n`)
process.stdout.write(`usage ${JSON.stringify(used)} / ${JSON.stringify(limits)}\n`)
process.exit(report.status === 'complete' ? 0 : 2)
