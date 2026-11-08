#!/usr/bin/env node
/**
 * EF-E2E runner.
 *
 *   node eval/e2e/src/run.mjs --check
 *   node eval/e2e/src/run.mjs --self-test [--task T1-s1] [--arm E0]
 *   node eval/e2e/src/run.mjs --run --manifest eval/e2e/out/manifest.json
 *
 * `--check` verifies the frozen manifest, the authorization and the route
 * WITHOUT making a request. `--self-test` drives the same native host with a
 * scripted solver: it proves the plumbing and never claims a model result.
 * `--run` refuses unless the authorization names the exact manifest SHA-256 and
 * the envelope's global caps are positive.
 *
 * ## Ordering
 *
 * The cell order is frozen in the manifest. It interleaves arms inside each
 * replicate block, so a provider-side drift over the batch cannot masquerade as
 * an arm effect. The runner executes the list as written; it does not reorder.
 *
 * @module eval/e2e/src/run
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLiveRoute, assertRouteRoutable } from '../../live/dist/zcode-config.js'
import { OpenAiCompatibleAdapter } from '../../live/dist/openai-adapter.js'
import { RecordingAdapter, runCell, ScriptedSolverAdapter } from './cell.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const OUT = join(ROOT, 'eval', 'e2e', 'out')
const RUNS = join(ROOT, 'eval', 'e2e', 'runs')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks')
const AUTHORIZATION = join(ROOT, 'eval', 'e2e', 'authorization.json')

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function loadTask(id) {
  return JSON.parse(await readFile(join(TASKS, `${id}.json`), 'utf8'))
}

async function loadManifest(path) {
  const text = await readFile(path, 'utf8')
  return { manifest: JSON.parse(text), digest: sha256(text) }
}

async function verifyAuthorization(manifest, digest) {
  if (!existsSync(AUTHORIZATION)) return { ok: false, reason: 'authorization.json is missing' }
  const authorization = JSON.parse(await readFile(AUTHORIZATION, 'utf8'))
  if (authorization.granted !== true) return { ok: false, reason: 'authorization is not granted' }
  if (authorization.manifestSha256 !== digest) {
    return { ok: false, reason: `authorization names ${authorization.manifestSha256}, manifest is ${digest}` }
  }
  const limits = manifest.limits
  if (!(limits.httpAttempts > 0) || !(limits.inputTokens > 0) || !(limits.outputTokens > 0)) {
    return { ok: false, reason: 'manifest has no positive global limits' }
  }
  return { ok: true, authorization }
}

function makeLiveAdapter({ route, model }) {
  return ({ task, ledger, log }) => {
    const inner = new OpenAiCompatibleAdapter({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model,
      contextWindow: task.operationalBudgetTokens,
      ...(route.headers === undefined ? {} : { headers: route.headers }),
      budget: ledger,
    })
    return new RecordingAdapter(inner, log)
  }
}

function makeSelfTestAdapter({ model }) {
  return ({ task }) => {
    const adapter = new ScriptedSolverAdapter(task)
    adapter.resolveModel = (provider, id) => Promise.resolve({
      provider, id, name: id, context: { contextWindow: task.operationalBudgetTokens },
    })
    return adapter
  }
}

async function main() {
  const mode = flag('run') ? 'run' : flag('self-test') ? 'self-test' : 'check'

  if (mode === 'check') {
    const manifestPath = value('manifest', join(OUT, 'manifest.json'))
    if (!existsSync(manifestPath)) {
      process.stderr.write('e2e: no manifest; run eval/e2e/src/freeze.mjs first\n')
      process.exit(2)
    }
    const { manifest, digest } = await loadManifest(manifestPath)
    const authorization = await verifyAuthorization(manifest, digest)
    if (!authorization.ok) {
      process.stderr.write(`e2e: ${authorization.reason}\n`)
      process.exit(2)
    }
    const route = resolveLiveRoute({ model: manifest.model })
    if (route === undefined) {
      process.stderr.write('e2e: no live route resolved\n')
      process.exit(2)
    }
    assertRouteRoutable(route)
    process.stdout.write(`e2e check: manifest ${digest.slice(0, 12)}…, ${manifest.cells.length} cell(s)\n`)
    process.stdout.write(`route: ${route.origin} -> ${route.baseUrl} (model ${route.model})\n`)
    process.stdout.write('no provider request was made (pass --run to execute)\n')
    return
  }

  if (mode === 'self-test') {
    const taskId = value('task', 'T1-s1')
    const arm = value('arm', 'E0')
    const task = await loadTask(taskId)
    const outRoot = join(RUNS, `self-test-${Date.now()}`)
    await mkdir(outRoot, { recursive: true })
    const report = await runCell({
      campaign: 'self-test',
      task,
      arm,
      replicate: 1,
      mode: 'self-test',
      makeAdapter: makeSelfTestAdapter({ model: 'scripted' }),
      outRoot,
      provider: 'ef-e2e',
      model: 'scripted',
      cellLimits: { requests: 20, inputTokens: 200_000, outputTokens: 20_000, wallClockMs: 120_000 },
    })
    process.stdout.write(`self-test ${report.cellId}: compactions ${report.compactions.length}, `
      + `checker ${report.checker.pass ? 'pass' : 'fail'}, termination ${report.termination.kind}\n`)
    for (const check of report.checker.checks) {
      process.stdout.write(`  ${check.kind}: ${check.pass ? 'pass' : 'FAIL'} — ${check.detail}\n`)
    }
    process.exit(report.checker.pass && report.compactions.length > 0 ? 0 : 1)
  }

  const manifestPath = value('manifest', join(OUT, 'manifest.json'))
  const { manifest, digest } = await loadManifest(manifestPath)
  const authorization = await verifyAuthorization(manifest, digest)
  if (!authorization.ok) {
    process.stderr.write(`e2e: ${authorization.reason}; no request was made\n`)
    process.exit(2)
  }
  const route = resolveLiveRoute({ model: manifest.model })
  if (route === undefined) {
    process.stderr.write('e2e: no live route resolved; no request was made\n')
    process.exit(2)
  }
  assertRouteRoutable(route)

  const campaign = value('campaign', manifest.campaign)
  const outRoot = join(RUNS, campaign)
  await mkdir(outRoot, { recursive: true })

  const used = { requests: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 }
  const results = []
  let stopReason = null
  const started = Date.now()

  for (const cell of manifest.cells) {
    if (stopReason !== null) {
      results.push({ cell, status: 'not-executed', reason: stopReason })
      continue
    }
    const remaining = {
      requests: manifest.limits.httpAttempts - used.requests,
      inputTokens: manifest.limits.inputTokens - used.inputTokens,
      outputTokens: manifest.limits.outputTokens - used.outputTokens,
      wallClockMs: manifest.limits.wallClockMs - (Date.now() - started),
    }
    if (Object.values(remaining).some(item => item <= 0)) {
      stopReason = 'budget-exhausted-before-cell'
      results.push({ cell, status: 'not-executed', reason: stopReason })
      continue
    }
    const task = await loadTask(cell.task)
    const cellLimits = {
      requests: Math.max(1, Math.min(manifest.perCell.requests, remaining.requests)),
      inputTokens: Math.max(1, Math.min(manifest.perCell.inputTokens, remaining.inputTokens)),
      outputTokens: Math.max(1, Math.min(manifest.perCell.outputTokens, remaining.outputTokens)),
      wallClockMs: Math.max(1, Math.min(manifest.perCell.wallClockMs, remaining.wallClockMs)),
    }
    let report
    try {
      report = await runCell({
        campaign,
        task,
        arm: cell.arm,
        replicate: cell.replicate,
        mode: 'live',
        makeAdapter: makeLiveAdapter({ route, model: manifest.model }),
        outRoot,
        provider: 'ef-e2e',
        model: manifest.model,
        cellLimits,
      })
    } catch (error) {
      stopReason = `runner-error: ${error instanceof Error ? error.message : String(error)}`
      results.push({ cell, status: 'error', reason: stopReason })
      continue
    }
    used.requests += report.usage.requests
    used.inputTokens += report.usage.inputTokens
    used.outputTokens += report.usage.outputTokens
    used.wallClockMs = Date.now() - started
    results.push({
      cell,
      status: 'executed',
      cellId: report.cellId,
      exposure: report.treatmentExposure,
      compactions: report.compactions.length,
      checker: report.checker.pass,
      termination: report.termination.kind,
      usage: report.usage,
      reportPath: join(outRoot, report.cellId, 'report.json'),
    })
    const auxiliary = report.usage.auxiliary.requests
    process.stdout.write(
      `${report.cellId}  ${report.treatmentExposure}  fold ${report.compactions.length}  `
      + `check ${report.checker.pass ? 'pass' : 'fail'}  ${report.termination.kind}  `
      + `req ${report.usage.requests} (aux ${auxiliary})  in ${report.usage.inputTokens}  out ${report.usage.outputTokens}\n`,
    )
    // A provider failure or an unparseable response invalidates the rest of
    // the batch: continuing would spend budget on a broken route.
    if (report.usage.unknownUsage === report.usage.requests && report.usage.requests > 0) {
      stopReason = 'provider-usage-missing'
    }
    if (report.termination.error !== null && /provider|http|adapter/iu.test(String(report.termination.error))) {
      stopReason = 'provider-failure'
    }
  }

  const executed = results.filter(row => row.status === 'executed')
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    campaign,
    manifestSha256: digest,
    model: manifest.model,
    route: { origin: route.origin, baseUrl: route.baseUrl, headers: Object.keys(route.headers ?? {}) },
    status: stopReason === null && executed.length === manifest.cells.length
      ? 'complete'
      : executed.length === 0 ? 'failed' : 'partial',
    stopReason,
    planned: manifest.cells.length,
    executed: executed.length,
    budget: { used, limits: manifest.limits },
    results,
  }
  await writeFile(join(OUT, `results-${campaign}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  process.stdout.write(`e2e ${campaign}: ${summary.status}; executed ${executed.length}/${manifest.cells.length}; `
    + `stop ${stopReason ?? 'none'}\n`)
  process.stdout.write(`usage ${JSON.stringify(used)} / ${JSON.stringify(manifest.limits)}\n`)
  process.exit(summary.status === 'complete' ? 0 : 2)
}

await main()
