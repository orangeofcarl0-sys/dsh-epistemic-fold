#!/usr/bin/env node
/**
 * EF-R2 — derive a pilot or confirm manifest from the frozen 72-cell design.
 *
 * The design manifest is the pre-registration. A stage manifest is a SUBSET
 * with its own campaign, limits and authorization hash. The pilot cannot spend
 * the confirm budget, and the confirm cannot silently reuse the pilot grant.
 *
 *   node eval/r2/freeze-stage.mjs --stage pilot
 *   node eval/r2/freeze-stage.mjs --stage confirm
 *
 * @module eval/r2/freeze-stage
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

const argv = process.argv.slice(2)
const value = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const stage = value('stage') ?? (argv.includes('--pilot') ? 'pilot' : argv.includes('--confirm') ? 'confirm' : undefined)
if (stage !== 'pilot' && stage !== 'confirm') {
  process.stderr.write('freeze-stage: --stage pilot|confirm is required\n')
  process.exit(2)
}

const designPath = join(E2E_OUT, 'manifest-e2e-r2-live-1.json')
if (!existsSync(designPath)) {
  process.stderr.write(`freeze-stage: ${designPath} is missing; run eval/r2/freeze-live.mjs first\n`)
  process.exit(2)
}
const design = JSON.parse(readFileSync(designPath, 'utf8'))
const designSha = createHash('sha256').update(readFileSync(designPath)).digest('hex')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sha256Text = text => createHash('sha256').update(text, 'utf8').digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

/** The same tree digest `run.mjs` verifies, over HEAD minus the evidence dirs. */
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

const seedOne = new Set(design.tasks.filter(task => task.seed === 1).map(task => task.id))
const isPilotCell = cell => seedOne.has(cell.task) && cell.replicate === 1
const cells = stage === 'pilot'
  ? design.cells.filter(isPilotCell)
  : design.cells.filter(cell => !isPilotCell(cell))
const taskIds = new Set(cells.map(cell => cell.task))
const tasks = design.tasks.filter(task => taskIds.has(task.id))

const campaign = stage === 'pilot' ? 'e2e-r2-pilot-1' : 'e2e-r2-confirm-1'
const envelopeName = stage === 'pilot' ? 'r2-live-pilot' : 'r2-live'
const limits = stage === 'pilot'
  ? {
    continuationCells: 18,
    httpAttempts: 600,
    inputTokens: 5_000_000,
    outputTokens: 400_000,
    wallClockMs: 2 * 60 * 60 * 1000,
    paidConcurrency: 2,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded.',
  }
  : {
    continuationCells: 54,
    httpAttempts: 2_000,
    inputTokens: 20_000_000,
    outputTokens: 1_500_000,
    wallClockMs: 6 * 60 * 60 * 1000,
    paidConcurrency: 2,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded.',
  }

const manifest = {
  ...design,
  campaign,
  code: {
    evaluatedCommit: git('rev-parse', 'HEAD').trim(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
    worktreeClean: dirty.length === 0,
    sourceTreeDigest: sourceTreeDigest(),
  },
  frozenAt: new Date().toISOString(),
  status: 'stage-frozen',
  executionAuthorized: false,
  authorizationState: 'requested',
  derivedFrom: {
    design: `eval/e2e/out/manifest-e2e-r2-live-1.json`,
    sha256: designSha,
    designCells: design.cells.length,
    stage,
  },
  arms: design.arms,
  config: design.config,
  tasks,
  cells,
  limits,
  authorizationEnvelope: envelopeName,
  note: stage === 'pilot'
    ? 'Pilot subset: six seed-1 instances x B0/E0/E1 x one replicate. It verifies feasibility, not effect.'
    : 'Confirm subset: the remaining 54 cells. It is not authorized by the pilot grant.',
}
const manifestPath = join(E2E_OUT, `manifest-${campaign}.json`)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const stageDoc = {
  schemaVersion: 1,
  work: 'EF-R2 WP6',
  generatedAt: new Date().toISOString(),
  stage,
  campaign,
  envelopeName,
  manifest: {
    path: `eval/e2e/out/manifest-${campaign}.json`,
    sha256: sha256(manifestPath),
    cells: cells.length,
    tasks: tasks.length,
  },
  derivedFrom: manifest.derivedFrom,
  limits,
  config: design.config,
  executionAuthorized: false,
  authorizationState: 'requested',
  note: 'A stage manifest is a subset of the frozen design. The authorization is a separate grant bound to this hash.',
}
// The stage doc sits under the evidence directory the runner excludes from
// its dirty/source checks; the manifest itself is the frozen artifact.
mkdirSync(E2E_OUT, { recursive: true })
writeFileSync(join(E2E_OUT, `live-stage-${stage}.json`), `${JSON.stringify(stageDoc, null, 2)}\n`, 'utf8')

process.stdout.write(`stage ${stage}: ${cells.length} cells, ${tasks.length} tasks, ${campaign}, envelope ${envelopeName}\n`)
process.stdout.write(`manifest ${manifestPath} sha256 ${stageDoc.manifest.sha256.slice(0, 16)} executionAuthorized=${manifest.executionAuthorized}\n`)
