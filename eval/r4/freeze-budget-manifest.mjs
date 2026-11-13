#!/usr/bin/env node
/**
 * EF-R4 — freeze the runnable 36-cell budget-sensitivity manifest.
 *
 * The design file (`budget-sensitivity-design.json`) is the scientific plan.
 * This file turns it into the exact manifest shape the runner reads, plus an
 * authorization record that is deliberately NOT granted. `executionAuthorized`
 * stays false; a new explicit grant must set `granted:true` and bind the
 * manifest SHA and the envelope.
 *
 *   node eval/r4/freeze-budget-manifest.mjs
 *
 * Zero provider calls.
 *
 * @module eval/r4/freeze-budget-manifest
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'

const DESIGN_PATH = join(ROOT, 'eval', 'r4', 'out', 'budget-sensitivity-design.json')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(ROOT, 'eval', 'r4', 'out')
const SOURCE_CAMPAIGN = 'e2e-r3-product-pilot-1'
const CAMPAIGN = 'e2e-r4-budget-sensitivity-1'
const ARMS = ['B0', 'E0', 'E1']
const TASKS = ['T11-p1', 'T12-p1', 'T13-p1', 'T14-p1', 'T15-p1', 'T16-p1']

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sha256Text = text => createHash('sha256').update(text, 'utf8').digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trimEnd()

function sourceTreeDigest() {
  const lines = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => {
    const path = line.slice(line.indexOf('\t') + 1)
    return path !== 'eval/e2e/authorization.json'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/r3/out/')
      && !path.startsWith('eval/r4/out/')
  })
  return sha256Text(lines.join('\n'))
}

function dirtyPaths() {
  return git('status', '--porcelain')
    .split('\n')
    .map(line => line.replace(/\r$/u, ''))
    .filter(Boolean)
    .map(line => line.slice(3))
    .filter(path => path !== 'ef-phase7-logs/watchdog.heartbeat'
      && !path.startsWith('eval/e2e/out/')
      && !path.startsWith('eval/e2e/runs/')
      && !path.startsWith('eval/r3/out/')
      && !path.startsWith('eval/r4/out/'))
}

function main() {
  if (!existsSync(DESIGN_PATH)) {
    process.stderr.write(`freeze-budget-manifest: ${DESIGN_PATH} is missing; run freeze-budget-sensitivity.mjs first\n`)
    process.exit(2)
  }
  const design = readJson(DESIGN_PATH)
  const sourceManifestPath = join(E2E_OUT, `manifest-${SOURCE_CAMPAIGN}.json`)
  if (!existsSync(sourceManifestPath)) {
    process.stderr.write(`freeze-budget-manifest: ${sourceManifestPath} is missing\n`)
    process.exit(2)
  }
  const sourceManifest = readJson(sourceManifestPath)
  const tasks = TASKS.map(id => {
    const entry = (sourceManifest.tasks ?? []).find(task => task.id === id)
    const path = join(ROOT, 'eval', 'e2e', 'tasks-r3', `${id}.json`)
    if (entry === undefined || !existsSync(path)) {
      process.stderr.write(`freeze-budget-manifest: task ${id} is missing or not in the source manifest\n`)
      process.exit(2)
    }
    return {
      id: entry.id,
      template: entry.template,
      seed: entry.seed,
      category: entry.category,
      file: entry.file,
      digest: entry.digest,
      operationalBudgetTokens: entry.operationalBudgetTokens,
      thresholdRatio: entry.thresholdRatio,
    }
  })

  const cells = design.cells.map(cell => ({
    block: cell.block,
    task: cell.task,
    arm: cell.arm,
    replicate: cell.replicate,
    maxSteps: cell.maxSteps,
    maxStepsSource: 'cell',
  }))
  const combos = new Set(cells.map(cell => `${cell.task}:${cell.arm}:${cell.maxSteps}`))
  const blockBalanced = [...new Set(cells.map(cell => cell.block))].every(block => {
    const subset = cells.filter(cell => cell.block === block)
    const arms = ARMS.map(arm => subset.filter(cell => cell.arm === arm).length)
    const budgets = [8, 16].map(budget => subset.filter(cell => cell.maxSteps === budget).length)
    return subset.length === 6 && arms.every(count => count === 2) && budgets.every(count => count === 3)
  })
  if (cells.length !== 36 || combos.size !== 36 || !blockBalanced) {
    process.stderr.write(`freeze-budget-manifest: invalid design cells=${cells.length} unique=${combos.size} balanced=${blockBalanced}\n`)
    process.exit(1)
  }

  const perCell = {
    requests: design.budgetEstimate.perCell.requests,
    inputTokens: design.budgetEstimate.perCell.inputTokens,
    outputTokens: design.budgetEstimate.perCell.outputTokens,
    wallClockMs: design.budgetEstimate.perCell.wallClockMs,
  }
  const limits = {
    continuationCells: cells.length,
    httpAttempts: perCell.requests * cells.length,
    inputTokens: perCell.inputTokens * cells.length,
    outputTokens: perCell.outputTokens * cells.length,
    wallClockMs: perCell.wallClockMs * cells.length,
    paidConcurrency: 2,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded.',
  }
  const dirty = dirtyPaths()
  const manifest = {
    schemaVersion: 1,
    campaign: CAMPAIGN,
    frozenAt: new Date().toISOString(),
    work: 'EF-R4 step-budget sensitivity',
    status: 'manifest-frozen',
    executionAuthorized: false,
    authorizationState: 'not-requested',
    code: {
      evaluatedCommit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      worktreeClean: dirty.length === 0,
      sourceTreeDigest: sourceTreeDigest(),
      note: 'The manifest and its authorization are generated artifacts under eval/e2e/out and eval/r4/out; they are excluded from the source digest.',
    },
    model: sourceManifest.model,
    route: {
      origin: 'resolved-at-run',
      note: 'A representative transport health probe must pass before execution. No route is resolved by the freeze.',
    },
    arms: sourceManifest.arms,
    config: {
      ...sourceManifest.config,
      maxSteps: 8,
      note: 'Copied from the R3 product pilot. Each cell overrides maxSteps; the effective value is written into every report.',
    },
    tasks,
    cells,
    perCell,
    limits,
    limitsAreProposed: true,
    authorizationEnvelope: 'r4-budget-sensitivity',
    prerequisites: {
      scoringSeparation: { gate: 'R4-G1', status: 'pass' },
      evidenceLifecycle: { gate: 'R4-G2', status: 'pass' },
      taskContinuity: { gate: 'R4-G3', status: 'pass' },
      workingSet: { gate: 'R4-G4', status: 'pass' },
      candidateContract: { gate: 'R4-G5', status: 'pass' },
      transportHealthProbe: {
        status: 'required-before-execution',
        note: 'A new probe must pass on the live route. The R3 probe p95 exceeded its bound and is not a grant for R4.',
      },
      liveAuthorization: {
        status: 'not-granted',
        note: 'A new explicit user authorization must bind this manifest SHA and the envelope.',
      },
    },
    stopConditions: [
      'transport failure or reset',
      'unknown provider usage (strictUsage)',
      'budget exhausted',
      'provider failure that invalidates the route',
    ],
    mechanism: {
      taskOutcome: 'task checks only; correct / incorrect / incomplete',
      exposure: 'manifested, committed, delivered, requiredFoldCountMet',
      requirement: 'T16-p1 requires minCompactions:2; it is a mechanism result, not a task pass condition',
    },
    comparability: 'The R3 8-step cells are not reused as strict pairs. This campaign has its own 8-step cells and interleaves 8 and 16.',
    workloadFamilies: design.workloadFamilies,
    note: 'No provider call was made. executionAuthorized=false. The authorization file below is a template with granted=false.',
  }

  mkdirSync(E2E_OUT, { recursive: true })
  const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const manifestSha = sha256File(manifestPath)

  const authorization = {
    schemaVersion: 1,
    campaign: CAMPAIGN,
    manifest: `eval/e2e/out/manifest-${CAMPAIGN}.json`,
    manifestSha256: manifestSha,
    granted: false,
    requestedAt: new Date().toISOString(),
    requestedBy: 'EF-R4 offline freeze',
    grantedAt: null,
    grantedBy: null,
    basis: null,
    limits,
    perCell,
    stopConditions: manifest.stopConditions,
    grantInstruction: 'A new explicit user authorization must set granted=true, fill grantedAt/grantedBy/basis, and keep this manifestSha256 and the envelope. The runner refuses a manifest without a granted authorization.',
    note: 'This is a request envelope, not a grant.',
  }
  const authorizationPath = join(E2E_OUT, `authorization-${CAMPAIGN}.json`)
  writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')

  const pointer = {
    schemaVersion: 1,
    work: 'EF-R4 budget-sensitivity manifest pointer',
    generatedAt: new Date().toISOString(),
    campaign: CAMPAIGN,
    design: { path: 'eval/r4/out/budget-sensitivity-design.json', sha256: sha256File(DESIGN_PATH) },
    manifest: {
      path: `eval/e2e/out/manifest-${CAMPAIGN}.json`,
      sha256: manifestSha,
      cells: cells.length,
      executionAuthorized: false,
    },
    authorization: {
      path: `eval/e2e/out/authorization-${CAMPAIGN}.json`,
      sha256: sha256File(authorizationPath),
      granted: false,
    },
    config: manifest.config,
    perCell,
    limits,
    preflight: null,
    note: 'Ready for a zero-provider preflight. Not ready to execute: the authorization is not granted.',
  }
  const pointerPath = join(OUT, 'budget-manifest.json')
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# EF-R4 — budget-sensitivity manifest')
  md.push('')
  md.push('**Manifest frozen; execution not authorized.** No provider call was made.')
  md.push('')
  md.push(`- Campaign: \`${CAMPAIGN}\``)
  md.push(`- Manifest: \`eval/e2e/out/manifest-${CAMPAIGN}.json\``)
  md.push(`- Manifest SHA-256: \`${manifestSha}\``)
  md.push(`- Authorization: \`eval/e2e/out/authorization-${CAMPAIGN}.json\` (granted: **false**)`)
  md.push(`- Cells: ${cells.length}; unique task×arm×budget: ${combos.size}; balanced blocks: ${blockBalanced}`)
  md.push(`- Envelope: ${JSON.stringify(limits)}`)
  md.push('')
  md.push('A new explicit grant must set `granted:true` in the authorization and keep the manifest SHA. The runner refuses the campaign otherwise.')
  md.push('')
  const mdPath = join(OUT, 'budget-manifest.md')
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`budget manifest: ${cells.length} cells; sha ${manifestSha.slice(0, 12)}…; executedAuthorized=false\n`)
  process.stdout.write(`  ${manifestPath}\n  ${authorizationPath} (granted=false)\n  ${pointerPath}\n`)
  process.stdout.write(`  worktreeClean=${manifest.code.worktreeClean}; commit=${manifest.code.evaluatedCommit.slice(0, 8)}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('freeze-budget-manifest.mjs')) main()
