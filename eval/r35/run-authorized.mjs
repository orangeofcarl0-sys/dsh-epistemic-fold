#!/usr/bin/env node
/**
 * Run the authorized R35 writer-only pilot against the ZCode route.
 *
 * The API key is read from the ZCode config into this process's memory and
 * passed to the child through an environment variable. It is never written to
 * the manifest, the run report, or stdout.
 *
 *   node eval/r35/run-authorized.mjs
 *   R35_STAGE=continuation node eval/r35/run-authorized.mjs
 *
 * Defaults:
 *   model       deepseek-v4.1-flash
 *   provider    5c7f8d75-e85e-4de5-9b27-e2b59eab1c7a (opencode go orange)
 *   stage       writer-only
 *   cases       A1,B2,C1,D1,F1,H1
 *   arms        S,O1 (writer-only) / B1,S,O1,O2 (continuation)
 *
 * The limits are finite by construction. "Unlimited" is not a manifest value:
 * a run with no cap cannot be audited. They are generous relative to the plan
 * and are reported in the run manifest.
 *
 * @module eval/r35/run-authorized
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRouteRoutable, resolveLiveRoute } from '../live/dist/zcode-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const LIVE = join(REPO, 'eval', 'r33', 'live.mjs')
const RUN_ROOT = join(REPO, 'eval', 'r35', 'runs')

const MODEL = process.env.R35_MODEL ?? 'deepseek-v4.1-flash'
const PROVIDER_ID = process.env.R35_PROVIDER_ID ?? '5c7f8d75-e85e-4de5-9b27-e2b59eab1c7a'
const STAGE = process.env.R35_STAGE ?? 'writer-only'
const CASES = process.env.R35_CASES ?? 'A1,B2,C1,D1,F1,H1'
const ARMS = process.env.R35_ARMS ?? (STAGE === 'writer-only' ? 'S,O1' : 'B1,S,O1,O2')
const REPLICATE_ID = process.env.R35_REPLICATE_ID ?? 'r1'
const RUN_ID = process.env.R35_RUN_ID
  ?? `r35-${STAGE}-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}`

/** The model's declared context window from ZCode's provider rules. */
function contextWindowFor(model, providerId) {
  const candidates = [
    ...(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE === undefined
      ? []
      : [process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE]),
    join(homedir(), '.zcode', 'v2', 'provider_config.json'),
  ]
  for (const path of candidates) {
    try {
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const rules = config.config?.modelConfigRules?.providerModelRules ?? []
      let found
      for (const rule of rules) {
        if (rule.modelId !== model) continue
        if (rule.providerId !== providerId) continue
        const window = rule.config?.properties?.contextWindow
        if (Number.isInteger(window) && window > 0) found = window
      }
      if (found !== undefined) return found
    } catch {
      // A missing provider config is handled by resolveLiveRoute below.
    }
  }
  return 131_072
}

async function main() {
  process.env.EF_LIVE_PROVIDER_ID = PROVIDER_ID
  process.env.EF_LIVE_MODEL = MODEL
  const baseUrlGuess = process.env.EF_LIVE_BASE_URL ?? 'https://opencode.ai/zen/go/v1'
  if (/\/zen\/go\/v1\/?$/u.test(baseUrlGuess.replace(/\/+$/u, '')) && process.env.EF_LIVE_HEADERS === undefined) {
    // The /zen/go/v1 gateway rejects a request without this header. The value
    // is a session identifier, not a credential; it is safe to record in the
    // manifest and is not reused by another run.
    process.env.EF_LIVE_HEADERS = JSON.stringify({
      'x-opencode-session': `ef-r35-${Date.now()}-${process.pid}`,
    })
  }
  const route = resolveLiveRoute({ model: MODEL })
  if (route === undefined) {
    process.stderr.write('provider-unavailable: no usable route in the ZCode config\n')
    process.exit(5)
  }
  assertRouteRoutable(route)
  const contextWindow = contextWindowFor(MODEL, PROVIDER_ID)
  const headers = route.headers ?? JSON.parse(process.env.EF_LIVE_HEADERS ?? '{}')
  const directory = await mkdtemp(join(tmpdir(), 'r35-authorized-'))
  const manifestPath = join(directory, 'manifest.json')
  // Finite limits, chosen against the preflight plan. The user authorized the
  // spend; this cap is the audit boundary, not a claim that the provider will
  // consume it. A continuation runs four arms over six cases with up to eight
  // follow-up steps each, so its request ceiling is larger than writer-only's.
  const limits = STAGE === 'continuation'
    ? { requests: 400, inputTokens: 200_000_000, outputTokens: 5_000_000, wallClockMs: 3_600_000 }
    : { requests: 60, inputTokens: 32_000_000, outputTokens: 1_000_000, wallClockMs: 1_800_000 }
  const manifest = {
    model: MODEL,
    stage: STAGE,
    maxOutputTokens: 32_768,
    limits,
    route: {
      baseUrlEnv: 'R35_LIVE_BASE_URL',
      apiKeyEnv: 'R35_LIVE_API_KEY',
      contextWindow,
      ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
    },
    cases: CASES,
    arms: ARMS,
    followUpSteps: 8,
    followUpMaxTokens: 1_024,
    replicateId: REPLICATE_ID,
    runId: RUN_ID,
    note: 'Authorized R35 pilot. The key is passed only in the child environment and is never written here.',
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const env = {
    ...process.env,
    R33_LIVE: '1',
    R35_LIVE_BASE_URL: route.baseUrl,
    R35_LIVE_API_KEY: route.apiKey,
    R33_RUN_ROOT: RUN_ROOT,
    R35_WRITE_LATEST: '0',
  }
  process.stdout.write(`route: ${route.origin}\nmodel: ${MODEL}\nstage: ${STAGE}\ncases: ${CASES}\narms: ${ARMS}\nrunId: ${RUN_ID}\ncontextWindow: ${contextWindow}\nkey: present, not logged\n`)

  if (process.env.R35_PROBE === '1') {
    // One minimal request at the production writer's actual bound. It answers
    // the only question preflight cannot: does this route accept max_tokens
    // 16,384? The result is recorded separately and is not part of the
    // experiment's case rows.
    const { OpenAiCompatibleAdapter } = await import('../live/dist/openai-adapter.js')
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: MODEL,
      contextWindow,
      ...(headers === undefined ? {} : { headers }),
    })
    let text = ''
    let usage
    let finish
    for await (const chunk of adapter.stream({
      provider: MODEL,
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready' }] }],
      maxTokens: 16_384,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    const result = {
      providerId: PROVIDER_ID,
      routeOrigin: route.origin,
      baseUrl: route.baseUrl,
      model: MODEL,
      requestedMaxTokens: 16_384,
      finish: finish ?? null,
      usage: usage ?? null,
      text: text.slice(0, 200),
      ok: finish?.kind !== 'error',
      note: 'Route capability probe, not a writer or task measurement.',
    }
    await mkdir(RUN_ROOT, { recursive: true })
    const path = join(RUN_ROOT, `route-probe-${PROVIDER_ID}.json`)
    await writeFile(path, JSON.stringify(result, null, 2), 'utf8')
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n${path}\n`)
    process.exit(result.ok ? 0 : 5)
  }

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
    if (process.env.R35_PREFLIGHT_ONLY === '1') {
      process.stdout.write('preflight passed; R35_PREFLIGHT_ONLY=1 stopped before any provider request\n')
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
