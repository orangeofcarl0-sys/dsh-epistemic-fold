#!/usr/bin/env node
/**
 * EF-R1 WP4 — freeze the L×G ablation design, with no live call.
 *
 * ## Why this is not a campaign run
 *
 * Both earlier envelopes are closed (72/72 and 24/24). The work package says
 * the next behavioural step must be designed and certified offline, then
 * explicitly authorized; this script therefore produces a FROZEN DESIGN and a
 * ZERO-REQUEST PREFLIGHT, not a run. `executionAuthorized` is false and the
 * runner is never invoked.
 *
 * ## The design
 *
 * Two mechanisms, separated so their effects are not confounded:
 *
 *   L  archive locator (executable address for an archived observation)
 *   G  completion guard (a shared harness/runtime check that keeps asking for
 *      the required file; NOT an EF feature and NOT part of the product claim)
 *
 *   E0      neither            the reference EF core
 *   E0-L    locator only
 *   E0-G    guard only
 *   E0-LG   both
 *   E1      neither; rationale reference arm, never pooled with the 2×2
 *
 * Six task templates × two seeds = 12 distinct task instances. Two paired
 * replicates per instance, arm order rotated, 5 arms → 120 cells. The primary
 * unit is the TASK INSTANCE, not the cell: 24 cells over 6 templates are not
 * 24 independent observations.
 *
 * ## What the preflight proves
 *
 * Every task is certified (initial fails, reference passes, counterfactual
 * fails, seed above the pressure threshold), every cell is unique, the L and G
 * factors appear only in their own arms, and the locator estimate is bounded.
 * It makes no provider request.
 *
 *   node eval/ef-r1/ablation-design.mjs [--check]
 *
 * @module eval/ef-r1/ablation-design
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  MAX_ARCHIVE_LOCATORS,
  renderArchiveLocatorSection,
  selectArchiveLocators,
} from '../../lib/checkpoint/locator.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks')
const CHECK = process.argv.includes('--check')
const CHECKPOINT = '00000000-0000-4000-8000-000000000000'

const TEMPLATES = ['T2', 'T4', 'T7', 'T8', 'T9', 'T10']
const SEEDS = [1, 2]
const REPLICATES = [1, 2]
const ARMS = [
  { id: 'E0', locator: false, guard: false, role: '2x2-reference', ef: { semanticMode: 'none', archiveLocator: false } },
  { id: 'E0-L', locator: true, guard: false, role: '2x2', ef: { semanticMode: 'none', archiveLocator: true } },
  { id: 'E0-G', locator: false, guard: true, role: '2x2', ef: { semanticMode: 'none', archiveLocator: false } },
  { id: 'E0-LG', locator: true, guard: true, role: '2x2', ef: { semanticMode: 'none', archiveLocator: true } },
  { id: 'E1', locator: false, guard: false, role: 'rationale-reference', ef: { semanticMode: 'rationale', archiveLocator: false } },
]

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Build the model-visible messages a seeded history would archive. */
function historyMessages(task) {
  const messages = []
  for (const [index, entry] of task.history.entries()) {
    if (entry.role === 'user') {
      messages.push(createUserMessage({ content: [{ type: 'text', text: entry.text }], source: { kind: 'user' } }))
      continue
    }
    if (entry.role === 'assistant') {
      messages.push(createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: entry.text }],
        source: { kind: 'model', provider: 'design', model: 'design' },
      }))
      continue
    }
    if (entry.role === 'tool') {
      const id = ToolCallId(`call-design-${index}`)
      messages.push(createMessage({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id,
          name: entry.name,
          arguments: entry.arguments ?? '{}',
        }],
        source: { kind: 'model', provider: 'design', model: 'design' },
      }))
      messages.push(createToolResultMessage({
        callId: id,
        content: [{ type: 'text', text: entry.text }],
        isError: false,
      }))
    }
  }
  return messages
}

function locatorEstimate(task) {
  const locators = selectArchiveLocators(historyMessages(task), CHECKPOINT)
  const section = renderArchiveLocatorSection(locators)
  return {
    locators: locators.length,
    maxLocators: MAX_ARCHIVE_LOCATORS,
    labels: locators.map(locator => locator.label ?? null),
    sectionChars: section.length,
    sectionTokensEstimate: Math.ceil(section.length / 4),
  }
}

function cells() {
  const out = []
  for (const [templateIndex, template] of TEMPLATES.entries()) {
    for (const seed of SEEDS) {
      const taskId = `${template}-s${seed}`
      for (const replicate of REPLICATES) {
        const shift = (templateIndex + seed + replicate) % ARMS.length
        const ordered = [...ARMS.slice(shift), ...ARMS.slice(0, shift)]
        for (const arm of ordered) {
          out.push({
            cellId: `${taskId}-${arm.id}-r${replicate}`,
            task: taskId,
            template,
            seed,
            arm: arm.id,
            replicate,
            guard: arm.guard,
            ef: arm.ef,
          })
        }
      }
    }
  }
  return out
}

function main() {
  const certificationPath = join(OUT, 'task-certification-e2e2.json')
  if (!existsSync(certificationPath)) {
    process.stderr.write('ef-r1 design: task certification is missing; run certify-tasks first\n')
    process.exit(2)
  }
  const certification = readJson(certificationPath)
  const certified = new Map(certification.tasks.map(task => [task.id, task]))

  const taskInstances = []
  const problems = []
  for (const template of TEMPLATES) {
    for (const seed of SEEDS) {
      const id = `${template}-s${seed}`
      const path = join(TASKS, `${id}.json`)
      if (!existsSync(path)) {
        problems.push({ kind: 'task-missing', id })
        continue
      }
      const text = readFileSync(path, 'utf8')
      const task = JSON.parse(text)
      const cert = certified.get(id)
      const certifiedOk = cert !== undefined
        && cert.outcomes.initial.ok === true
        && cert.outcomes.reference.ok === true
        && cert.outcomes.counterfactual.ok === true
        && cert.seedAboveThreshold === true
      if (!certifiedOk) problems.push({ kind: 'task-not-certified', id })
      taskInstances.push({
        id,
        template,
        seed,
        category: task.category,
        digest: sha256(text),
        certified: certifiedOk,
        seedTokens: cert?.seedTokens ?? null,
        thresholdTokens: cert?.thresholdTokens ?? null,
        locatorEstimate: locatorEstimate(task),
      })
    }
  }

  const matrix = cells()
  const ids = new Set()
  for (const cell of matrix) {
    if (ids.has(cell.cellId)) problems.push({ kind: 'duplicate-cell', cellId: cell.cellId })
    ids.add(cell.cellId)
    const arm = ARMS.find(candidate => candidate.id === cell.arm)
    if (arm === undefined) problems.push({ kind: 'unknown-arm', cellId: cell.cellId })
    if (cell.guard !== (cell.arm === 'E0-G' || cell.arm === 'E0-LG')) {
      problems.push({ kind: 'guard-factor-mismatch', cellId: cell.cellId })
    }
    if (cell.ef.archiveLocator !== (cell.arm === 'E0-L' || cell.arm === 'E0-LG')) {
      problems.push({ kind: 'locator-factor-mismatch', cellId: cell.cellId })
    }
    if (cell.arm === 'E1' && (cell.guard || cell.ef.archiveLocator)) {
      problems.push({ kind: 'reference-arm-contaminated', cellId: cell.cellId })
    }
    if (taskInstances.every(task => task.id !== cell.task)) {
      problems.push({ kind: 'cell-without-task', cellId: cell.cellId })
    }
  }
  const expectedCells = TEMPLATES.length * SEEDS.length * REPLICATES.length * ARMS.length
  if (matrix.length !== expectedCells) {
    problems.push({ kind: 'cell-count', expected: expectedCells, actual: matrix.length })
  }

  const byArm = {}
  for (const arm of ARMS) byArm[arm.id] = matrix.filter(cell => cell.arm === arm.id).length
  const expectedByArm = TEMPLATES.length * SEEDS.length * REPLICATES.length
  for (const [arm, count] of Object.entries(byArm)) {
    if (count !== expectedByArm) problems.push({ kind: 'arm-balance', arm, expected: expectedByArm, actual: count })
  }

  const design = {
    schemaVersion: 1,
    work: 'EF-R1 WP4',
    generatedAt: new Date().toISOString(),
    status: 'design-frozen',
    executionAuthorized: false,
    authorizationState: 'not-requested',
    authorizationNote: 'Both earlier envelopes are closed. This design makes no provider request; execution requires an explicit user authorization of the envelope below.',
    question: 'Does an executable archive address (L) improve historical recovery, does a shared completion guard (G) improve delivery, and do they interact?',
    design: {
      type: '2x2 factorial with an independent rationale reference arm',
      factors: { L: 'archiveLocator', G: 'completion guard (cell-level, not an EF feature)' },
      arms: ARMS,
      templates: TEMPLATES,
      seeds: SEEDS,
      replicates: REPLICATES,
      cells: matrix.length,
      faultReserveCells: 18,
      envelopeCellCap: matrix.length + 18,
      primaryUnit: 'task instance (template + seed), not cell',
      pairing: 'both replicates of one task instance run the same arm set; arm order rotates by template/seed/replicate',
    },
    requestedEnvelope: {
      continuationCells: matrix.length + 18,
      httpAttempts: 4_200,
      inputTokens: 30_000_000,
      outputTokens: 1_200_000,
      wallClockMs: 6 * 60 * 60 * 1000,
      paidConcurrency: 2,
      monetaryUsd: 25,
      monetaryNote: 'No per-token price is verifiable for the local route; requests/tokens/time are the enforced bound.',
    },
    analysisPlan: {
      primary: [
        'E0 vs E0-L: paired difference in correctValueProduced, outputWritten, checkerPassed per task instance',
        'E0 vs E0-G: paired difference in outputWritten and checkerPassed',
        'E0-LG vs E0: interaction; report whether L and G are additive, redundant, or interfering',
        'E1: reported separately as a reference; never pooled into the 2x2',
      ],
      statistics: 'exact two-sided McNemar on discordant task instances; report the discordant counts and a paired risk difference, not only a p-value',
      stageReporting: 'reuse the WP2 stage labels (observe/produce/write/schema/verify), with C-unknown counted apart',
      grouping: 'per template and per task instance; no pooling of 120 cells as independent samples',
      stopping: 'no interim analysis; stop only on provider failure, unknown usage, budget exhaustion, or an integrity violation',
    },
    taskInstances,
    cells: matrix,
    preflight: {
      checks: [
        'every task certified (initial fail, reference pass, counterfactual fail, seed above threshold)',
        'each cell unique and assigned to a known task',
        'L appears only in E0-L/E0-LG; G only in E0-G/E0-LG; E1 carries neither',
        'arms balanced',
        'locator estimate within the renderer budget',
      ],
      problems,
      pass: problems.length === 0,
    },
    prerequisites: [
      'the E0-L/E0-G/E0-LG arms exist in eval/e2e/src/host.mjs (added, never executed)',
      'a new freeze/authorize cycle must bind the code tree, task digests and cells',
      'the analysis must use the stage attribution, not only the checker bit',
    ],
    provenance: {
      evaluatorCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      certification: 'eval/ef-r1/out/task-certification-e2e2.json',
      liveCalls: 0,
    },
    verdict: problems.length === 0 ? 'preflight-pass' : 'preflight-fail',
  }

  if (CHECK) {
    process.stdout.write(`ef-r1 design preflight: ${design.verdict}\n`)
    if (problems.length > 0) {
      for (const problem of problems) process.stdout.write(`  ${JSON.stringify(problem)}\n`)
      process.exit(1)
    }
    return
  }

  mkdirSync(OUT, { recursive: true })
  const json = `${JSON.stringify(design, null, 2)}\n`
  writeFileSync(join(OUT, 'ablation-design.json'), json, 'utf8')
  const freeze = {
    schemaVersion: 1,
    path: 'eval/ef-r1/out/ablation-design.json',
    sha256: sha256(json),
    frozenAt: design.generatedAt,
    cells: matrix.length,
    envelopeCellCap: design.design.envelopeCellCap,
    executionAuthorized: false,
  }
  writeFileSync(join(OUT, 'ablation-design.freeze.json'), `${JSON.stringify(freeze, null, 2)}\n`, 'utf8')

  process.stdout.write(`ef-r1 design: ${design.verdict}\n`)
  process.stdout.write(`  cells ${matrix.length} (${TEMPLATES.length} templates x ${SEEDS.length} seeds x ${REPLICATES.length} replicates x ${ARMS.length} arms)\n`)
  process.stdout.write(`  envelope cap ${design.design.envelopeCellCap} (${design.design.faultReserveCells} reserve)\n`)
  process.stdout.write(`  design sha256 ${freeze.sha256.slice(0, 16)}\n`)
  if (problems.length > 0) {
    for (const problem of problems) process.stdout.write(`  ${JSON.stringify(problem)}\n`)
    process.exit(1)
  }
}

main()
