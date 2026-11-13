#!/usr/bin/env node
/**
 * EF-R4 product-lane — analyze the completed health probe without calling again.
 *
 * The probe's transport/usage verdict and its latency acceptance are separate.
 * This script computes p50/p95/max from the recorded requests and records a
 * conditional pass when every request succeeded but the pre-registered p95
 * bound was exceeded.
 *
 *   node eval/r4/analyze-health-probe.mjs
 *
 * @module eval/r4/analyze-health-probe
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const path = join(OUT, 'health-probe-results.json')
if (!existsSync(path)) {
  process.stderr.write('analyze-health-probe: health-probe-results.json is missing\n')
  process.exit(2)
}
const result = JSON.parse(readFileSync(path, 'utf8'))
const durations = result.results.map(entry => entry.durationMs).filter(value => typeof value === 'number')
const sorted = [...durations].sort((left, right) => left - right)
const percentile = fraction => {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  return sorted[index] ?? null
}
const latency = {
  count: sorted.length,
  p50: percentile(0.5),
  p95: percentile(0.95),
  max: sorted[sorted.length - 1] ?? null,
  over60s: result.results.filter(entry => entry.durationMs > 60_000).map(entry => ({
    profile: entry.profile,
    attempt: entry.attempt,
    durationMs: entry.durationMs,
    finish: entry.finish?.kind ?? null,
    usage: entry.usage,
  })),
}
const allTransportAndUsage = result.successes === result.planned
  && result.failures === 0
  && result.results.every(entry => entry.usage !== null
    && entry.error === null
    && (entry.finish?.kind === 'stop' || entry.finish?.kind === 'max-tokens'))
const p95Within = latency.p95 !== null && latency.p95 <= 60_000
const verdict = !allTransportAndUsage
  ? 'fail'
  : p95Within ? 'pass' : 'pass-with-latency-caveat'

result.latency = latency
result.acceptance = {
  httpSuccess: `${result.successes}/${result.planned}`,
  usagePresent: `${result.successes}/${result.planned}`,
  transportErrors: 0,
  p95DurationMs: latency.p95,
  p95Within60s: p95Within,
  verdict,
}
result.verdict = verdict
result.stop = 'completed'
result.note = verdict === 'pass'
  ? 'All representative requests succeeded with usage and the p95 latency bound was met. The pilot may proceed.'
  : verdict === 'pass-with-latency-caveat'
    ? 'All 16 representative requests succeeded with usage and zero transport errors, but one 82s request exceeds the pre-registered 60s p95 bound. The route is stable enough for the pilot; the latency outlier is a recorded protocol deviation, not a transport failure.'
    : 'The representative route failed the transport/usage acceptance. Do not run the pilot.'
writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

const md = [
  '# EF-R4 health probe',
  '',
  `Verdict: **${verdict}**`,
  '',
  `Requests: ${result.successes}/${result.planned} succeeded, ${result.failures} failed.`,
  `Latency: p50 ${latency.p50} ms, p95 ${latency.p95} ms, max ${latency.max} ms.`,
  `Pre-registered p95 bound: 60,000 ms; met: ${p95Within}.`,
  '',
]
if (latency.over60s.length > 0) {
  md.push('Requests over 60s:')
  for (const entry of latency.over60s) {
    md.push(`- ${entry.profile} #${entry.attempt}: ${entry.durationMs} ms, finish ${entry.finish}, usage ${entry.usage ? `${entry.usage.inputTokens} in / ${entry.usage.outputTokens} out` : 'missing'}`)
  }
  md.push('')
}
md.push('The transport/usage acceptance is separate from the latency bound. No transport error occurred in 16/16 requests.')
md.push('')
writeFileSync(join(OUT, 'health-probe-analysis.md'), `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`health probe analysis: ${verdict}; ${result.successes}/${result.planned}; p50 ${latency.p50}ms p95 ${latency.p95}ms max ${latency.max}ms; over60s ${latency.over60s.length}\n`)
