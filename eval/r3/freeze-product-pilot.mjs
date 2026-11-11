#!/usr/bin/env node
/**
 * EF-R3 product-lane — freeze the 18-cell pilot and its authorization.
 *
 * The pilot uses six audited tasks (one per template) at 32,768 tokens:
 * B0 native Basic, E0 EF minimal, E1 the shipped economy preset. It is a
 * feasibility/quality/cost pilot, not a confirmatory campaign.
 *
 * The manifest is written with executionAuthorized=false; the grant is the
 * separate authorization file, bound to the manifest SHA-256. The user's
 * instruction "按推荐执行，均授权" is the basis; the limits below are the
 * envelope.
 *
 *   node eval/r3/freeze-product-pilot.mjs
 *
 * @module eval/r3/freeze-product-pilot
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

const TASK_IDS = ['T11-p1', 'T12-p1', 'T13-p1', 'T14-p1', 'T15-p1', 'T16-p1']
const ARMS = ['B0', 'E0', 'E1']
const REPLICATE = 1
const CAMPAIGN = 'e2e-r3-product-pilot-1'

const tasks = TASK_IDS.map(id => {
  const path = join(ROOT, 'eval', 'e2e', 'tasks-r3', `${id}.json`)
  if (!existsSync(path)) {
    process.stderr.write(`freeze-product-pilot: task ${id} is missing; run eval/r3/generate-product-tasks.mjs\n`)
    process.exit(2)
  }
  const task = readJson(path)
  return {
    id: task.id,
    template: task.template,
    seed: task.seed,
    category: task.category,
    file: `eval/e2e/tasks-r3/${id}.json`,
    digest: sha256(path),
    operationalBudgetTokens: task.operationalBudgetTokens,
    thresholdRatio: task.thresholdRatio,
  }
})

const cells = []
for (const task of tasks) {
  for (const arm of ARMS) {
    cells.push({ block: 'r3-product-pilot', task: task.id, arm, replicate: REPLICATE })
  }
}

const config = {
  leafAdmission: 'economic',
  rootPolicy: 'economics',
  framingMode: 'system-dedup',
  semanticContinuity: 'off',
  rationaleHintTokens: 400,
  thresholdRatio: 0.5,
  operationalBudgetTokens: 32_768,
  maxSteps: 8,
  retainRatio: 0.16,
  headroomTokens: 512,
  maxTokens: 1_024,
  strictUsage: true,
  basic: {
    // Leave DSH Basic's own retention in place: B0 is the native baseline.
    retainRatio: null,
    headroomTokens: 512,
    maxTokens: 1_024,
  },
}

const limits = {
  continuationCells: cells.length,
  httpAttempts: 600,
  inputTokens: 6_000_000,
  outputTokens: 500_000,
  wallClockMs: 3 * 60 * 60 * 1000,
  paidConcurrency: 2,
  monetaryUsd: null,
  monetaryNote: 'No verifiable per-token price is recorded.',
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

const auditPath = join(OUT, 'product-lane-exposure-audit.json')
const candidatePath = join(OUT, 'admission-candidate.json')
const costPath = join(OUT, 'cost-preflight.json')
const audit = existsSync(auditPath) ? readJson(auditPath) : null
const candidate = existsSync(candidatePath) ? readJson(candidatePath) : null
const cost = existsSync(costPath) ? readJson(costPath) : null

const manifest = {
  schemaVersion: 1,
  campaign: CAMPAIGN,
  frozenAt: new Date().toISOString(),
  work: 'EF-R3 product-lane pilot',
  status: 'pilot-frozen',
  executionAuthorized: false,
  authorizationState: 'granted-by-user-instruction',
  code: {
    evaluatedCommit: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: dirty.length === 0,
    sourceTreeDigest: sourceTreeDigest(),
  },
  model: 'deepseek-v4.1-flash',
  route: {
    origin: 'resolved-at-run',
    note: 'Resolve the live route at execution time. The representative health probe must pass first.',
  },
  arms: {
    B0: 'native DSH Basic; native retention, threshold 0.5, maxTokens 1024',
    E0: 'EF minimal, semanticMode none, shipped economy values (system-dedup, retain 0.16)',
    E1: 'shipped economy preset: semanticMode rationale, hint 400, system-dedup, retain 0.16',
  },
  config,
  tasks,
  cells,
  perCell: {
    requests: 24,
    inputTokens: 300_000,
    outputTokens: 30_000,
    wallClockMs: 600_000,
  },
  limits,
  authorizationEnvelope: 'r3-product-pilot',
  prerequisites: {
    transportHealthProbe: existsSync(join(OUT, 'transport-health-probe.json'))
      ? { path: 'eval/r3/out/transport-health-probe.json', sha256: sha256(join(OUT, 'transport-health-probe.json')) }
      : null,
    exposureAudit: audit === null ? null : {
      path: 'eval/r3/out/product-lane-exposure-audit.json',
      sha256: sha256(auditPath),
      suitableTasks: audit.suitableTaskIds,
    },
    admissionCandidate: candidate === null ? null : {
      path: 'eval/r3/out/admission-candidate.json',
      sha256: sha256(candidatePath),
      falseAdmissions: candidate.counts.falseAdmissions,
      decision: candidate.interpretation.decision,
    },
    costPreflight: {
      path: 'eval/r3/out/cost-preflight.json',
      note: 'Run before the pilot. The manifest sets strictUsage=true; the runner stops on any unknownUsage.',
      status: cost?.status ?? 'pending',
    },
  },
  comparability: 'This is the shipped economy preset at 32k, not the R2 16k stress lane. Do not pool it with the R2 pilot or confirm.',
  note: 'A feasibility/quality/cost pilot, not a confirmatory campaign. The authorization file is bound to this manifest SHA-256.',
}

mkdirSync(E2E_OUT, { recursive: true })
const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const manifestSha = sha256(manifestPath)

const authorization = {
  schemaVersion: 1,
  campaign: CAMPAIGN,
  manifest: `eval/e2e/out/manifest-${CAMPAIGN}.json`,
  manifestSha256: manifestSha,
  granted: true,
  grantedAt: new Date().toISOString(),
  grantedBy: 'user instruction: "按推荐执行，均授权" (2026-11-11)',
  basis: 'The user authorized the recommended 16-request health probe and the 18-cell product-lane pilot after the offline audit.',
  limits,
  stopConditions: [
    'Any transport failure stops the run; the cell is recorded as transport-failed, not an arm outcome.',
    'Any unknownUsage > 0 stops the run with provider-usage-incomplete.',
    'No automatic retry after a transport failure.',
    'A failed health probe cancels the pilot.',
  ],
  note: 'This authorization is bound to the manifest SHA-256 above. A changed manifest needs a new grant.',
}
const authorizationPath = join(E2E_OUT, `authorization-${CAMPAIGN}.json`)
writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, 'utf8')

const design = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane pilot',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  status: 'pilot-frozen',
  executionAuthorized: false,
  authorizationState: 'granted-by-user-instruction',
  manifest: { path: `eval/e2e/out/manifest-${CAMPAIGN}.json`, sha256: manifestSha, cells: cells.length },
  authorization: { path: `eval/e2e/out/authorization-${CAMPAIGN}.json`, sha256: sha256(authorizationPath), granted: true },
  tasks: tasks.map(task => task.id),
  arms: ARMS,
  config,
  limits,
  prerequisites: manifest.prerequisites,
  note: '18 cells = 6 tasks x 3 arms x 1 replicate. This is a pilot; the 72-cell product lane is not authorized.',
}
const designPath = join(OUT, 'product-pilot-design.json')
writeFileSync(designPath, `${JSON.stringify(design, null, 2)}\n`, 'utf8')

process.stdout.write(`product pilot frozen: ${cells.length} cells, ${tasks.length} tasks, ${ARMS.length} arms\n`)
process.stdout.write(`  manifest ${manifestPath}\n  sha256 ${manifestSha}\n  authorization granted=${authorization.granted}\n`)
process.stdout.write(`  worktreeClean=${manifest.code.worktreeClean}; evaluatedCommit=${manifest.code.evaluatedCommit.slice(0, 8)}\n`)
process.stdout.write(`wrote ${designPath}\n`)
