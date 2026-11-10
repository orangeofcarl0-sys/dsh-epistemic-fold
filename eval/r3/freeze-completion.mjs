#!/usr/bin/env node
/**
 * EF-R3 WP7 — freeze the confirm-completion DESIGN, not a run.
 *
 * The original 54-cell confirm has 23 valid cells, 1 unresolved cell and 30
 * never-started cells. This script builds a new manifest for the 31 missing
 * identities, interleaves the execution order so another stop cannot erase an
 * entire template, and pins the EFFECTIVE R2 treatment (hint 400, not the
 * manifest's unforwarded 800). Changing the treatment would make the new cells
 * incomparable with the 23 valid ones.
 *
 * `executionAuthorized` is false. Running this needs a new explicit grant bound
 * to the new manifest SHA and a passing representative transport health probe.
 *
 *   node eval/r3/freeze-completion.mjs
 *
 * @module eval/r3/freeze-completion
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

const confirmManifestPath = join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json')
const ledgerPath = join(OUT, 'cell-ledger.json')
const healthProbePath = join(OUT, 'transport-health-probe.json')
for (const path of [confirmManifestPath, ledgerPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`freeze-completion: ${path} is missing\n`)
    process.exit(2)
  }
}
const confirmManifest = readJson(confirmManifestPath)
const ledger = readJson(ledgerPath)
const healthProbe = existsSync(healthProbePath) ? readJson(healthProbePath) : null

const missing = ledger.confirm.cells.filter(cell => cell.status !== 'valid')
const unresolved = missing.filter(cell => cell.status === 'unresolved')
const neverStarted = missing.filter(cell => cell.status === 'never-started')
if (missing.length !== 31 || unresolved.length !== 1 || neverStarted.length !== 30) {
  process.stderr.write(`freeze-completion: expected 31 missing (1 unresolved + 30 never-started), got ${missing.length}/${unresolved.length}/${neverStarted.length}\n`)
  process.exit(1)
}

const missingKeys = new Set(missing.map(cell => cell.cellId))
const originalOrder = confirmManifest.cells
  .filter(cell => missingKeys.has(`${cell.task}-${cell.arm}-r${cell.replicate}`))
  .map(cell => ({
    ...cell,
    origin: { campaign: 'e2e-r2-confirm-merged', cellId: `${cell.task}-${cell.arm}-r${cell.replicate}` },
  }))

function interleave(cells) {
  const byTemplate = new Map()
  for (const cell of cells) {
    const template = cell.task.replace(/-s\d+$/u, '')
    if (!byTemplate.has(template)) byTemplate.set(template, [])
    byTemplate.get(template).push(cell)
  }
  const queues = [...byTemplate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, list]) => list)
  const order = []
  while (queues.some(queue => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift()
      if (next !== undefined) order.push(next)
    }
  }
  return order
}

const executionOrder = interleave(originalOrder).map((cell, index) => ({
  ...cell,
  block: 'r3-completion',
  executionIndex: index,
  originalIndex: originalOrder.findIndex(original => original.task === cell.task
    && original.arm === cell.arm
    && original.replicate === cell.replicate),
}))

const missingTemplates = [...new Set(missing.map(cell => cell.task.replace(/-s\d+$/u, '')))].sort()
const tasks = confirmManifest.tasks.filter(task => missingTemplates.includes(task.template))

// Comparability pin: the R2 effective E1 hint was 400 because host.mjs did not
// forward the manifest's 800. A completion that changes it is a different
// treatment and cannot be merged with the 23 valid cells.
const pinnedConfig = {
  leafAdmission: 'economic',
  rootPolicy: 'economics',
  framingMode: 'legacy',
  semanticContinuity: 'off',
  rationaleHintTokens: 400,
  thresholdRatio: 0.5,
  operationalBudgetTokens: 16_384,
  maxSteps: 8,
  retainRatio: 0.04,
  headroomTokens: 512,
  maxTokens: 1_024,
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
      && !path.startsWith('eval/r3/')
  })

function sourceTreeDigest() {
  const lines = git('ls-tree', '-r', 'HEAD').split('\n').filter(line => {
    const path = line.slice(line.indexOf('\t') + 1)
    return path !== 'eval/e2e/authorization.json' && !path.startsWith('eval/e2e/out/')
  })
  return sha256Text(lines.join('\n'))
}

const campaign = 'e2e-r3-confirm-completion-1'
const limits = {
  continuationCells: executionOrder.length,
  httpAttempts: 900,
  inputTokens: 10_000_000,
  outputTokens: 800_000,
  wallClockMs: 4 * 60 * 60 * 1000,
  paidConcurrency: 2,
  monetaryUsd: null,
  monetaryNote: 'No verifiable per-token price is recorded.',
}
const manifest = {
  schemaVersion: 1,
  campaign,
  frozenAt: new Date().toISOString(),
  work: 'EF-R3 WP7',
  status: 'completion-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  code: {
    evaluatedCommit: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: dirty.length === 0,
    sourceTreeDigest: sourceTreeDigest(),
  },
  model: 'deepseek-v4.1-flash',
  route: {
    origin: 'resolved-at-run',
    note: 'Route qualification is a prerequisite: the representative transport health probe must pass before this manifest can run.',
  },
  arms: confirmManifest.arms,
  config: pinnedConfig,
  configProvenance: {
    source: 'R2 effective host config, not the R2 declared config',
    declaredRationaleHintTokens: confirmManifest.config.rationaleHintTokens,
    effectiveRationaleHintTokens: pinnedConfig.rationaleHintTokens,
    reason: 'eval/e2e/src/host.mjs did not forward rationaleHintTokens; every R2 E1 cell ran the economy preset value 400. The completion must match the 23 valid cells or it is a new treatment.',
  },
  r2Difference: 'The original confirm ran with leafAdmission economic for E0/E1 and legacy framing. This completion keeps those effective values and pins the hint to 400. It is a protocol amendment of ORDER and CONFIG DECLARATION only; the effective treatment matches the valid R2 cells.',
  design: {
    missingCells: missing.length,
    unresolvedCells: unresolved.map(cell => cell.cellId),
    neverStartedCells: neverStarted.length,
    templates: missingTemplates,
    originalOrder: originalOrder.map(cell => `${cell.task}-${cell.arm}-r${cell.replicate}`),
    executionOrder: executionOrder.map(cell => `${cell.task}-${cell.arm}-r${cell.replicate}`),
    protocolAmendment: {
      changed: 'execution order',
      reason: 'The original order put T14-T16 behind T13; a third transport stop would leave whole templates without data. The interleaved order rotates one cell from each missing template.',
      effectiveConfigChanged: false,
    },
  },
  tasks,
  cells: executionOrder,
  perCell: confirmManifest.perCell,
  limits,
  authorizationEnvelope: 'r3-confirm-completion (proposed, not granted)',
  prerequisites: {
    transportHealthProbe: healthProbe === null ? null : {
      path: 'eval/r3/out/transport-health-probe.json',
      sha256: sha256(healthProbePath),
      executionAuthorized: healthProbe.executionAuthorized,
      status: healthProbe.status,
    },
    configPreflight: 'node eval/r3/config-preflight.mjs --manifest eval/e2e/out/manifest-e2e-r3-confirm-completion-1.json --forwarded',
  },
  derivedFrom: {
    confirmManifest: { path: 'eval/e2e/out/manifest-e2e-r2-confirm-1.json', sha256: sha256(confirmManifestPath) },
    cellLedger: { path: 'eval/r3/out/cell-ledger.json', sha256: sha256(ledgerPath) },
    transportHealthProbe: existsSync(healthProbePath) ? { path: 'eval/r3/out/transport-health-probe.json', sha256: sha256(healthProbePath) } : null,
  },
  note: 'This manifest freezes the completion design and nothing else. It is not runnable without a new grant bound to its SHA-256 and a passing health probe.',
}

mkdirSync(E2E_OUT, { recursive: true })
const manifestPath = join(E2E_OUT, `manifest-${campaign}.json`)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const manifestSha = sha256(manifestPath)

const design = {
  schemaVersion: 1,
  work: 'EF-R3 WP7',
  generatedAt: new Date().toISOString(),
  stage: 'confirm-completion',
  campaign,
  status: 'completion-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  manifest: { path: `eval/e2e/out/manifest-${campaign}.json`, sha256: manifestSha, cells: executionOrder.length },
  counts: {
    original: 54,
    valid: 23,
    unresolved: unresolved.length,
    neverStarted: neverStarted.length,
    completionCells: executionOrder.length,
    missingByTemplate: Object.fromEntries(missingTemplates.map(template => [
      template,
      missing.filter(cell => cell.task.startsWith(`${template}-`)).length,
    ])),
  },
  pinnedConfig,
  declaredRationaleHintTokens: confirmManifest.config.rationaleHintTokens,
  comparability: 'The effective config matches the 23 valid R2 cells. A 800-hint or shipped-preset run is a different campaign; it cannot be merged with the 23 valid cells.',
  routeQualification: 'The transport health probe must pass under a new grant before this manifest can run.',
  envelope: limits,
  note: 'No live call was made. A new explicit authorization is required; unused R2 envelope capacity is not permission.',
}
const designPath = join(OUT, 'completion-design-r3.json')
writeFileSync(designPath, `${JSON.stringify(design, null, 2)}\n`, 'utf8')

const memo = []
memo.push('# EF-R3 — confirm completion decision memo')
memo.push('')
memo.push('## Current state')
memo.push('')
memo.push(`- 54 planned, **23 valid**, **1 unresolved** (\`${unresolved.map(cell => cell.cellId).join('`, `')}\`), **30 never-started**.`)
memo.push(`- Missing by template: \`${JSON.stringify(design.counts.missingByTemplate)}\`.`)
memo.push('- T14-T16 have no valid cells. The 23-cell subset is task-type biased.')
memo.push('')
memo.push('## Completion is conditional')
memo.push('')
memo.push('1. A representative transport health probe must pass (long B0 summary/primary payloads, not a short hello).')
memo.push('2. A new explicit authorization must name the new manifest SHA-256 and envelope.')
memo.push('3. The completion pins the **effective R2 config**: hint 400, legacy framing, retain 0.04, 16k. This keeps it comparable with the 23 valid cells.')
memo.push('4. The execution order is interleaved across T13-T16 so another stop cannot erase an entire template.')
memo.push('5. Any transport failure stops the run; the failed attempt is marked transport-failed, not an arm outcome. No automatic retry.')
memo.push('')
memo.push('## The alternative is a new campaign, not a merge')
memo.push('')
memo.push('If the intended 800 hint or the shipped product preset is wanted, that is a different treatment. It must be a new, explicitly labelled campaign and must not be pooled with the 23 valid R2 cells.')
memo.push('')
memo.push('## Termination is a valid outcome')
memo.push('')
memo.push('If the health probe fails or the route cannot be qualified, the correct decision is to keep the confirm partial, record that the completion could not be run, and stop consuming. Repeated retries are not a completion strategy.')
memo.push('')
memo.push(`Manifest: \`eval/e2e/out/manifest-${campaign}.json\` (SHA-256 \`${manifestSha}\`), executionAuthorized=false.`)
memo.push('')
const memoPath = join(OUT, 'live-decision-memo.md')
writeFileSync(memoPath, `${memo.join('\n')}\n`, 'utf8')

process.stdout.write(`completion design: ${executionOrder.length} cells (${unresolved.length} unresolved + ${neverStarted.length} never-started), ${tasks.length} tasks\n`)
process.stdout.write(`  pinned hint ${pinnedConfig.rationaleHintTokens} (R2 declared ${confirmManifest.config.rationaleHintTokens})\n`)
process.stdout.write(`  order: ${executionOrder.slice(0, 8).map(cell => `${cell.task}-${cell.arm}-r${cell.replicate}`).join(', ')} …\n`)
process.stdout.write(`  manifest ${manifestPath} sha256 ${manifestSha.slice(0, 16)} executionAuthorized=${manifest.executionAuthorized}\n`)
process.stdout.write(`wrote ${designPath}, ${memoPath}\n`)
