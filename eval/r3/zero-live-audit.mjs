#!/usr/bin/env node
/**
 * EF-R3 — audit that the round made no provider call.
 *
 * It compares the worktree with `baseline-r3.json`: any run directory or
 * results file created after the baseline is classified. A scripted self-test
 * is allowed and recorded; a live-mode run or a results file is a failure,
 * because R3 was authorized for offline work only.
 *
 *   node eval/r3/zero-live-audit.mjs
 *
 * @module eval/r3/zero-live-audit
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const RUNS = join(ROOT, 'eval', 'e2e', 'runs')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const baselinePath = join(OUT, 'baseline-r3.json')
if (!existsSync(baselinePath)) {
  process.stderr.write('zero-live-audit: baseline-r3.json is missing\n')
  process.exit(2)
}
const baseline = readJson(baselinePath)
const since = Date.parse(baseline.generatedAt)

function findReport(dir, depth = 0) {
  if (depth > 2) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const report = entries.find(entry => entry.isFile() && entry.name === 'report.json')
  if (report !== undefined) return join(dir, 'report.json')
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findReport(join(dir, entry.name), depth + 1)
    if (found !== null) return found
  }
  return null
}

const newRunDirs = []
if (existsSync(RUNS)) {
  for (const entry of readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(RUNS, entry.name)
    if (statSync(path).mtimeMs <= since) continue
    const reportPath = findReport(path)
    const report = reportPath === null ? null : readJson(reportPath)
    newRunDirs.push({
      name: entry.name,
      reportPath: reportPath === null ? null : reportPath.replace(ROOT, '').replace(/\\/gu, '/'),
      mode: report?.mode ?? null,
      route: report?.route?.origin ?? null,
      model: report?.model ?? null,
      requests: report?.usage?.requests ?? null,
      unknownUsage: report?.usage?.unknownUsage ?? null,
      live: report?.mode === 'live' || (report?.route?.origin !== undefined && report?.route?.origin !== 'scripted'),
    })
  }
}

const newOutFiles = []
if (existsSync(E2E_OUT)) {
  for (const entry of readdirSync(E2E_OUT, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(E2E_OUT, entry.name)
    if (statSync(path).mtimeMs <= since) continue
    newOutFiles.push(entry.name)
  }
}
const newResultsFiles = newOutFiles.filter(name => name.startsWith('results-'))
const newLiveRunDirs = newRunDirs.filter(entry => entry.live)
const newScriptedRuns = newRunDirs.filter(entry => entry.live === false)
const providerRequests = newLiveRunDirs.reduce((sum, entry) => sum + (entry.requests ?? 0), 0)

const output = {
  schemaVersion: 1,
  work: 'EF-R3',
  generatedAt: new Date().toISOString(),
  baseline: { path: 'eval/r3/out/baseline-r3.json', generatedAt: baseline.generatedAt, commit: baseline.git?.head ?? null },
  since: new Date(since).toISOString(),
  newRunDirs,
  newScriptedRuns,
  newLiveRunDirs,
  newOutFiles,
  newResultsFiles,
  providerRequests,
  status: newLiveRunDirs.length === 0 && newResultsFiles.length === 0 ? 'pass' : 'fail',
  note: 'A scripted self-test records zero provider requests. A new live-mode run or a new results file would fail this audit.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'zero-live-audit.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`zero-live audit: ${output.status}; new run dirs ${newRunDirs.length} (${newScriptedRuns.length} scripted, ${newLiveRunDirs.length} live); new results files ${newResultsFiles.length}; provider requests ${providerRequests}\n`)
if (output.status !== 'pass') process.exit(1)
