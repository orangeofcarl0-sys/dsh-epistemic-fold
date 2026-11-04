#!/usr/bin/env node
/**
 * Run an authorized R36 live stage against the resolved ZCode route.
 *
 * The route and key are resolved at runtime from the ZCode configuration and
 * held in this process's memory. The key is passed to the child only through an
 * environment variable; it is never written to a manifest, report, or stdout.
 *
 *   node eval/r36/run-authorized.mjs
 *   R36_STAGE=continuation R36_ARMS=O2 R36_FINISH_GUARD=1 node eval/r36/run-authorized.mjs
 *
 * Defaults are the Phase B writer pair: writer-only, S arm, W1 prompt, six
 * certified cases. W0 is selected with R36_PROMPT=W0. The local ZCode proxy is
 * the default provider because the direct OpenCode keys are expired; override
 * it with R36_PROVIDER_ID when a working direct route is configured.
 *
 * @module eval/r36/run-authorized
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRouteRoutable, resolveLiveRoute } from '../live/dist/zcode-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const LIVE = join(REPO, 'eval', 'r33', 'live.mjs')
const RUN_ROOT = join(REPO, 'eval', 'r36', 'runs')

const MODEL = process.env.R36_MODEL ?? 'deepseek-v4.1-flash'
const PROVIDER_ID = process.env.R36_PROVIDER_ID ?? 'c15ab109-97b8-4de1-a647-9857a635be38'
const STAGE = process.env.R36_STAGE ?? 'writer-only'
const PROMPT = process.env.R36_PROMPT ?? 'W1'
const CASES = process.env.R36_CASES ?? 'A1,B2,C1,D1,F1,H1'
const ARMS = process.env.R36_ARMS ?? (STAGE === 'writer-only' ? 'S' : 'O2')
const REPLICATE_ID = process.env.R36_REPLICATE_ID ?? 'r1'
const FINISH_GUARD = process.env.R36_FINISH_GUARD === '1'
const FOLLOW_UP_STEPS = Number(process.env.R36_FOLLOW_UP_STEPS ?? 8)
const FOLLOW_UP_MAX_TOKENS = Number(process.env.R36_FOLLOW_UP_MAX_TOKENS ?? 1024)
const RUNTIME = process.env.R36_RUNTIME ?? 'custom-json-loop'
const RUN_ID = process.env.R36_RUN_ID
  ?? `r36-${STAGE}-${PROMPT.toLowerCase()}-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}`

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

async function main() {
  if (PROMPT !== 'W0' && PROMPT !== 'W1') {
    process.stderr.write(`unknown R36_PROMPT ${PROMPT}; expected W0 or W1\n`)
    process.exit(2)
  }
  if (!['writer-only', 'continuation'].includes(STAGE)) {
    process.stderr.write(`unknown R36_STAGE ${STAGE}; expected writer-only or continuation\n`)
    process.exit(2)
  }
  for (const [name, value] of [
    ['R36_FOLLOW_UP_STEPS', FOLLOW_UP_STEPS],
    ['R36_FOLLOW_UP_MAX_TOKENS', FOLLOW_UP_MAX_TOKENS],
  ]) {
    if (!positiveInteger(value)) {
      process.stderr.write(`${name} must be a positive integer\n`)
      process.exit(2)
    }
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
  const contextWindow = Number(process.env.R36_CONTEXT_WINDOW ?? 131_072)
  const headers = route.headers ?? {}
  const limits = STAGE === 'continuation'
    ? { requests: 400, inputTokens: 200_000_000, outputTokens: 5_000_000, wallClockMs: 3_600_000 }
    : { requests: 60, inputTokens: 32_000_000, outputTokens: 1_000_000, wallClockMs: 1_800_000 }
  const manifest = {
    schemaVersion: 1,
    id: `r36-${STAGE}-${PROMPT.toLowerCase()}-${REPLICATE_ID}`,
    model: MODEL,
    stage: STAGE,
    maxOutputTokens: 16_384,
    limits,
    route: {
      baseUrlEnv: 'R36_LIVE_BASE_URL',
      apiKeyEnv: 'R36_LIVE_API_KEY',
      contextWindow,
      maxOutputTokens: 32_768,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    },
    cases: CASES,
    arms: ARMS,
    followUpSteps: FOLLOW_UP_STEPS,
    followUpMaxTokens: FOLLOW_UP_MAX_TOKENS,
    finishGuard: FINISH_GUARD,
    runtime: RUNTIME,
    harnessVersion: RUNTIME === 'dsh-agent' ? 'H-native' : 'H0-custom-json-loop',
    writerPromptVersion: PROMPT,
    replicateId: REPLICATE_ID,
    runId: RUN_ID,
    note: 'Authorized R36 live stage. The key is passed only in the child environment and is never written here.',
  }
  const directory = await mkdtemp(join(tmpdir(), 'r36-authorized-'))
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  await mkdir(RUN_ROOT, { recursive: true })
  const env = {
    ...process.env,
    R33_LIVE: '1',
    R36_LIVE_BASE_URL: route.baseUrl,
    R36_LIVE_API_KEY: route.apiKey,
    R33_RUN_ROOT: RUN_ROOT,
    R35_WRITE_LATEST: '0',
  }
  process.stdout.write([
    `route: ${route.origin}`,
    `baseUrl: ${route.baseUrl}`,
    `model: ${MODEL}`,
    `stage: ${STAGE}`,
    `prompt: ${PROMPT}`,
    `arms: ${ARMS}`,
    `cases: ${CASES}`,
    `finishGuard: ${FINISH_GUARD}`,
    `followUp: ${FOLLOW_UP_STEPS} steps / ${FOLLOW_UP_MAX_TOKENS} tokens`,
    `runId: ${RUN_ID}`,
    `key: present, not logged`,
  ].join('\n') + '\n')

  const run = (args) => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [LIVE, ...args], { cwd: REPO, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => resolvePromise(code ?? -1))
  })
  try {
    const preflight = await run(['--preflight', '--manifest', manifestPath])
    if (preflight !== 0) {
      process.stderr.write(`preflight refused the plan (exit ${preflight}); no provider request was made\n`)
      process.exit(preflight)
    }
    if (process.env.R36_PREFLIGHT_ONLY === '1') {
      process.stdout.write('preflight passed; R36_PREFLIGHT_ONLY=1 stopped before any provider request\n')
      process.exit(0)
    }
    const code = await run(['--run', '--manifest', manifestPath])
    process.stdout.write(`\nrun exit: ${code}\nreport: ${join(RUN_ROOT, RUN_ID, 'report.json')}\n`)
    process.exit(code)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
