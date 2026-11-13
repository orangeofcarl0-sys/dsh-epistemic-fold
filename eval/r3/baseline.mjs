#!/usr/bin/env node
/**
 * EF-R3 WP0 — freeze the starting point and the immutable R2 artifacts.
 *
 * The R2 baseline was recorded at 34af295, before the R2 engineering and live
 * stages. R3 starts at 4affdee. This file records that HEAD, the PR/CI state,
 * the R2 gate outcome, and the SHA-256 of every R2 artifact R3 will read.
 *
 *   node eval/r3/baseline.mjs
 *
 * @module eval/r3/baseline
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()
}

function tryJson(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }))
  } catch (error) {
    return { error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}

const IMMUTABLE = [
  'eval/e2e/out/manifest-e2e-r2-confirm-1.json',
  'eval/e2e/out/results-e2e-r2-confirm-1.json',
  'eval/e2e/out/manifest-e2e-r2-confirm-resume-1.json',
  'eval/e2e/out/results-e2e-r2-confirm-resume-1.json',
  'eval/e2e/out/results-e2e-r2-confirm-merged.json',
  'eval/e2e/out/manifest-e2e-r2-pilot-1.json',
  'eval/e2e/out/results-e2e-r2-pilot-1.json',
  'eval/e2e/out/analysis-e2e-r2-pilot-1.json',
  'eval/e2e/out/evidence-index-e2e-r2-pilot-1.json',
  'eval/r2/out/live-route-incident.json',
  'eval/r2/out/live-pilot-analysis.json',
  'eval/r2/out/live-confirm-analysis.json',
  'eval/r2/out/live-design-r2.json',
  'eval/r2/out/gate-status.json',
  'eval/r2/out/compaction-witnesses.json',
  'eval/r2/out/rationale-failure-attribution.json',
  'eval/r2/out/active-task-delivery.json',
  'eval/r2/out/causal-reanalysis.json',
  'eval/r2/out/cost-ledger.json',
  'eval/r2/out/authority-closure.json',
  'eval/r2/out/research-archive-r2.json',
  'docs/convergence/EF_R2.md',
]

const dirty = git('status', '--porcelain')
  .split('\n')
  .map(line => line.replace(/\r$/u, ''))
  .filter(line => {
    const path = line.slice(3)
    return path.length > 0
      && path !== 'ef-phase7-logs/watchdog.heartbeat'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/e2e/runs/')
      && !path.startsWith('eval/r3/')
  })

const head = git('rev-parse', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const r2Gates = existsSync(join(ROOT, 'eval/r2/out/gate-status.json'))
  ? readJson(join(ROOT, 'eval/r2/out/gate-status.json'))
  : null
const pr = tryJson('gh', ['pr', 'view', '5', '--json', 'number,state,mergeable,headRefOid,baseRefName,headRefName,url'])
const runs = tryJson('gh', ['run', 'list', '--branch', branch, '--limit', '5', '--json', 'databaseId,headSha,status,conclusion,workflowName,createdAt'])

const immutable = IMMUTABLE.map(path => {
  const absolute = join(ROOT, path)
  return {
    path,
    present: existsSync(absolute),
    sha256: existsSync(absolute) ? sha256(absolute) : null,
    immutable: true,
  }
})

const output = {
  schemaVersion: 1,
  work: 'EF-R3 WP0',
  generatedAt: new Date().toISOString(),
  git: {
    worktree: ROOT,
    head,
    branch,
    headSubject: git('log', '-1', '--format=%s'),
    dirtyPaths: dirty,
    worktreeClean: dirty.length === 0,
  },
  pullRequest: pr,
  ci: runs,
  r2: r2Gates === null ? null : {
    counts: r2Gates.counts,
    gates: r2Gates.gates,
    generatedAt: r2Gates.generatedAt,
    note: 'R2-G9 is incomplete by design; the confirm stopped on local route transport failures.',
  },
  immutable,
  immutableMissing: immutable.filter(entry => !entry.present).map(entry => entry.path),
  note: 'The R2 artifacts below are read-only inputs for R3. A missing file is reported, never inferred. The worktree check excludes ignored run output and the in-progress eval/r3 directory.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'baseline-r3.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`baseline: ${head.slice(0, 8)} on ${branch}; worktreeClean=${output.git.worktreeClean}; immutable ${immutable.length - output.immutableMissing.length}/${immutable.length}\n`)
if (output.immutableMissing.length > 0) {
  process.stdout.write(`missing: ${output.immutableMissing.join(', ')}\n`)
  process.exit(1)
}
