#!/usr/bin/env node
/**
 * EF-R3 WP3 — diagnose the two EF-R2 transport failures from their raw logs.
 *
 * The two failures are both T13/B0. One cell later succeeded on the resume with
 * a comparable payload; the other has no retry. This script asks whether the
 * failed requests are payload outliers, whether they fail before or after the
 * request leaves the machine, and what the archived trace can and cannot say.
 *
 * It makes no network request and reads no credential.
 *
 *   node eval/r3/transport-diagnose.mjs
 *
 * @module eval/r3/transport-diagnose
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const ledgerPath = join(OUT, 'attempt-ledger.json')
if (!existsSync(ledgerPath)) {
  process.stderr.write('transport-diagnose: run eval/r3/reconcile-confirm.mjs first; attempt-ledger.json is missing\n')
  process.exit(2)
}
const ledger = readJson(ledgerPath)
const allAttempts = [...(ledger.confirm?.attempts ?? []), ...(ledger.pilot?.attempts ?? [])]

function requestPath(attempt) {
  if (attempt.reportPath === null || attempt.reportPath === undefined) return null
  return join(dirname(attempt.reportPath), 'raw', 'requests.json')
}

function readRequests(attempt) {
  const path = requestPath(attempt)
  if (path === null || !existsSync(path)) return null
  return readJson(path)
}

function summarizeRequest(request) {
  const messages = Array.isArray(request.messages) ? request.messages : []
  const systemChars = Number(request.system?.chars ?? 0)
  const messageChars = messages.reduce((sum, message) => sum + Number(message.chars ?? 0), 0)
  const maxMessageChars = messages.reduce((max, message) => Math.max(max, Number(message.chars ?? 0)), 0)
  const toolChars = messages
    .filter(message => message.role === 'tool')
    .reduce((sum, message) => sum + Number(message.chars ?? 0), 0)
  const error = request.finish?.kind === 'error' ? request.finish.failure ?? {} : null
  const durationMs = request.durationMs ?? null
  const message = error?.message ?? null
  let classification = 'success'
  if (error !== null) {
    if (error.code === 'LIVE_TRANSPORT') {
      if (/timeout|aborted|timed out/iu.test(message ?? '')) classification = 'timeout'
      else if (durationMs !== null && durationMs <= 100) classification = 'immediate-reset'
      else classification = 'mid-flight-reset'
    } else if (error.code === 'LIVE_HTTP') classification = 'provider-http'
    else if (error.code === 'BUDGET_EXHAUSTED') classification = 'budget'
    else classification = 'unclassified'
  }
  return {
    index: request.index,
    at: request.at ?? null,
    purpose: request.purpose ?? null,
    maxTokens: request.maxTokens ?? null,
    systemChars,
    messageChars,
    maxMessageChars,
    toolChars,
    messageCount: messages.length,
    durationMs,
    finishKind: request.finish?.kind ?? null,
    errorCode: error?.code ?? null,
    errorMessage: message,
    httpAttempts: request.diagnostics?.attempts?.length ?? null,
    bodyBytes: request.bodyBytes ?? request.diagnostics?.bodyBytes ?? null,
    classification,
  }
}

function requestsFor(attempt) {
  const requests = readRequests(attempt)
  if (requests === null) return { available: false, path: requestPath(attempt), requests: [] }
  return {
    available: true,
    path: requestPath(attempt),
    requests: requests.map(summarizeRequest),
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function distribution(values) {
  if (values.length === 0) return { count: 0, min: null, median: null, max: null }
  return {
    count: values.length,
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
  }
}

const failures = allAttempts.filter(attempt => attempt.status === 'transport-failed')
const failureCases = failures.map(attempt => {
  const trace = requestsFor(attempt)
  const retry = allAttempts.find(candidate => candidate.cellKey === attempt.cellKey
    && candidate.status === 'valid'
    && candidate.campaignIndex > attempt.campaignIndex)
  return {
    attemptId: attempt.attemptId,
    campaign: attempt.campaign,
    cellId: attempt.cellKey,
    task: attempt.cell.task,
    arm: attempt.cell.arm,
    reportPath: attempt.reportPath,
    requests: trace.requests,
    traceAvailable: trace.available,
    retry: retry === undefined ? null : {
      attemptId: retry.attemptId,
      campaign: retry.campaign,
      checker: retry.checker,
      requests: requestsFor(retry).requests,
    },
  }
})

const b0Valid = allAttempts.filter(attempt => attempt.cell.arm === 'B0' && attempt.status === 'valid')
const b0Summary = []
const b0Primary = []
for (const attempt of b0Valid) {
  const trace = requestsFor(attempt)
  for (const request of trace.requests) {
    if (request.purpose === 'summary') b0Summary.push(request)
    if (request.purpose === 'primary') b0Primary.push(request)
  }
}
const b0SummaryChars = b0Summary.map(request => request.messageChars)
const b0SummaryDurations = b0Summary.filter(request => request.durationMs !== null).map(request => request.durationMs)

const comparisons = failureCases.map(entry => {
  const failedSummary = entry.requests.find(request => request.purpose === 'summary') ?? null
  const retrySummary = entry.retry?.requests.find(request => request.purpose === 'summary') ?? null
  const failedPrimary = entry.requests.find(request => request.purpose === 'primary') ?? null
  const retryPrimary = entry.retry?.requests.find(request => request.purpose === 'primary') ?? null
  return {
    cellId: entry.cellId,
    failedSummary: failedSummary === null ? null : {
      messageChars: failedSummary.messageChars,
      maxMessageChars: failedSummary.maxMessageChars,
      durationMs: failedSummary.durationMs,
      classification: failedSummary.classification,
    },
    retrySummary: retrySummary === null ? null : {
      messageChars: retrySummary.messageChars,
      maxMessageChars: retrySummary.maxMessageChars,
      durationMs: retrySummary.durationMs,
      classification: retrySummary.classification,
    },
    failedPrimary: failedPrimary === null ? null : {
      messageChars: failedPrimary.messageChars,
      durationMs: failedPrimary.durationMs,
      classification: failedPrimary.classification,
    },
    retryPrimary: retryPrimary === null ? null : {
      messageChars: retryPrimary.messageChars,
      durationMs: retryPrimary.durationMs,
      classification: retryPrimary.classification,
    },
  }
})

const failedSummaryChars = comparisons
  .map(entry => entry.failedSummary?.messageChars)
  .filter(value => value !== undefined && value !== null)
const payloadWithinSuccessfulRange = failedSummaryChars.length > 0
  && b0SummaryChars.length > 0
  && failedSummaryChars.every(value => value <= Math.max(...b0SummaryChars))
const payloadLargerThanSuccessful = failedSummaryChars.some(value => value > Math.max(...b0SummaryChars))
const immediate = failureCases.every(entry => entry.requests
  .filter(request => request.finishKind === 'error')
  .every(request => request.classification === 'immediate-reset'))
const retriedSuccessfully = failureCases.filter(entry => entry.retry !== null).length
const unresolved = failureCases.filter(entry => entry.retry === null).length

const hypotheses = [
  {
    id: 'payload-size',
    statement: 'The failed requests carried a payload larger than successful B0 requests, so the route rejected the size.',
    status: payloadLargerThanSuccessful ? 'supported' : payloadWithinSuccessfulRange ? 'weakened' : 'unresolved',
    confidence: payloadLargerThanSuccessful ? 'medium' : 'low',
    evidence: {
      failedSummaryChars,
      b0SummaryChars: distribution(b0SummaryChars),
      everyFailedSummaryAtOrBelowSuccessfulMax: payloadWithinSuccessfulRange,
    },
  },
  {
    id: 'immediate-connect-reset',
    statement: 'The transport failed before a response was produced, within the first ~100 ms, rather than timing out mid-stream.',
    status: immediate ? 'supported' : 'unresolved',
    confidence: immediate ? 'medium' : 'low',
    evidence: {
      failures: failureCases.map(entry => ({
        cellId: entry.cellId,
        requests: entry.requests.map(request => ({
          purpose: request.purpose,
          durationMs: request.durationMs,
          classification: request.classification,
        })),
      })),
    },
  },
  {
    id: 'route-transient',
    statement: 'The same cell succeeded on a later attempt with a comparable payload, which points to a transient local route condition rather than a deterministic task/input defect.',
    status: retriedSuccessfully > 0 ? 'supported' : 'unresolved',
    confidence: retriedSuccessfully > 0 ? 'medium' : 'low',
    evidence: {
      retriedSuccessfully,
      unresolved,
      comparisons,
    },
  },
  {
    id: 'provider-http',
    statement: 'The provider returned an HTTP error status that explains the failure.',
    status: failureCases.some(entry => entry.requests.some(request => request.classification === 'provider-http'))
      ? 'supported' : 'unsupported',
    confidence: 'high',
    evidence: {
      observedCodes: [...new Set(failureCases.flatMap(entry => entry.requests.map(request => request.errorCode)))],
    },
  },
  {
    id: 'concurrency-or-socket-reuse',
    statement: 'Concurrency pressure or reuse of a closed socket caused the reset.',
    status: 'unresolved',
    confidence: 'unknown',
    evidence: {
      note: 'The archived request log has one logical call per fetch and no connection identity. The R3 adapter instrumentation adds bodyBytes and per-attempt diagnostics for future runs, but it cannot reconstruct this history.',
      globalFetch: true,
      transportRetriesForTransportErrors: false,
    },
  },
]

const output = {
  schemaVersion: 1,
  work: 'EF-R3 WP3',
  generatedAt: new Date().toISOString(),
  inputs: {
    attemptLedger: { path: 'eval/r3/out/attempt-ledger.json', sha256: sha256(ledgerPath) },
  },
  failureCount: failures.length,
  failures: failureCases,
  b0Baseline: {
    validCells: b0Valid.length,
    summaryRequests: b0Summary.length,
    primaryRequests: b0Primary.length,
    summaryMessageChars: distribution(b0SummaryChars),
    summaryDurationMs: distribution(b0SummaryDurations),
    successfulSummaryDurations: b0Summary.map((request, index) => ({
      index,
      messageChars: request.messageChars,
      durationMs: request.durationMs,
    })),
  },
  comparisons,
  hypotheses,
  classification: {
    immediate,
    retriedSuccessfully,
    unresolved,
    payloadWithinSuccessfulRange,
    payloadLargerThanSuccessful,
  },
  decision: 'Treat both failures as provider-route transport attempts, not arm outcomes. The failed cells are excluded from task outcomes and remain in the attempt ledger. No completion run until a representative B0 summary/primary health probe passes under a new authorization.',
  limits: [
    'Only two failures; this is a description, not a provider-level causal estimate.',
    'The archived log has no socket identity, no keep-alive state and no real HTTP attempt count for transport errors.',
    'The one successful retry is same-cell evidence, but it does not prove the route is stable now.',
    'No request body or response body is included; only sizes and error metadata.',
  ],
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'transport-diagnosis.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`transport: ${failures.length} failed attempts, ${retriedSuccessfully} with a successful retry, ${unresolved} unresolved\n`)
for (const entry of comparisons) {
  process.stdout.write(`  ${entry.cellId}: failed summary ${entry.failedSummary?.messageChars ?? '?'} chars/${entry.failedSummary?.durationMs ?? '?'}ms; retry ${entry.retrySummary?.messageChars ?? 'n/a'} chars/${entry.retrySummary?.durationMs ?? 'n/a'}ms\n`)
}
process.stdout.write(`  B0 successful summary chars: ${JSON.stringify(output.b0Baseline.summaryMessageChars)}\n`)
process.stdout.write(`  hypotheses: ${hypotheses.map(h => `${h.id}=${h.status}`).join(', ')}\n`)
process.stdout.write(`wrote ${path}\n`)
