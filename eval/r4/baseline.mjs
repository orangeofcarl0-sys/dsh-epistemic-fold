#!/usr/bin/env node
/**
 * EF-R4 WP0 — freeze the hand-off point and the immutable R3 evidence.
 *
 * R4 is a measurement stage. It must not rewrite a single R3 result, report or
 * raw trace. This file records the commit, the clean/dirty split, the PR/CI
 * identity, the R4 score-contract version and the SHA-256 of every R3 artifact
 * that the R4 analyses read.
 *
 *   node eval/r4/baseline.mjs
 *
 * The script is read-only: it never writes into eval/r3 or eval/e2e.
 *
 * @module eval/r4/baseline
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-r3-product-pilot-1'

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

/**
 * A commit tree hash identifies the committed source exactly. It is cheaper and
 * less ambiguous than re-hashing thousands of files, and the dirty path list
 * below says whether the working tree still matches it.
 */
const tree = git('rev-parse', 'HEAD^{tree}')

const pilotManifestPath = join(ROOT, 'eval', 'e2e', 'out', `manifest-${CAMPAIGN}.json`)
const pilotManifest = existsSync(pilotManifestPath) ? readJson(pilotManifestPath) : null
const pilotCells = pilotManifest === null
  ? []
  : pilotManifest.cells.map(cell => `${cell.task}-${cell.arm}-r${cell.replicate}`)

const IMMUTABLE = [
  `eval/e2e/out/manifest-${CAMPAIGN}.json`,
  `eval/e2e/out/results-${CAMPAIGN}.json`,
  `eval/e2e/out/authorization-${CAMPAIGN}.json`,
  'eval/r3/out/gate-status.json',
  'eval/r3/out/product-pilot-gate-status.json',
  'eval/r3/out/product-pilot-analysis.json',
  'eval/r3/out/product-pilot-trajectory-analysis.json',
  'eval/r3/out/product-pilot-design.json',
  'eval/r3/out/product-pilot-prerequisites.json',
  'eval/r3/out/health-probe-results.json',
  'eval/r3/out/cost-preflight.json',
  'eval/r3/out/cell-ledger.json',
  'eval/r3/out/attempt-ledger.json',
  'eval/r3/out/live-confirm-reconciliation.json',
  'docs/convergence/EF_R3.md',
  'docs/convergence/EF_R3_PILOT_TRAJECTORY.md',
  ...pilotCells.map(cellId => `eval/e2e/runs/${CAMPAIGN}/${cellId}/report.json`),
  ...pilotCells.map(cellId => `eval/e2e/runs/${CAMPAIGN}/${cellId}/raw/witness.json`),
  ...pilotCells.map(cellId => `eval/e2e/runs/${CAMPAIGN}/${cellId}/raw/messages.json`),
]

const dirty = git('status', '--porcelain')
  .split('\n')
  .map(line => line.replace(/\r$/u, ''))
  .filter(Boolean)
  .filter(line => {
    const path = line.slice(3)
    return path.length > 0
      && path !== 'ef-phase7-logs/watchdog.heartbeat'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/e2e/runs/')
      && !path.startsWith('eval/r4/')
  })

const head = git('rev-parse', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const pr = tryJson('gh', ['pr', 'view', '5', '--json', 'number,state,mergeable,headRefOid,baseRefName,headRefName,url'])
const runs = tryJson('gh', ['run', 'list', '--branch', branch, '--limit', '5', '--json', 'databaseId,headSha,status,conclusion,workflowName,createdAt'])

const immutable = [...new Set(IMMUTABLE)].map(path => {
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
  work: 'EF-R4 WP0',
  generatedAt: new Date().toISOString(),
  git: {
    worktree: ROOT,
    head,
    headShort: head.slice(0, 8),
    branch,
    headSubject: git('log', '-1', '--format=%s'),
    tree,
    sourceTreeDigest: tree,
    dirtyPaths: dirty,
    worktreeClean: dirty.length === 0,
    note: 'dirtyPaths excludes ignored run output and the in-progress eval/r4 directory.',
  },
  pullRequest: pr,
  ci: runs,
  scorerVersions: {
    historical: 'r3-benchmark-v1',
    rescored: 'r4-scoring-v1',
    note: 'The historical score is the value recorded by R3. The rescored value separates task checks from mechanism exposure; neither replaces the other.',
  },
  r3: {
    campaign: CAMPAIGN,
    manifestSha256: existsSync(pilotManifestPath) ? sha256(pilotManifestPath) : null,
    cells: pilotCells,
    cellCount: pilotCells.length,
    gates: existsSync(join(ROOT, 'eval/r3/out/gate-status.json'))
      ? readJson(join(ROOT, 'eval/r3/out/gate-status.json')).counts
      : null,
    pilotGates: existsSync(join(ROOT, 'eval/r3/out/product-pilot-gate-status.json'))
      ? readJson(join(ROOT, 'eval/r3/out/product-pilot-gate-status.json')).counts
      : null,
  },
  immutable,
  immutableMissing: immutable.filter(entry => !entry.present).map(entry => entry.path),
  rwPolicy: 'read-only',
  note: 'Every path below is an R3 input. R4 writes only under eval/r4/out. A missing file is reported, never inferred.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'baseline-r4.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`baseline: ${head.slice(0, 8)} on ${branch}; worktreeClean=${output.git.worktreeClean}; immutable ${immutable.length - output.immutableMissing.length}/${immutable.length}\n`)
if (output.immutableMissing.length > 0) {
  process.stdout.write(`missing: ${output.immutableMissing.join(', ')}\n`)
  process.exit(1)
}
