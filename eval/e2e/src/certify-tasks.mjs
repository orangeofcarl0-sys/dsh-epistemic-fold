#!/usr/bin/env node
/**
 * Offline certification of the twelve task instances.
 *
 * For every instance, three runs of the SAME checker:
 *
 *   initial          must FAIL   (otherwise the task is already done)
 *   reference        must PASS   (otherwise the task is impossible)
 *   counterfactual   must FAIL   (otherwise the checker cannot tell a
 *                                 plausible wrong answer from a right one)
 *
 * It also measures the seeded history with the host's own token meter and
 * asserts that it exceeds the pressure threshold the cell will use. A seed
 * below the threshold would produce a `no-fold` cell, which is a valid outcome
 * to REPORT but a broken fixture to SHIP: the task would not test the
 * mechanism it was written for.
 *
 *   node eval/e2e/src/certify-tasks.mjs
 *
 * @module eval/e2e/src/certify-tasks
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { runChecks } from './checker.mjs'
import { buildSeed, appendTurn } from './seed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const TASKS = join(ROOT, 'eval', 'e2e', 'tasks')

async function materialize(files, workspace) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(workspace, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
}

async function listTaskFiles() {
  const names = await readdir(TASKS)
  return names.filter(name => /^T\d-s\d\.json$/u.test(name)).sort()
}

function measure(events) {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const session = Session.create(SessionId('ef-e2e-measure'), events)
  return ctx.tokenMeter.measure(session).totalTokens
}

const report = []
let failed = false

for (const name of await listTaskFiles()) {
  const task = JSON.parse(await readFile(join(TASKS, name), 'utf8'))
  const threshold = Math.floor(task.operationalBudgetTokens * task.thresholdRatio)
  const seedTokens = measure(buildSeed(task.history, {
    provider: 'ef-e2e', model: 'measure', maxTokens: 1024, sessionId: `seed-${task.id}`,
  }))
  const stageBTokens = task.stageB === undefined ? null : measure(appendTurn(
    buildSeed(task.history, { provider: 'ef-e2e', model: 'measure', maxTokens: 1024, sessionId: `seed-b-${task.id}` }),
    task.stageB,
    { provider: 'ef-e2e', model: 'measure', maxTokens: 1024 },
  ))

  const outcomes = {}
  for (const [variant, files, expected] of [
    ['initial', task.workspace, false],
    ['reference', { ...task.workspace, ...task.reference }, true],
    ['counterfactual', { ...task.workspace, ...task.counterfactual }, false],
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), `ef-e2e-${task.id}-${variant}-`))
    try {
      await materialize(files, workspace)
      const result = await runChecks(task.checks, { workspace, repoRoot: ROOT })
      outcomes[variant] = {
        pass: result.pass,
        expected,
        ok: result.pass === expected,
        checks: result.checks.map(row => ({ kind: row.kind, pass: row.pass, detail: row.detail })),
      }
      if (result.pass !== expected) failed = true
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  const seedOk = seedTokens >= threshold
  const stageBOk = stageBTokens === null || stageBTokens >= threshold
  if (!seedOk || !stageBOk) failed = true

  report.push({
    id: task.id,
    template: task.template,
    seed: task.seed,
    category: task.category,
    budgetTokens: task.operationalBudgetTokens,
    thresholdTokens: threshold,
    seedTokens,
    seedAboveThreshold: seedOk,
    ...(stageBTokens === null ? {} : { stageBTokens, stageBAboveThreshold: stageBOk }),
    outcomes,
  })
  process.stdout.write(
    `${task.id}  seed ${seedTokens}/${threshold} ${seedOk ? 'ok' : 'BELOW'}  `
    + `initial ${outcomes.initial.pass ? 'PASS(bad)' : 'fail'}  `
    + `reference ${outcomes.reference.pass ? 'pass' : 'FAIL(bad)'}  `
    + `counterfactual ${outcomes.counterfactual.pass ? 'PASS(bad)' : 'fail'}\n`,
  )
}

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-E2E',
  tasks: report,
  pass: !failed,
}
await mkdir(join(ROOT, 'eval', 'e2e', 'out'), { recursive: true })
await writeFile(join(ROOT, 'eval', 'e2e', 'out', 'task-certification.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
process.stdout.write(`task certification: ${out.pass ? 'pass' : 'FAIL'}\n`)
process.exit(out.pass ? 0 : 1)
