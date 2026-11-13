#!/usr/bin/env node
/**
 * EF-R2 — resume the confirm's unexecuted cells.
 *
 * The first confirm attempt stopped at 21/54 after the local provider route
 * reset its socket: both requests in one cell carried no usage and a
 * `LIVE_TRANSPORT` error. That cell is a transport failure, not an arm outcome,
 * so it is re-run together with the cells that never started. Valid executed
 * cells are never re-run.
 *
 * This is a new manifest and therefore a new authorization hash. It stays
 * inside the same `r2-live` envelope; the pilot grant is not touched.
 *
 *   node eval/r2/freeze-resume.mjs
 *
 * @module eval/r2/freeze-resume
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sha256Text = text => createHash('sha256').update(text, 'utf8').digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

function sourceTreeDigest() {
  const lines = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => {
    const path = line.slice(line.indexOf('\t') + 1)
    return path !== 'eval/e2e/authorization.json' && !path.startsWith('eval/e2e/out/')
  })
  return sha256Text(lines.join('\n'))
}

const dirty = git('status', '--porcelain')
  .split('\n')
  .map(line => line.replace(/\r$/u, ''))
  .filter(line => {
    const path = line.slice(3)
    return path.length > 0
      && path !== 'ef-phase7-logs/watchdog.heartbeat'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/e2e/runs/')
  })

const confirmPath = join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json')
const resultsPath = join(E2E_OUT, 'results-e2e-r2-confirm-1.json')
for (const path of [confirmPath, resultsPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`freeze-resume: ${path} is missing\n`)
    process.exit(2)
  }
}
const confirm = readJson(confirmPath)
const results = readJson(resultsPath)

/** A cell is reusable only when it ran and its requests reported usage. */
const reusable = new Set()
for (const result of results.results ?? []) {
  if (result.status !== 'executed') continue
  const reportPath = result.reportPath
  if (!existsSync(reportPath)) continue
  const report = readJson(reportPath)
  const usage = report.usage
  const transportFailed = usage.requests > 0 && usage.unknownUsage === usage.requests
  if (!transportFailed) reusable.add(result.cellId)
}

const cells = confirm.cells.filter(cell => !reusable.has(`${cell.task}-${cell.arm}-r${cell.replicate}`))
const taskIds = new Set(cells.map(cell => cell.task))
const tasks = confirm.tasks.filter(task => taskIds.has(task.id))

const campaign = 'e2e-r2-confirm-resume-1'
const limits = {
  continuationCells: cells.length,
  httpAttempts: 1_200,
  inputTokens: 12_000_000,
  outputTokens: 900_000,
  wallClockMs: 4 * 60 * 60 * 1000,
  paidConcurrency: 2,
  monetaryUsd: null,
  monetaryNote: 'No verifiable per-token price is recorded.',
}

const manifest = {
  ...confirm,
  campaign,
  code: {
    evaluatedCommit: git('rev-parse', 'HEAD').trim(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
    worktreeClean: dirty.length === 0,
    sourceTreeDigest: sourceTreeDigest(),
  },
  frozenAt: new Date().toISOString(),
  status: 'resume-frozen',
  executionAuthorized: false,
  authorizationState: 'requested',
  derivedFrom: {
    confirm: 'eval/e2e/out/manifest-e2e-r2-confirm-1.json',
    sha256: sha256(confirmPath),
    confirmCells: confirm.cells.length,
    reusableCells: reusable.size,
    resumeCells: cells.length,
    stopReason: results.stopReason ?? null,
  },
  tasks,
  cells,
  limits,
  authorizationEnvelope: 'r2-live',
  note: 'Resume after a transport failure. Reusable cells are excluded; the transport-failed cell and the unexecuted cells are re-run.',
}
const manifestPath = join(E2E_OUT, `manifest-${campaign}.json`)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const stageDoc = {
  schemaVersion: 1,
  work: 'EF-R2 live',
  generatedAt: new Date().toISOString(),
  stage: 'confirm-resume',
  campaign,
  envelopeName: 'r2-live',
  manifest: { path: `eval/e2e/out/manifest-${campaign}.json`, sha256: sha256(manifestPath), cells: cells.length },
  derivedFrom: manifest.derivedFrom,
  limits,
  executionAuthorized: false,
  authorizationState: 'requested',
  note: 'A resume is a new hash: the old authorization cannot spend these cells.',
}
mkdirSync(E2E_OUT, { recursive: true })
writeFileSync(join(E2E_OUT, 'live-stage-confirm-resume.json'), `${JSON.stringify(stageDoc, null, 2)}\n`, 'utf8')

process.stdout.write(`resume: ${cells.length} cells (reusable ${reusable.size}/${confirm.cells.length}), ${tasks.length} tasks\n`)
process.stdout.write(`manifest ${manifestPath} sha256 ${stageDoc.manifest.sha256.slice(0, 16)} executionAuthorized=${manifest.executionAuthorized}\n`)
