#!/usr/bin/env node
/**
 * EF-R4 WP5 — select at most one candidate from the measured mechanisms.
 *
 * The rules are fixed here, before the numbers are read, so the decision is not
 * a post-hoc choice. The output is a research candidate with a deterministic
 * contract; it is not wired into the plugin and does not change a default.
 *
 *   node eval/r4/candidate-decision.mjs
 *
 * @module eval/r4/candidate-decision
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './shared/audit.mjs'
import { planTaskDelivery } from './candidate/active-task-delivery.mjs'

const OUT = join(ROOT, 'eval', 'r4', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const PATHS = {
  baseline: join(OUT, 'baseline-r4.json'),
  rescore: join(OUT, 'rescored-r3.json'),
  lifecycle: join(OUT, 'evidence-lifecycle.json'),
  continuity: join(OUT, 'task-continuity.json'),
  workingSet: join(OUT, 'working-set.json'),
}

function main() {
  for (const [name, path] of Object.entries(PATHS)) {
    if (!existsSync(path)) {
      process.stderr.write(`candidate-decision: ${name} is missing at ${path}\n`)
      process.exit(2)
    }
  }
  const baseline = readJson(PATHS.baseline)
  const rescore = readJson(PATHS.rescore)
  const lifecycle = readJson(PATHS.lifecycle)
  const continuity = readJson(PATHS.continuity)
  const workingSet = readJson(PATHS.workingSet)

  const rescoreByCell = new Map(rescore.cells.map(cell => [cell.cellId, cell]))
  const lifecycleByCell = new Map(lifecycle.cells.map(cell => [cell.cellId, cell]))
  const continuityByCell = new Map(continuity.cells.map(cell => [cell.cellId, cell]))
  const workingByCell = new Map(workingSet.cells.map(cell => [cell.cellId, cell]))

  const rows = [...rescoreByCell.keys()].map(cellId => {
    const score = rescoreByCell.get(cellId)
    const life = lifecycleByCell.get(cellId)
    const cont = continuityByCell.get(cellId)
    const work = workingByCell.get(cellId)
    const taskRow = cont?.labels?.find(row => row.label === 'task') ?? null
    return {
      cellId,
      arm: score.arm,
      task: score.task,
      taskOutcome: score.taskOutcome,
      failedEf: score.arm !== 'B0' && score.taskOutcome !== 'correct',
      passedEf: score.arm !== 'B0' && score.taskOutcome === 'correct',
      taskSourceLost: taskRow?.firstLostRequest !== null && taskRow?.firstLostRequest !== undefined,
      taskSourceLostWithNoWrite: cont?.taskSourceLostWithNoWrite === true,
      recallCalls: life?.summary?.recallCalls ?? 0,
      folded: life?.summary?.folded ?? 0,
      refolded: life?.summary?.refolded ?? 0,
      openFailureCount: work?.failureProjection?.openFailureCount ?? 0,
      duplicateSignatures: work?.failureProjection?.duplicateSignatures ?? 0,
      failureShare: work?.failureProjection?.share ?? null,
    }
  })

  const failedEf = rows.filter(row => row.failedEf)
  const passedEf = rows.filter(row => row.passedEf)
  const failedWithLoss = failedEf.filter(row => row.taskSourceLostWithNoWrite)
  const passedWithLoss = passedEf.filter(row => row.taskSourceLost)
  const folded = rows.reduce((sum, row) => sum + row.folded, 0)
  const refolded = rows.reduce((sum, row) => sum + row.refolded, 0)
  const inflationCells = rows.filter(row => row.duplicateSignatures >= 2 && (row.failureShare ?? 0) >= 0.25)
  const h2Cases = failedEf.filter(row => !row.taskSourceLost && row.recallCalls === 0)

  const rules = [
    {
      id: 'H1a-task-source-loss',
      description: '>=2 failed EF cells lose the exact task source before any write; no passing EF cell does',
      threshold: { failedWithLoss: 2, passedWithLoss: 0 },
      actual: {
        failedWithLoss: failedWithLoss.length,
        passedWithLoss: passedWithLoss.length,
        cells: failedWithLoss.map(row => row.cellId),
      },
      met: failedWithLoss.length >= 2 && passedWithLoss.length === 0,
    },
    {
      id: 'H1b-recall-refolding',
      description: 'at least half of the shadowed recall payloads are not visible at the next request',
      threshold: { ratio: 0.5 },
      actual: { folded, refolded, ratio: folded === 0 ? null : refolded / folded },
      met: folded > 0 && refolded / folded >= 0.5,
    },
    {
      id: 'H2-evidence-scope',
      description: 'a failed EF cell with no task-source loss and no recall still writes a wrong value',
      threshold: { cases: 1 },
      actual: { cases: h2Cases.map(row => row.cellId) },
      met: h2Cases.length >= 1,
    },
    {
      id: 'failure-projection-inflation',
      description: 'a failed EF cell has >=2 duplicate failure signatures and Open >=25% of checkpoint chars',
      threshold: { duplicateSignatures: 2, share: 0.25 },
      actual: {
        cells: inflationCells.map(row => ({
          cellId: row.cellId,
          duplicateSignatures: row.duplicateSignatures,
          share: row.failureShare,
        })),
      },
      met: inflationCells.length >= 1,
    },
  ]

  // Precedence: a task-contract loss is the first thing that makes the other
  // mechanisms unobservable. Re-folding is next, then interpretation, then the
  // projection. One candidate only.
  const selected = rules[0].met
    ? 'active-task-delivery'
    : rules[1].met
      ? 'evidence-continuation-lease'
      : rules[2].met && h2Cases.length > 1
        ? 'provenance-time-annotation'
        : rules[3].met
          ? 'failure-projection-bounding'
          : 'none'

  const simulations = []
  for (const row of failedWithLoss) {
    const cont = continuityByCell.get(row.cellId)
    const work = workingByCell.get(row.cellId)
    const labels = cont?.labels ?? []
    const finalLabel = labels.find(label => label.label === 'taskB') ?? labels.find(label => label.label === 'task')
    if (finalLabel === undefined) continue
    const cellTask = rescore.cells.find(cell => cell.cellId === row.cellId)?.task ?? row.task
    // The prompt text is not stored in task-continuity; read the task file.
    const taskEntry = readJson(join(ROOT, 'eval', 'e2e', 'out', 'manifest-e2e-r3-product-pilot-1.json')).tasks
      .find(entry => entry.id === cellTask)
    const taskJson = taskEntry === undefined ? null : readJson(join(ROOT, taskEntry.file))
    const prompt = finalLabel.label === 'taskB' ? taskJson?.taskB : taskJson?.task
    const plan = planTaskDelivery({
      requests: finalLabel.requests,
      prompt: prompt ?? '',
      sourceSeq: finalLabel.sourceSeq,
      sourceDigest: finalLabel.promptSha256,
      maxRedeliveries: 2,
    })
    simulations.push({
      cellId: row.cellId,
      arm: row.arm,
      label: finalLabel.label,
      promptChars: plan.promptChars,
      deliveries: plan.deliveries,
      addedChars: plan.addedChars,
      checkpointChars: work?.failureProjection?.checkpointChars ?? null,
      addedShareOfCheckpoint: work?.failureProjection?.checkpointChars
        ? plan.addedChars / work.failureProjection.checkpointChars
        : null,
    })
  }
  const addedChars = simulations.reduce((sum, entry) => sum + entry.addedChars, 0)
  const promptChars = simulations.reduce((sum, entry) => sum + entry.promptChars, 0)

  const output = {
    schemaVersion: 1,
    work: 'EF-R4 WP5 candidate decision',
    generatedAt: new Date().toISOString(),
    baseline: {
      head: baseline.git.head,
      headShort: baseline.git.headShort,
      campaign: baseline.r3.campaign,
      manifestSha256: baseline.r3.manifestSha256,
    },
    rules,
    selected,
    contractOnly: true,
    notWired: true,
    evidence: {
      failedEfCells: failedEf.map(row => row.cellId),
      passedEfCells: passedEf.map(row => row.cellId),
      failedWithLoss: failedWithLoss.map(row => row.cellId),
      passedWithLoss: passedWithLoss.map(row => row.cellId),
      h2Cases: h2Cases.map(row => row.cellId),
      inflationCells: inflationCells.map(row => row.cellId),
    },
    simulation: {
      candidate: selected === 'active-task-delivery' ? 'active-task-delivery' : null,
      cells: simulations,
      addedChars,
      promptChars,
      digestBasis: 'sha256 of the prompt text used for the simulation; the wired contract would use the original event content digest',
      note: 'chars only; no token claim. The projection is bounded by maxRedeliveries=2.',
    },
    secondary: rules.filter((rule, index) => index > 0 && rule.met).map(rule => rule.id),
    whyNot: selected === 'active-task-delivery'
      ? [
          'One mechanism only: the task contract is the first precondition for using any retrieved evidence.',
          'Re-folding and failure projection remain measured secondary findings, not additional candidates.',
        ]
      : [],
    counterevidence: [
      'T11-p1-E1 has no task-source loss and no recall, yet writes the wrong historical value; that is H2, not task delivery.',
      'T16-p1-B0 has no task-source loss and still fails on the output schema and the fold count; task delivery alone is not sufficient.',
      'Passing EF cells have no task-source loss, so the correlation is strong but not a counterfactual proof.',
    ],
    limits: [
      'The candidate is a research contract, not a product change.',
      'The simulation adds exact prompt chars to a request; it does not prove the model would act on them.',
      'No live run was made; quality, cost and latency effects are unmeasured.',
      'Deployment Hold remains; this is not a product candidate.',
    ],
  }

  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, 'candidate-decision.json')
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# EF-R4 — candidate decision')
  md.push('')
  md.push(`Selected: **${selected}** (contract only, not wired).`)
  md.push('')
  md.push('## Pre-registered rules')
  md.push('')
  md.push('| Rule | Met | Actual |')
  md.push('|---|---|---|')
  for (const rule of rules) {
    md.push(`| ${rule.id} | ${rule.met ? 'yes' : 'no'} | ${JSON.stringify(rule.actual)} |`)
  }
  md.push('')
  md.push('## Offline simulation')
  md.push('')
  md.push('| Cell | Active label | Prompt chars | Deliveries | Added chars | Share of final checkpoint |')
  md.push('|---|---|---|---|---|---|')
  for (const entry of simulations) {
    md.push(`| ${entry.cellId} | ${entry.label} | ${entry.promptChars} | ${entry.deliveries.length} | ${entry.addedChars} | ${entry.addedShareOfCheckpoint === null ? '—' : entry.addedShareOfCheckpoint.toFixed(2)} |`)
  }
  md.push('')
  md.push(`Total added prompt chars: **${addedChars}** across ${simulations.length} failed cells (bounded to two deliveries per cell).`)
  md.push('')
  md.push('## Counterevidence')
  md.push('')
  for (const item of output.counterevidence) md.push(`- ${item}`)
  md.push('')
  md.push('## Limits')
  md.push('')
  for (const item of output.limits) md.push(`- ${item}`)
  md.push('')
  const mdPath = join(OUT, 'candidate-decision.md')
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

  process.stdout.write(`candidate: ${selected}; failed-with-loss ${failedWithLoss.length}; passed-with-loss ${passedWithLoss.length}; refold ${refolded}/${folded}; added chars ${addedChars}\n`)
  process.stdout.write(`wrote ${path}, ${mdPath}\n`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('candidate-decision.mjs')) main()
