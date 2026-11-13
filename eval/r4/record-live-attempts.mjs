#!/usr/bin/env node
/**
 * EF-R4 — consolidate the route-qualification attempts.
 *
 * The campaign never started. These are credential/route probes, not task
 * results: attempt 1 hit the unreachable local proxy, attempts 2-4 hit three
 * different opencode accounts whose keys are expired.
 *
 *   node eval/r4/record-live-attempts.mjs
 *
 * @module eval/r4/record-live-attempts
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const FILES = [
  { attempt: 1, result: 'health-probe-results-attempt-1.json', analysis: 'health-probe-analysis-attempt-1.md' },
  { attempt: 2, result: 'health-probe-results-attempt-2.json', analysis: 'health-probe-analysis-attempt-2.md' },
  { attempt: 3, result: 'health-probe-results-attempt-3.json', analysis: 'health-probe-analysis-attempt-3.md' },
  { attempt: 4, result: 'health-probe-results-attempt-4.json', analysis: 'health-probe-analysis-attempt-4.md' },
]

const attempts = []
for (const entry of FILES) {
  const resultPath = join(OUT, entry.result)
  const analysisPath = join(OUT, entry.analysis)
  if (!existsSync(resultPath)) {
    process.stderr.write(`record-live-attempts: ${resultPath} is missing\n`)
    process.exit(2)
  }
  const result = readJson(resultPath)
  const first = result.results?.[0] ?? null
  const failure = first?.finish?.failure ?? null
  const message = failure?.message ?? null
  const code = failure?.code ?? null
  const authExpired = typeof message === 'string' && message.includes('api_key_expired')
  const connectionRefused = typeof message === 'string' && message.includes('ECONNREFUSED')
  attempts.push({
    attempt: entry.attempt,
    result: { path: `eval/r4/out/${entry.result}`, sha256: sha256(resultPath) },
    analysis: existsSync(analysisPath)
      ? { path: `eval/r4/out/${entry.analysis}`, sha256: sha256(analysisPath) }
      : null,
    route: result.route,
    verdict: result.verdict,
    planned: result.planned,
    attempted: result.attempted,
    successes: result.successes,
    failures: result.failures,
    firstFailure: first === null ? null : {
      profile: first.profile,
      purpose: first.purpose,
      durationMs: first.durationMs,
      finish: first.finish,
      usage: first.usage,
      error: first.error,
    },
    blocker: connectionRefused
      ? 'local-proxy-unreachable'
      : authExpired ? 'opencode-api-key-expired' : 'unknown',
  })
}

const authExpiredAttempts = attempts.filter(entry => entry.blocker === 'opencode-api-key-expired')
const decision = authExpiredAttempts.length > 0 ? 'blocked-provider-auth' : 'blocked-route-unreachable'
const output = {
  schemaVersion: 1,
  work: 'EF-R4 live route qualification',
  generatedAt: new Date().toISOString(),
  attempts,
  count: attempts.length,
  decision,
  successes: attempts.reduce((sum, entry) => sum + (entry.successes ?? 0), 0),
  planned: attempts[0]?.planned ?? 16,
  campaign: {
    campaign: 'e2e-r4-budget-sensitivity-1',
    started: false,
    reason: decision,
  },
  provider: {
    requested: 'opencode/deepseek-v4.1-flash',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    accountsTried: ['b88043d7-f229-452c-b634-4152ca14aae8', '5c7f8d75-e85e-4de5-9b27-e2b59eab1c7a', 'ac2dbaa8-7050-48e2-9d72-b21663fe3cff'],
    result: 'all three configured OpenCode keys returned HTTP 401 api_key_expired',
  },
  next: 'Replace at least one OpenCode API key in ~/.zcode/v2/config.json, then retry the same 16-request probe. No automatic retry; the campaign stays unauthorized until a probe passes.',
  note: 'No model response was produced and no usage was billed. The campaign never started.',
}

const path = join(OUT, 'live-attempts-r4.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const md = []
md.push('# EF-R4 — live route qualification attempts')
md.push('')
md.push(`Decision: **${decision}**. Campaign started: **false**.`)
md.push('')
md.push('| Attempt | Route | Result | Blocker |')
md.push('|---|---|---|---|')
for (const entry of attempts) {
  md.push(`| ${entry.attempt} | ${entry.route?.baseUrl ?? 'unknown'} | ${entry.verdict}, ${entry.successes}/${entry.planned} | ${entry.blocker} |`)
}
md.push('')
md.push(`Provider requested: \`opencode/deepseek-v4.1-flash\` at \`https://opencode.ai/zen/go/v1\`.`)
md.push('')
md.push('All three configured OpenCode accounts returned HTTP 401 `api_key_expired`. Attempt 1 used the local proxy and failed with `ECONNREFUSED`.')
md.push('')
md.push('Replace at least one OpenCode API key in `~/.zcode/v2/config.json`, then retry the probe. The 36-cell campaign remains unauthorized until the probe passes.')
md.push('')
const mdPath = join(OUT, 'live-attempts-r4.md')
writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`live attempts: ${decision}; ${attempts.length} attempts; ${output.successes}/${output.planned}; campaign started=false\n`)
process.stdout.write(`wrote ${path}, ${mdPath}\n`)
