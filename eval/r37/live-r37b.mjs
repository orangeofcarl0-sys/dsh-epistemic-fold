#!/usr/bin/env node
/**
 * R37-B live orchestrator.
 *
 * It builds a temporary case root containing A1-v2, D1-v2 and the four
 * unchanged behavioural cases, freezes one manifest per case/arm/replicate,
 * preflights it, and runs the real R33 continuation loop with:
 *
 *   - P3e tool protocol (JSON + both DSML forms + unescaping + validation)
 *   - A1-v2 / D1-v2
 *   - controlled fixture arms for B2/C1 representation
 *   - B1/S end-to-end pairs
 *
 * The key is read from the ZCode config and passed only in the child
 * environment. It is never written to a manifest, log, or report.
 *
 *   node eval/r37/live-r37b.mjs --phase writer
 *   node eval/r37/live-r37b.mjs --phase o2
 *   node eval/r37/live-r37b.mjs --phase representation
 *   node eval/r37/live-r37b.mjs --phase end-to-end
 *   node eval/r37/live-r37b.mjs --phase all
 *
 * @module eval/r37/live-r37b
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRouteRoutable, resolveLiveRoute } from '../live/dist/zcode-config.js'
import { exists, readJson, writeJson } from './src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LIVE = join(ROOT, 'eval', 'r33', 'live.mjs')
const RUN_ROOT = join(HERE, 'runs-b')
const MANIFEST_ROOT = join(HERE, 'manifests-b')
const PROGRESS = join(HERE, 'out', 'r37b-progress.json')
const MODEL = process.env.R37B_MODEL ?? 'deepseek-v4.1-flash'
const PROVIDER_ID = process.env.R37B_PROVIDER_ID ?? 'c15ab109-97b8-4de1-a647-9857a635be38'
const PHASE = process.env.R37B_PHASE ?? 'all'
const REPLICATES = Number(process.env.R37B_REPLICATES ?? 4)
const SEED = Number(process.env.R37B_SEED ?? 37)
const SUFFIX = process.env.R37B_SUFFIX ?? ''
const TIMEOUT_MS = Number(process.env.R37B_TIMEOUT_MS ?? 1_800_000)
const ONLY_CASES = process.env.R37B_CASES === undefined ? null : new Set(process.env.R37B_CASES.split(',').map(value => value.trim()))
const ONLY_ARMS = process.env.R37B_ARMS === undefined ? null : new Set(process.env.R37B_ARMS.split(',').map(value => value.trim()))

const CASES = ['A1-v2', 'D1-v2', 'B2', 'C1', 'F1', 'H1']
const STANDARD_CASES = ['B2', 'C1', 'F1', 'H1']

const LIMITS = {
  requests: 40,
  inputTokens: 8_000_000,
  outputTokens: 500_000,
  wallClockMs: 1_800_000,
}
const WRITER_LIMITS = {
  requests: 12,
  inputTokens: 4_000_000,
  outputTokens: 250_000,
  wallClockMs: 900_000,
}

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

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

async function buildCaseRoot() {
  const root = await mkdtemp(join(tmpdir(), 'r37b-cases-'))
  await cp(join(ROOT, 'eval', 'r37', 'cases', 'A1-v2'), join(root, 'A1-v2'), { recursive: true })
  await cp(join(ROOT, 'eval', 'r37', 'cases', 'D1-v2'), join(root, 'D1-v2'), { recursive: true })
  for (const id of STANDARD_CASES) {
    await cp(join(ROOT, 'eval', 'r33', 'cases', id), join(root, id), { recursive: true })
  }
  return root
}

function manifestFor({ phase, caseId, arm, replicateId, runId, stage, limits, fixture, writerPromptVersion = 'W1' }) {
  return {
    schemaVersion: 1,
    id: runId,
    phase: 'R37-B',
    model: MODEL,
    stage,
    maxOutputTokens: 16_384,
    limits,
    route: {
      baseUrlEnv: 'R37B_BASE_URL',
      apiKeyEnv: 'R37B_API_KEY',
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
    },
    cases: caseId,
    arms: arm,
    followUpSteps: 8,
    followUpMaxTokens: 1024,
    finishGuard: false,
    runtime: 'custom-json-loop',
    harnessVersion: 'H-protocol-e',
    toolProtocol: 'P3e',
    writerPromptVersion,
    replicateId,
    runId,
    ...(fixture === undefined ? {} : { fixture }),
    note: `R37-B ${phase}; P3e tool protocol; A1-v2/D1-v2 case root.`,
  }
}

function childEnv(route, caseRoot) {
  return {
    ...process.env,
    R33_LIVE: '1',
    R37B_BASE_URL: route.baseUrl,
    R37B_API_KEY: route.apiKey,
    R33_RUN_ROOT: RUN_ROOT,
    R37_CASES_ROOT: caseRoot,
    R37_TOOL_PROTOCOL: 'P3e',
    R37_FIXTURE_ROOT: join(HERE, 'fixtures'),
    R35_WRITE_LATEST: '0',
  }
}

function runLive(args, env, logPath) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [LIVE, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Date.now() - started,
    tail: text.split(/\r?\n/u).filter(Boolean).slice(-20),
    text,
    logPath,
  }
}

async function preflight(manifestPath, env, logPath) {
  return runLive(['--preflight', '--manifest', manifestPath], env, logPath)
}

async function runBlock({ phase, caseId, arm, replicateId, runId, stage, limits, fixture, writerPromptVersion, route, caseRoot }) {
  await mkdir(MANIFEST_ROOT, { recursive: true })
  const manifest = manifestFor({ phase, caseId, arm, replicateId, runId, stage, limits, fixture, writerPromptVersion })
  const manifestPath = join(MANIFEST_ROOT, `${runId}.json`)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const env = childEnv(route, caseRoot)
  const preflightLog = join(RUN_ROOT, `${runId}.preflight.log`)
  const runLog = join(RUN_ROOT, `${runId}.run.log`)
  await mkdir(RUN_ROOT, { recursive: true })
  const pre = await preflight(manifestPath, env, preflightLog)
  await writeFile(preflightLog, pre.text, 'utf8')
  if (pre.exitCode !== 0) {
    return { runId, phase, caseId, arm, replicateId, status: 'preflight-failed', preflight: { exitCode: pre.exitCode, tail: pre.tail } }
  }
  const run = await runLive(['--run', '--manifest', manifestPath], env, runLog)
  await writeFile(runLog, run.text, 'utf8')
  const reportPath = join(RUN_ROOT, runId, 'report.json')
  let report = null
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch {
    report = null
  }
  const rows = report?.rows ?? []
  const valid = rows.filter(row => row.valid === true).length
  const contract = rows.filter(row => row.behaviour?.contractSuccess === true).length
  return {
    runId,
    phase,
    caseId,
    arm,
    replicateId,
    status: rows.length > 0 ? 'executed' : 'run-failed',
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    reportPath,
    rows: rows.length,
    valid,
    contractSuccesses: contract,
    tail: run.tail,
  }
}

function phaseBlocks(phase) {
  const blocks = []
  if (phase === 'writer' || phase === 'all') {
    for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
      for (const caseId of CASES) {
        for (const prompt of ['W0', 'W1']) {
          blocks.push({
            phase: 'writer',
            caseId,
            arm: 'S',
            replicateId: `r${replicate}`,
            runId: `r37b-writer-${prompt}-${caseId}-r${replicate}${SUFFIX}`,
            stage: 'writer-only',
            limits: WRITER_LIMITS,
            writerPromptVersion: prompt,
          })
        }
      }
    }
  }
  if (phase === 'o2' || phase === 'all') {
    for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
      for (const caseId of CASES) {
        blocks.push({
          phase: 'o2',
          caseId,
          arm: 'O2',
          replicateId: `r${replicate}`,
          runId: `r37b-o2-${caseId}-r${replicate}${SUFFIX}`,
          stage: 'continuation',
          limits: LIMITS,
        })
      }
    }
  }
  if (phase === 'representation' || phase === 'all') {
    for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
      for (const [caseId, arms] of [['B2', ['FP', 'FS', 'FN']], ['C1', ['FH', 'FP', 'FS']]]) {
        for (const arm of arms) {
          blocks.push({
            phase: 'representation',
            caseId,
            arm,
            replicateId: `r${replicate}`,
            runId: `r37b-rep-${caseId}-${arm}-r${replicate}${SUFFIX}`,
            stage: 'continuation',
            limits: LIMITS,
            fixture: `${caseId}-${arm === 'FP' ? 'F-P' : arm === 'FS' ? 'F-S' : arm === 'FN' ? 'F-N' : 'F-H'}`,
          })
        }
      }
    }
  }
  if (phase === 'end-to-end' || phase === 'all') {
    for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
      for (const caseId of CASES) {
        for (const arm of ['B1', 'S']) {
          blocks.push({
            phase: 'end-to-end',
            caseId,
            arm,
            replicateId: `r${replicate}`,
            runId: `r37b-e2e-${caseId}-${arm}-r${replicate}${SUFFIX}`,
            stage: 'continuation',
            limits: LIMITS,
          })
        }
      }
    }
  }
  return blocks
}

async function main() {
  if (!positiveInteger(REPLICATES)) {
    process.stderr.write('R37B_REPLICATES must be a positive integer\n')
    process.exit(2)
  }
  if (!['writer', 'o2', 'representation', 'end-to-end', 'all'].includes(PHASE)) {
    process.stderr.write(`unknown R37B_PHASE ${PHASE}\n`)
    process.exit(2)
  }
  process.env.EF_LIVE_PROVIDER_ID = PROVIDER_ID
  process.env.EF_LIVE_MODEL = MODEL
  delete process.env.EF_LIVE_ZEN_FREE
  if (process.env.EF_LIVE_BASE_URL !== undefined) delete process.env.EF_LIVE_BASE_URL
  if (process.env.EF_LIVE_HEADERS !== undefined) delete process.env.EF_LIVE_HEADERS
  const route = resolveLiveRoute({ model: MODEL })
  if (route === undefined) {
    process.stderr.write('provider-unavailable: no usable route in the ZCode config\n')
    process.exit(5)
  }
  assertRouteRoutable(route)
  const caseRoot = await buildCaseRoot()
  const random = mulberry32(SEED)
  let blocks = phaseBlocks(PHASE)
  if (ONLY_CASES !== null) blocks = blocks.filter(block => ONLY_CASES.has(block.caseId))
  if (ONLY_ARMS !== null) blocks = blocks.filter(block => ONLY_ARMS.has(block.arm))
  // Randomise within each phase/replicate, not across the whole batch, so a
  // pair remains in the same replicate.
  const grouped = new Map()
  for (const block of blocks) {
    const key = `${block.phase}|${block.replicateId}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(block)
  }
  blocks = []
  for (const key of [...grouped.keys()].sort()) blocks.push(...shuffle(grouped.get(key), random))

  await mkdir(RUN_ROOT, { recursive: true })
  await mkdir(MANIFEST_ROOT, { recursive: true })
  const results = []
  const started = new Date().toISOString()
  await writeJson(PROGRESS, {
    schemaVersion: 1,
    status: 'running',
    phase: PHASE,
    replicates: REPLICATES,
    seed: SEED,
    totalBlocks: blocks.length,
    completed: 0,
    startedAt: started,
    route: { origin: route.origin, baseUrl: route.baseUrl, keyPresent: true },
    results: [],
  })
  process.stdout.write([
    `phase: ${PHASE}`,
    `replicates: ${REPLICATES}`,
    `blocks: ${blocks.length}`,
    `route: ${route.origin}`,
    `baseUrl: ${route.baseUrl}`,
    'key: present, not logged',
  ].join('\n') + '\n')

  try {
    for (const [index, block] of blocks.entries()) {
      const result = await runBlock({ ...block, route, caseRoot })
      results.push(result)
      await writeJson(PROGRESS, {
        schemaVersion: 1,
        status: 'running',
        phase: PHASE,
        replicates: REPLICATES,
        seed: SEED,
        totalBlocks: blocks.length,
        completed: index + 1,
        startedAt: started,
        updatedAt: new Date().toISOString(),
        route: { origin: route.origin, baseUrl: route.baseUrl, keyPresent: true },
        results,
      })
      process.stdout.write(`${index + 1}/${blocks.length} ${block.runId}: ${result.status} `
        + `rows=${result.rows ?? 0} valid=${result.valid ?? 0} contract=${result.contractSuccesses ?? 0}\n`)
    }
  } finally {
    await rm(caseRoot, { recursive: true, force: true })
  }
  const executed = results.filter(result => result.status === 'executed')
  await writeJson(PROGRESS, {
    schemaVersion: 1,
    status: executed.length === results.length ? 'completed' : 'completed-with-failures',
    phase: PHASE,
    replicates: REPLICATES,
    seed: SEED,
    totalBlocks: blocks.length,
    completed: results.length,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    route: { origin: route.origin, baseUrl: route.baseUrl, keyPresent: true },
    summary: {
      executed: executed.length,
      failed: results.length - executed.length,
      rows: results.reduce((total, result) => total + (result.rows ?? 0), 0),
      valid: results.reduce((total, result) => total + (result.valid ?? 0), 0),
      contractSuccesses: results.reduce((total, result) => total + (result.contractSuccesses ?? 0), 0),
    },
    results,
  })
  process.stdout.write(`complete: ${executed.length}/${results.length} blocks; ${PROGRESS}\n`)
}

await main()
