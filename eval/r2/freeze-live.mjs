#!/usr/bin/env node
/**
 * EF-R2 WP6 — freeze the 72-cell design. No live call is authorized.
 *
 * This file is the pre-registration, not a grant. It records:
 *
 *   - the six action-diverse archetypes and their 12 instances;
 *   - the 72 cells (12 × 3 arms × 2 replicates);
 *   - the config that differs from EF-R1 (leafAdmission economic, not legacy);
 *   - the zero-request preflight and the offline certification;
 *   - the envelope that a future authorization would have to grant.
 *
 * `executionAuthorized: false` is deliberate. The existing EF-R1 envelopes are
 * closed; reusing one silently would be the exact failure this round criticizes.
 *
 *   node eval/r2/freeze-live.mjs
 *
 * @module eval/r2/freeze-live
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks-r2')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const OUT = join(HERE, 'out')
const CAMPAIGN = 'e2e-r2-live-1'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const gitText = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const ARCHETYPES = [
  { template: 'T11', category: 'historical-test', action: 'fix a failing test, report the pre-change failure count' },
  { template: 'T12', category: 'revised-constraint', action: 'apply the latest user revision, not the baseline' },
  { template: 'T13', category: 'historical-tool-evidence', action: 'recover a value from a rotated tool observation' },
  { template: 'T14', category: 'long-multi-step', action: 'apply a corrected plan and run the tests' },
  { template: 'T15', category: 'time-version', action: 'select the value effective at a named time' },
  { template: 'T16', category: 'multi-compaction', action: 'finish after a second fold in a two-stage continuation' },
]
const ARMS = ['B0', 'E0', 'E1']
const REPLICATES = [1, 2]

const taskFiles = readdirSync(TASKS)
  .filter(name => /^T\d+-s\d\.json$/u.test(name))
  .sort()
const tasks = taskFiles.map(name => {
  const path = join(TASKS, name)
  const task = readJson(path)
  return {
    file: `eval/e2e/tasks-r2/${name}`,
    id: task.id,
    template: task.template,
    seed: task.seed,
    category: task.category,
    digest: sha256(path),
  }
})

const cells = []
for (const [index, task] of tasks.entries()) {
  // Rotate the arm order per instance so a fixed position does not become a
  // confound. The SET of cells is unchanged.
  const rotated = [...ARMS.slice(index % ARMS.length), ...ARMS.slice(0, index % ARMS.length)]
  for (const arm of rotated) {
    for (const replicate of REPLICATES) {
      cells.push({ block: 'r2-live', task: task.id, arm, replicate })
    }
  }
}

const preflightPath = join(OUT, 'preflight-r2.json')
const certificationPath = join(OUT, 'task-certification-r2.json')
const preflight = existsSync(preflightPath) ? readJson(preflightPath) : null
const certification = existsSync(certificationPath) ? readJson(certificationPath) : null

const proposedEnvelope = {
  continuationCells: 72,
  httpAttempts: 2_000,
  inputTokens: 20_000_000,
  outputTokens: 1_500_000,
  wallClockMs: 6 * 60 * 60 * 1000,
  paidConcurrency: 2,
  note: 'Proposed only. Not granted. A live run requires a separate, explicit authorization bound to the frozen manifest hash.',
}

const manifest = {
  schemaVersion: 1,
  campaign: CAMPAIGN,
  frozenAt: new Date().toISOString(),
  work: 'EF-R2 WP6',
  status: 'design-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  code: {
    evaluatedCommit: gitText('rev-parse', 'HEAD'),
    branch: gitText('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: (gitText('status', '--porcelain') ?? '').split('\n').filter(Boolean)
      .filter(line => !line.includes('watchdog.heartbeat')).length === 0,
  },
  model: 'deepseek-v4.1-flash',
  route: {
    origin: 'not-resolved',
    note: 'Resolved only when a live authorization is granted; this manifest is not runnable yet.',
  },
  arms: {
    B0: 'native DSH Basic',
    E0: 'EF minimal, semanticMode none, economic leaf admission, economics root policy',
    E1: 'EF rationale, semanticMode rationale, economic leaf admission, economics root policy',
  },
  config: {
    leafAdmission: 'economic',
    rootPolicy: 'economics',
    framingMode: 'legacy',
    semanticContinuity: 'off',
    rationaleHintTokens: 800,
    thresholdRatio: 0.5,
    operationalBudgetTokens: 16_384,
    maxSteps: 8,
    retainRatio: 0.04,
    headroomTokens: 512,
  },
  r1Difference: 'EF-R1 E1 ran leafAdmission legacy. This design pre-registers economic admission for both E0 and E1; framing and root policy are held constant across the two EF arms. The change is a measured config difference, not an assumed fix.',
  design: {
    archetypes: ARCHETYPES,
    instances: tasks.length,
    arms: ARMS,
    replicates: REPLICATES,
    cells: cells.length,
    preflight: preflight === null ? null : {
      path: 'eval/r2/out/preflight-r2.json',
      sha256: sha256(preflightPath),
      cells: preflight.cells,
      passed: preflight.passed,
      requests: preflight.requests,
      byArm: preflight.byArm,
    },
    certification: certification === null ? null : {
      path: 'eval/r2/out/task-certification-r2.json',
      sha256: sha256(certificationPath),
      pass: certification.pass,
      tasks: certification.tasks?.length ?? null,
    },
  },
  tasks,
  cells,
  perCell: { requests: 24, inputTokens: 250_000, outputTokens: 20_000, wallClockMs: 300_000 },
  limits: {
    ...proposedEnvelope,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded; the envelope is in tokens and wall clock.',
  },
  authorizationEnvelope: 'r2-live (proposed, not granted)',
  note: 'This manifest freezes the design and nothing else. A live run needs a new grant bound to the manifest SHA-256.',
}

mkdirSync(E2E_OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })
const manifestPath = join(E2E_OUT, `manifest-${CAMPAIGN}.json`)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const design = {
  schemaVersion: 1,
  work: 'EF-R2 WP6',
  generatedAt: new Date().toISOString(),
  campaign: CAMPAIGN,
  status: 'design-frozen',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  manifest: {
    path: `eval/e2e/out/manifest-${CAMPAIGN}.json`,
    sha256: sha256(manifestPath),
    cells: cells.length,
  },
  archetypes: ARCHETYPES,
  arms: manifest.arms,
  config: manifest.config,
  r1Difference: manifest.r1Difference,
  preflight: manifest.design.preflight,
  certification: manifest.design.certification,
  proposedEnvelope,
  note: 'No provider call is made by this script or by the design. The preflight is a scripted, zero-request wiring test.',
}
writeFileSync(join(OUT, 'live-design-r2.json'), `${JSON.stringify(design, null, 2)}\n`, 'utf8')

process.stdout.write(`live design: ${CAMPAIGN}, ${cells.length} cells, ${tasks.length} instances, ${ARCHETYPES.length} archetypes\n`)
process.stdout.write(`preflight: ${preflight?.passed ?? 'missing'}/${preflight?.cells ?? '?'} cells, requests ${preflight?.requests ?? '?'}; certification ${certification?.pass ?? 'missing'}\n`)
process.stdout.write(`manifest ${manifestPath} sha256 ${design.manifest.sha256.slice(0, 16)} executionAuthorized=${manifest.executionAuthorized}\n`)
