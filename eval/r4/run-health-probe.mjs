#!/usr/bin/env node
/**
 * EF-R4 product-lane — run the representative transport health probe.
 *
 * This is the first live step after the offline preflight. It sends the four
 * long-payload profiles from `transport-health-probe.json` four times each
 * through the resolved live route. It stops on the first transport error, null
 * usage or HTTP failure. A failed probe cancels the pilot.
 *
 *   node eval/r4/run-health-probe.mjs
 *
 * The probe design is immutable. A separate authorization file must be granted
 * and must name the design SHA-256.
 *
 * @module eval/r4/run-health-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ToolCallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { OpenAiCompatibleAdapter } from '../live/dist/openai-adapter.js'
import { assertRouteRoutable, resolveLiveRoute } from '../live/dist/zcode-config.js'
import { BudgetLedger } from '../r33/src/budget.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const designPath = join(OUT, 'transport-health-probe.json')
const authorizationPath = join(OUT, 'health-probe-authorization.json')
if (!existsSync(designPath)) {
  process.stderr.write('health-probe: the design artifact is missing\n')
  process.exit(2)
}
const design = readJson(designPath)
if (!existsSync(authorizationPath)) {
  process.stderr.write('health-probe: the authorization artifact is missing; refusing to run\n')
  process.exit(2)
}
const authorization = readJson(authorizationPath)
if (authorization.granted !== true) {
  process.stderr.write('health-probe: authorization is not granted\n')
  process.exit(2)
}
const designSha256 = authorization.designSha256 ?? authorization.design?.sha256
if (designSha256 !== sha256(designPath)) {
  process.stderr.write('health-probe: authorization does not name the current design SHA-256\n')
  process.exit(2)
}
if (design.executionAuthorized !== false && design.executionAuthorized !== true) {
  process.stderr.write('health-probe: design executionAuthorized is not a boolean\n')
  process.exit(2)
}

const taskPath = join(ROOT, 'eval', 'e2e', 'tasks-r2', 'T13-s1.json')
const task = readJson(taskPath)
const toolText = task.history
  .filter(entry => entry.role === 'tool' && typeof entry.text === 'string')
  .sort((left, right) => right.text.length - left.text.length)[0]?.text ?? 'X'.repeat(70_000)

const MODEL = design.model
const route = resolveLiveRoute({ model: MODEL })
assertRouteRoutable(route)

const SUMMARY_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant.',
  'Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code Sections',
  '## Errors and fixes',
  '## Problem Solving',
  '## All user messages',
  '## Pending Tasks',
  '## Current Work',
  '## Optional Next Step',
  'Keep every fact from the conversation. Do not invent. Do not summarize away identifiers.',
  'x'.repeat(900),
].join('\n')

function textChars(messages, system) {
  let chars = system?.length ?? 0
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return chars
}

function buildProfile(profile) {
  const system = 'You are a coding assistant. Use the tools to complete the task.'
  const callId = ToolCallId(`health-${profile.id.replace(/[^a-z0-9-]/giu, '-')}`)
  const base = [
    createUserMessage({
      content: [{ type: 'text', text: 'Read the build manifest and tell me the published channel and build id.' }],
      source: { kind: 'user' },
    }),
    createMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading read_file.' },
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'ef-e2e', model: MODEL },
    }),
    createToolResultMessage({
      callId,
      isError: false,
      content: [{ type: 'text', text: toolText }],
    }),
    createUserMessage({
      content: [{ type: 'text', text: 'The file is rotated now. I still need the channel and build from the version you read before the rotation.' }],
      source: { kind: 'user' },
    }),
  ]
  if (profile.purpose === 'summary') {
    const baseChars = textChars(base, system)
    const pad = Math.max(0, profile.messageChars - baseChars - SUMMARY_INSTRUCTION.length)
    const lastText = `${SUMMARY_INSTRUCTION}${'x'.repeat(pad)}`
    const messages = [
      ...base,
      createUserMessage({ content: [{ type: 'text', text: lastText }], source: { kind: 'user' } }),
    ]
    return { system, messages, actualChars: textChars(messages, system) }
  }
  const assistant = createMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'The manifest was published; I have the channel and build id from that read.' }],
    source: { kind: 'model', provider: 'ef-e2e', model: MODEL },
  })
  const baseChars = textChars([...base, assistant], system)
  const prompt = 'Now write the channel and build id to result.json.'
  const pad = Math.max(0, profile.messageChars - baseChars - prompt.length)
  const lastText = `${prompt}${'x'.repeat(pad)}`
  const messages = [
    ...base,
    assistant,
    createUserMessage({ content: [{ type: 'text', text: lastText }], source: { kind: 'user' } }),
  ]
  return { system, messages, actualChars: textChars(messages, system) }
}

const isSuccess = result => result.error === null
  && result.usage !== null
  && (result.finish?.kind === 'stop' || result.finish?.kind === 'max-tokens')

const resultsPath = join(OUT, 'health-probe-results.json')
const resume = process.argv.includes('--resume')
let priorResults = []
let priorUsage = null
if (resume && existsSync(resultsPath)) {
  const prior = JSON.parse(readFileSync(resultsPath, 'utf8'))
  priorResults = prior.results ?? []
  priorUsage = prior.usage ?? null
  if (!priorResults.every(isSuccess)) {
    process.stderr.write('health-probe: the previous probe has a failure; do not retry without a new authorization\n')
    process.exit(2)
  }
}
const used = priorUsage?.used ?? {
  requests: priorResults.length,
  inputTokens: priorResults.reduce((sum, result) => sum + (result.usage?.inputTokens ?? 0), 0),
  outputTokens: priorResults.reduce((sum, result) => sum + (result.usage?.outputTokens ?? 0), 0),
  wallClockMs: priorResults.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
}
const limits = {
  requests: design.envelope.requests - used.requests,
  inputTokens: design.envelope.inputTokens - used.inputTokens,
  outputTokens: design.envelope.outputTokens - used.outputTokens,
  wallClockMs: design.envelope.wallClockMs - used.wallClockMs,
}
const ledger = new BudgetLedger(limits, { maxRequestOutputTokens: 1_024 })

const diagnostics = []
const adapter = new OpenAiCompatibleAdapter({
  baseUrl: route.baseUrl,
  apiKey: route.apiKey,
  model: MODEL,
  contextWindow: 131_072,
  ...(route.headers === undefined ? {} : { headers: route.headers }),
  budget: ledger,
  onAttempt: info => diagnostics.push(info),
})

async function request(profile, attempt) {
  const built = buildProfile(profile)
  const before = diagnostics.length
  const started = Date.now()
  const chunks = []
  let error = null
  try {
    for await (const chunk of adapter.stream({
      system: built.system,
      messages: built.messages,
      maxTokens: 1_024,
    })) {
      chunks.push(chunk)
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage ?? null
  const finish = chunks.find(chunk => chunk.type === 'finish')?.reason ?? null
  const attempts = diagnostics.slice(before)
  return {
    profile: profile.id,
    purpose: profile.purpose,
    attempt,
    targetChars: profile.messageChars,
    actualChars: built.actualChars,
    durationMs: Date.now() - started,
    usage,
    finish,
    error,
    httpAttempts: attempts.filter(entry => entry.phase === 'start').length,
    bodyBytes: attempts.find(entry => typeof entry.bodyBytes === 'number')?.bodyBytes ?? null,
    diagnostics: attempts,
  }
}

async function main() {
  const results = [...priorResults]
  const completed = new Set(priorResults.filter(isSuccess).map(result => `${result.profile}:${result.attempt}`))
  const attemptsPerProfile = design.attemptsPerProfile
  let stopped = false
  outer: for (const profile of design.payloadProfiles) {
    for (let attempt = 1; attempt <= attemptsPerProfile; attempt += 1) {
      const key = `${profile.id}:${attempt}`
      if (completed.has(key)) continue
      const result = await request(profile, attempt)
      results.push(result)
      process.stdout.write(`${profile.id} #${attempt}: finish=${result.finish?.kind ?? 'none'} usage=${result.usage ? `${result.usage.inputTokens}in/${result.usage.outputTokens}out` : 'missing'} ${result.durationMs}ms\n`)
      if (!isSuccess(result)) {
        process.stdout.write(`health probe stopped at ${profile.id} #${attempt}: ${result.error ?? result.finish?.failure?.code ?? 'usage-missing'}\n`)
        stopped = true
        break outer
      }
    }
  }
  const snapshot = ledger.snapshot()
  const successes = results.filter(isSuccess)
  const failures = results.filter(result => !isSuccess(result))
  const verdict = successes.length === design.totalRequests && failures.length === 0 ? 'pass' : 'fail'
  const output = {
    schemaVersion: 1,
    work: 'EF-R4 health probe',
    generatedAt: new Date().toISOString(),
    design: { path: 'eval/r4/out/transport-health-probe.json', sha256: sha256(designPath) },
    authorization: { path: 'eval/r4/out/health-probe-authorization.json', sha256: sha256(authorizationPath), grantedBy: authorization.grantedBy },
    route: { origin: route.origin, baseUrl: route.baseUrl, headerNames: Object.keys(route.headers ?? {}), model: MODEL },
    planned: design.totalRequests,
    attempted: results.length,
    successes: successes.length,
    failures: failures.length,
    verdict,
    resume: { used: priorResults.length, priorUsage },
    usage: snapshot,
    totalUsage: {
      requests: results.length,
      inputTokens: (priorUsage?.used?.inputTokens ?? 0) + (snapshot.used?.inputTokens ?? 0),
      outputTokens: (priorUsage?.used?.outputTokens ?? 0) + (snapshot.used?.outputTokens ?? 0),
    },
    results,
    stop: stopped || failures.length > 0 ? 'stopped-on-failure' : 'completed',
    note: verdict === 'pass'
      ? 'The representative long-payload route passed. The product pilot may proceed under its separate authorization.'
      : 'The route did not pass the representative probe. Do not run the product pilot; keep the offline evidence and stop.',
  }
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'health-probe-results.json')
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`health probe: ${verdict}; ${successes.length}/${design.totalRequests} successes; requests ${snapshot.attempts} (charged ${snapshot.chargedRequests ?? snapshot.attempts})\n`)
  process.stdout.write(`wrote ${path}\n`)
  if (verdict !== 'pass') process.exit(1)
}

main().catch(error => {
  process.stderr.write(`health probe failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
