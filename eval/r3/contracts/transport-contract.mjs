#!/usr/bin/env node
/**
 * EF-R3 — transport contract against a local mock server.
 *
 * This does not call a provider. It proves three things the archive cannot:
 *
 *   1. an immediate socket reset is classified as LIVE_TRANSPORT, not as a
 *      task failure or a silent success;
 *   2. a mid-response reset is never accepted as a successful empty reply;
 *   3. the new per-attempt diagnostics record body bytes and the real HTTP
 *      phase without the request body or credential.
 *
 * It also pins the ledger's partial-usage rule: a checker result can be valid
 * while the cost ledger is incomplete.
 *
 *   node eval/r3/contracts/transport-contract.mjs
 *
 * @module eval/r3/contracts/transport-contract
 */

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAiCompatibleAdapter } from '../../live/dist/openai-adapter.js'
import { classifyReport } from '../ledger.mjs'

const checks = []
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail })
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}\n`)
}

const SUCCESS_BODY = JSON.stringify({
  model: 'mock-model',
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
})

function startServer() {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/reset/')) {
      request.socket.destroy()
      return
    }
    if (request.url.startsWith('/partial/')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"choices":[')
      setTimeout(() => response.destroy(), 10)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(SUCCESS_BODY)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port })
    })
  })
}

function userMessage() {
  return [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
}

async function collect(adapter, options) {
  const chunks = []
  let error = null
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  } catch (caught) {
    error = caught
  }
  return {
    chunks,
    error,
    usage: chunks.find(chunk => chunk.type === 'usage')?.usage ?? null,
    finish: chunks.find(chunk => chunk.type === 'finish')?.reason ?? null,
    text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
  }
}

function makeAdapter(baseUrl, diagnostics) {
  return new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey: 'contract-placeholder',
    model: 'mock-model',
    contextWindow: 4_096,
    onAttempt: info => diagnostics.push(info),
  })
}

async function main() {
  const { server, port } = await startServer()
  try {
    // 1. A normal response is still accepted and records one real HTTP response.
    {
      const diagnostics = []
      const adapter = makeAdapter(`http://127.0.0.1:${port}/success`, diagnostics)
      const result = await collect(adapter, { messages: userMessage(), maxTokens: 16 })
      check('success.finish', result.finish?.kind === 'stop', JSON.stringify(result.finish))
      check('success.text', result.text === 'ok', `text=${result.text}`)
      check('success.usage', result.usage?.inputTokens === 10 && result.usage?.outputTokens === 2, JSON.stringify(result.usage))
      check('success.diagnostics', diagnostics.some(entry => entry.phase === 'start')
        && diagnostics.some(entry => entry.phase === 'response' && entry.status === 200)
        && diagnostics.every(entry => entry.bodyBytes > 0), JSON.stringify(diagnostics.map(entry => entry.phase)))
    }

    // 2. An immediate socket reset is a transport failure, never a task outcome.
    {
      const diagnostics = []
      const adapter = makeAdapter(`http://127.0.0.1:${port}/reset`, diagnostics)
      const result = await collect(adapter, { messages: userMessage(), maxTokens: 16 })
      const failure = result.finish?.kind === 'error' ? result.finish.failure : null
      check('reset.finish', failure?.code === 'LIVE_TRANSPORT', JSON.stringify(result.finish))
      check('reset.no-usage', result.usage === null, JSON.stringify(result.usage))
      check('reset.diagnostics', diagnostics.some(entry => entry.phase === 'start')
        && diagnostics.some(entry => entry.phase === 'error')
        && diagnostics.every(entry => entry.bodyBytes > 0), JSON.stringify(diagnostics.map(entry => entry.phase)))
    }

    // 3. A reset after a partial body is never accepted as a successful empty reply.
    {
      const diagnostics = []
      const adapter = makeAdapter(`http://127.0.0.1:${port}/partial`, diagnostics)
      const result = await collect(adapter, { messages: userMessage(), maxTokens: 16 })
      const silentSuccess = result.error === null
        && result.finish?.kind === 'stop'
        && result.text === ''
      check('partial.not-silent-success', silentSuccess === false, JSON.stringify({
        error: result.error?.message ?? null,
        finish: result.finish,
        text: result.text,
      }))
      check('partial.diagnostics', diagnostics.some(entry => entry.phase === 'start'), JSON.stringify(diagnostics.map(entry => entry.phase)))
    }

    // 4. Partial usage is a valid task outcome with an incomplete cost ledger.
    {
      const classification = classifyReport({
        result: { checker: true },
        report: {
          usage: { requests: 10, unknownUsage: 2, inputTokens: 100, outputTokens: 10 },
          witnesses: [],
          witnessSummary: { attempts: 1 },
          termination: { kind: 'finish' },
        },
      })
      check('partial-usage.task', classification.status === 'valid' && classification.taskOutcomeValid, JSON.stringify(classification.status))
      check('partial-usage.cost', classification.costValid === false, `costValid=${classification.costValid}`)
    }

    // 5. All-null usage is a transport attempt, not a task failure with a checker.
    {
      const classification = classifyReport({
        result: { checker: false },
        report: {
          usage: { requests: 2, unknownUsage: 2, inputTokens: 0, outputTokens: 0 },
          witnesses: [],
          witnessSummary: { attempts: 0 },
          termination: { kind: 'error' },
        },
      })
      check('all-null.transport', classification.status === 'transport-failed', `status=${classification.status}`)
      check('all-null.no-task-outcome', classification.taskOutcomeValid === false, `taskOutcomeValid=${classification.taskOutcomeValid}`)
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  const passed = checks.filter(entry => entry.pass).length
  const failed = checks.length - passed
  const output = {
    schemaVersion: 1,
    work: 'EF-R3 WP3',
    generatedAt: new Date().toISOString(),
    checks,
    passed,
    failed,
    verdict: failed === 0 ? 'contract-pass' : 'contract-fail',
    note: 'Local mock server only; no provider request and no credential.',
  }
  const outDir = join(process.cwd(), 'eval', 'r3', 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'transport-contract.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`${passed}/${checks.length} checks passed\n`)
  if (failed > 0) process.exit(1)
}

main()
