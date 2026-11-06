#!/usr/bin/env node
/**
 * R37-C2: bounded process-causal pilot.
 *
 * The pilot changes ONE thing between guard conditions: whether the finish
 * guard rejects a finish without a fresh passing test. It keeps the model,
 * route, P3s strict protocol, 8-step limit, output budget, cases, workspace,
 * and scorer fixed.
 *
 * Planned cells: 2 cases x 2 context arms x 2 guards x 3 replicates = 24.
 * Global hard caps are enforced by giving each child only the remaining budget:
 *   HTTP attempts <= 240
 *   input tokens  <= 300,000
 *   output tokens <= 70,000
 *   wall clock    <= 3,600,000 ms
 *
 * This is exploratory. It is not a confirmatory trial and it does not change
 * the Active deployment hold.
 *
 *   R37C_LIVE=1 node eval/r37c/live-process-pilot.mjs
 *
 * @module eval/r37c/live-process-pilot
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRouteRoutable, resolveLiveRoute } from '../live/dist/zcode-config.js'
import { exists, readJson, writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LIVE = join(ROOT, 'eval', 'r33', 'live.mjs')
const RUN_ROOT = process.env.R37C_RUN_ROOT === undefined ? join(HERE, 'runs-c2') : resolve(process.env.R37C_RUN_ROOT)
const MANIFEST_ROOT = process.env.R37C_MANIFEST_ROOT === undefined ? join(HERE, 'manifests-c2') : resolve(process.env.R37C_MANIFEST_ROOT)
const PROGRESS = process.env.R37C_PROGRESS === undefined ? join(HERE, 'out', 'r37c-c2-progress.json') : resolve(process.env.R37C_PROGRESS)
const RESULTS = join(HERE, 'out', 'r37c-c2-results.json')
const MODEL = process.env.R37C_MODEL ?? 'deepseek-v4.1-flash'
const REPLICATES = Number(process.env.R37C_REPLICATES ?? 3)
const CASES = (process.env.R37C_CASES ?? 'B2,D1-v2').split(',').map(value => value.trim()).filter(Boolean)
const ARMS = (process.env.R37C_ARMS ?? 'B1,S').split(',').map(value => value.trim()).filter(Boolean)
const GUARDS = (process.env.R37C_GUARDS ?? 'G0,G1').split(',').map(value => value.trim()).filter(Boolean)
const SEED = Number(process.env.R37C_SEED ?? 37)
const CELL_TIMEOUT_MS = Number(process.env.R37C_CELL_TIMEOUT_MS ?? 300_000)
const MAX_HTTP = Number(process.env.R37C_MAX_HTTP ?? 240)
const MAX_INPUT = Number(process.env.R37C_MAX_INPUT ?? 300_000)
const MAX_OUTPUT = Number(process.env.R37C_MAX_OUTPUT ?? 70_000)
const MAX_WALL_MS = Number(process.env.R37C_MAX_WALL_MS ?? 3_600_000)

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, random) {
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    const value = copy[index]
    copy[index] = copy[other]
    copy[other] = value
  }
  return copy
}

async function buildCaseRoot() {
  const root = await mkdtemp(join(tmpdir(), 'r37c-c2-cases-'))
  for (const caseId of CASES) {
    const source = caseId.endsWith('-v2')
      ? join(ROOT, 'eval', 'r37', 'cases', caseId)
      : join(ROOT, 'eval', 'r33', 'cases', caseId)
    await cp(source, join(root, caseId), { recursive: true })
  }
  return root
}

function plan() {
  const cells = []
  for (const caseId of CASES) {
    for (const arm of ARMS) {
      for (const guard of GUARDS) {
        for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
          cells.push({
            caseId,
            arm,
            guard: guard === 'G1' ? 'G1' : 'G0',
            finishGuard: guard === 'G1',
            replicateId: `r${replicate}`,
            cellId: `${caseId}-${arm}-${guard}-r${replicate}`,
          })
        }
      }
    }
  }
  return shuffle(cells, mulberry32(SEED))
}

function manifestFor(cell, remaining, runId) {
  // The live preflight requires the per-cell ledger to cover one request's
  // conservative reserve (the declared context window) and the per-request
  // output bound. These are safety caps for the cell, not an authorization to
  // spend them: the pilot's global cap is enforced on OBSERVED usage after each
  // cell, and the run stops before the next cell when a cap is reached.
  // The adapter reserves the declared context window per HTTP attempt, not the
  // observed prompt length. A full 8-step cell therefore needs ~8x131k of
  // admission headroom even though its observed input is ~14k. The per-cell
  // ledger gets that admission headroom; the pilot's 300k input cap is enforced
  // on OBSERVED usage after every cell, and the next cell is refused once the
  // observed cap is reached. This distinction is recorded in the report.
  const requests = 36
  const inputTokens = 1_100_000
  const outputTokens = 20_000
  const wallClockMs = Math.max(1, Math.min(180_000, remaining.wallClockMs))
  return {
    schemaVersion: 1,
    id: runId,
    phase: 'R37-C',
    model: MODEL,
    stage: 'continuation',
    maxOutputTokens: 16_384,
    limits: { requests, inputTokens, outputTokens, wallClockMs },
    route: {
      baseUrlEnv: 'R37C_BASE_URL',
      apiKeyEnv: 'R37C_API_KEY',
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    },
    cases: cell.caseId,
    arms: cell.arm,
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: cell.finishGuard,
    runtime: 'custom-json-loop',
    harnessVersion: 'H-protocol-s',
    toolProtocol: 'P3s',
    writerPromptVersion: 'W1',
    replicateId: cell.replicateId,
    runId,
    note: 'R37-C bounded process-causal pilot; P3s strict DSML; finish guard is the only intervention.',
  }
}

function childEnv(route, caseRoot) {
  return {
    ...process.env,
    R33_LIVE: '1',
    R37C_BASE_URL: route.baseUrl,
    R37C_API_KEY: route.apiKey,
    R33_RUN_ROOT: RUN_ROOT,
    R37_CASES_ROOT: caseRoot,
    R37_TOOL_PROTOCOL: 'P3s',
    R37_FIXTURE_ROOT: join(ROOT, 'eval', 'r37', 'fixtures'),
    R35_WRITE_LATEST: '0',
  }
}

function runLive(args, env) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [LIVE, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: CELL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - started,
    tail: text.split(/\r?\n/u).filter(Boolean).slice(-20),
  }
}

function usageOf(report) {
  const used = report?.ledger?.used ?? {}
  return {
    requests: used.requests ?? used.attempts ?? 0,
    inputTokens: used.inputTokens ?? 0,
    outputTokens: used.outputTokens ?? 0,
    wallClockMs: report?.ledger?.elapsedMs ?? report?.runElapsedMs ?? 0,
  }
}

async function runCell(cell, route, caseRoot, remaining, attempt = 0) {
  const suffix = attempt === 0 ? '' : `-retry${attempt}`
  const runId = `r37c-c2-${cell.cellId}${suffix}`
  const manifest = manifestFor(cell, remaining, runId)
  await mkdir(MANIFEST_ROOT, { recursive: true })
  const manifestPath = join(MANIFEST_ROOT, `${runId}.json`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const env = childEnv(route, caseRoot)
  const pre = runLive(['--preflight', '--manifest', manifestPath], env)
  if (pre.exitCode !== 0) {
    return { runId, cell, status: 'preflight-failed', preflight: pre, usage: { requests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: pre.durationMs } }
  }
  const run = runLive(['--run', '--manifest', manifestPath], env)
  const reportPath = join(RUN_ROOT, runId, 'report.json')
  let report = null
  try {
    report = await readJson(reportPath)
  } catch {
    report = null
  }
  const row = report?.rows?.[0] ?? null
  return {
    runId,
    cell,
    status: report === null ? 'run-failed' : 'executed',
    run,
    reportPath,
    row: row === null ? null : {
      valid: row.valid === true,
      measurementValid: row.measurementValid === true,
      outcome: row.failures?.outcome ?? null,
      contractSuccess: row.behaviour?.contractSuccess === true,
      taskSuccess: row.behaviour?.taskSuccess === true,
      testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
      steps: row.behaviourDetail?.steps ?? null,
      modelCalls: row.behaviourDetail?.modelCalls ?? null,
      finishGuard: row.behaviourDetail?.finishGuard ?? null,
      finishRequests: row.behaviourDetail?.finishGuard?.finishRequests ?? null,
      finishRejections: row.behaviourDetail?.finishGuard?.rejections ?? null,
      guardAssistedCompletion: row.behaviourDetail?.finishGuard?.assistedCompletion ?? null,
      failedChecks: row.behaviour?.failedChecks ?? [],
      writerCommitStatus: row.writer?.commitStatus ?? null,
      foldFallback: row.foldFallback ?? null,
      toolProtocol: row.behaviourDetail?.harness?.toolProtocol ?? null,
      validActions: row.behaviourDetail?.harness?.validActions ?? 0,
      rejectedActions: row.behaviourDetail?.harness?.rejectedActions ?? 0,
      invalidActionTurns: row.behaviourDetail?.harness?.invalidActions ?? 0,
    },
    usage: usageOf(report),
  }
}

function addUsage(total, usage) {
  return {
    requests: total.requests + usage.requests,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    wallClockMs: total.wallClockMs + usage.wallClockMs,
  }
}

function remainingOf(total) {
  return {
    requests: MAX_HTTP - total.requests,
    inputTokens: MAX_INPUT - total.inputTokens,
    outputTokens: MAX_OUTPUT - total.outputTokens,
    wallClockMs: MAX_WALL_MS - total.wallClockMs,
  }
}

function exhausted(remaining) {
  return remaining.requests <= 0 || remaining.inputTokens <= 0
    || remaining.outputTokens <= 0 || remaining.wallClockMs <= 0
}

const route = resolveLiveRoute({ model: MODEL })
if (route === undefined) {
  const blocked = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R37-C',
    work: 'C2',
    status: 'blocked',
    reason: 'no live route resolved; no provider request was attempted',
    model: MODEL,
    authorization: 'R37-C brief plus the prior explicit live authorization',
    budget: { maxHttp: MAX_HTTP, maxInput: MAX_INPUT, maxOutput: MAX_OUTPUT, maxWallMs: MAX_WALL_MS },
  }
  await writeJson(RESULTS, blocked)
  process.stderr.write(`C2 blocked: ${blocked.reason}\n`)
  process.exit(2)
}
assertRouteRoutable(route)

if (process.env.R37C_LIVE !== '1') {
  const blocked = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'R37-C',
    work: 'C2',
    status: 'not-executed',
    reason: 'R37C_LIVE is not 1; refusing to spend provider credits',
    model: MODEL,
    route: { origin: route.origin, baseUrl: route.baseUrl, headers: Object.keys(route.headers ?? {}) },
    plan: plan(),
    budget: { maxHttp: MAX_HTTP, maxInput: MAX_INPUT, maxOutput: MAX_OUTPUT, maxWallMs: MAX_WALL_MS },
  }
  await writeJson(RESULTS, blocked)
  process.stderr.write(`C2 not executed: ${blocked.reason}\n`)
  process.exit(2)
}

const caseRoot = await buildCaseRoot()
const cells = plan()
const startedAt = new Date().toISOString()
let total = { requests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 }
const results = []
let stopReason = null
let consecutiveProviderInvalid = 0

for (const cell of cells) {
  const remaining = remainingOf(total)
  if (exhausted(remaining)) {
    stopReason = 'global-budget-exhausted'
    break
  }
  let result = await runCell(cell, route, caseRoot, remaining)
  total = addUsage(total, result.usage)
  if (result.status === 'executed' && result.row?.outcome === 'provider-transport-error' && consecutiveProviderInvalid < 2) {
    consecutiveProviderInvalid += 1
    const retryRemaining = remainingOf(total)
    if (!exhausted(retryRemaining)) {
      const retry = await runCell(cell, route, caseRoot, retryRemaining, 1)
      total = addUsage(total, retry.usage)
      result = { ...retry, retryOf: result.runId, firstAttempt: result }
    }
  } else if (result.row?.outcome === 'provider-transport-error') {
    consecutiveProviderInvalid += 1
  } else {
    consecutiveProviderInvalid = 0
  }
  results.push(result)
  await writeJson(PROGRESS, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    status: 'running',
    planned: cells.length,
    completed: results.length,
    total,
    remaining: remainingOf(total),
    last: result,
    results,
  })
  if (consecutiveProviderInvalid >= 3) {
    stopReason = 'three-consecutive-provider-invalid-cells'
    break
  }
}

await rm(caseRoot, { recursive: true, force: true })
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-C',
  work: 'C2',
  status: stopReason === null && results.length === cells.length ? 'complete' : 'partial',
  stopReason,
  model: MODEL,
  route: { origin: route.origin, baseUrl: route.baseUrl, headers: Object.keys(route.headers ?? {}) },
  protocol: 'P3s',
  harness: 'H-protocol-s',
  plan: { cases: CASES, arms: ARMS, guards: GUARDS, replicates: REPLICATES, cells: cells.length, seed: SEED },
  budget: {
    maxHttp: MAX_HTTP,
    maxInput: MAX_INPUT,
    maxOutput: MAX_OUTPUT,
    maxWallMs: MAX_WALL_MS,
    used: total,
    remaining: remainingOf(total),
    admissionNote: 'Each cell receives the adapter-required context-window reserve; the global '
      + '300k input / 70k output caps are enforced on OBSERVED usage after every cell, and the '
      + 'next cell is refused once a cap is reached.',
  },
  authorization: 'R37-C brief plus the prior explicit live authorization',
  results,
  notes: [
    'This is an exploratory pilot, not a confirmatory trial.',
    'The finish guard rejects a finish request; it never runs a test, edits code, or writes verification.',
    'Fold refusals and fallbacks remain in the assigned-arm denominator.',
    'Provider-invalid rows are counted in cost and are not task failures.',
  ],
}
await writeJson(RESULTS, report)
process.stdout.write(`R37-C C2 pilot: ${RESULTS}\n`)
process.stdout.write(`status ${report.status}; cells ${results.length}/${cells.length}; stop ${stopReason ?? 'none'}\n`)
process.stdout.write(`usage ${JSON.stringify(total)}\n`)
process.exit(report.status === 'complete' ? 0 : 2)
