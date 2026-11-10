#!/usr/bin/env node
/**
 * EF-R3 WP5 — quality, cost, reliability and eligibility, stress lane only.
 *
 * The report keeps the pilot and confirm separate: they use different instances
 * and are not pooled. It keeps THREE eligibility axes separate as well:
 *
 *   taskOutcomeValid   the checker result is readable
 *   treatmentValid     the compaction commit/delivery is readable
 *   costValid          every model request reported usage
 *
 * A checker pass is not a complete cost ledger. The report therefore prints
 * recorded resource deltas (all pairs) AND cost-valid deltas (both sides
 * complete), never one in place of the other. It makes no USD claim.
 *
 *   node eval/r3/product-frontier.mjs
 *
 * @module eval/r3/product-frontier
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEfConfig } from '../../lib/config/policy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const ledgerPath = join(OUT, 'cell-ledger.json')
if (!existsSync(ledgerPath)) {
  process.stderr.write('product-frontier: run eval/r3/reconcile-confirm.mjs first\n')
  process.exit(2)
}
const ledger = readJson(ledgerPath)

function exactMcNemar(b, c) {
  const n = b + c
  if (n === 0) return 1
  let tail = 0
  let term = 1
  for (let k = 0; k <= Math.min(b, c); k += 1) {
    if (k > 0) term = (term * (n - k + 1)) / k
    tail += term
  }
  return Math.min(1, 2 * tail * 0.5 ** n)
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function enrich(cell) {
  const report = cell.reportPath !== null && existsSync(cell.reportPath)
    ? readJson(cell.reportPath)
    : null
  const witness = cell.witnessSummary ?? report?.witnessSummary ?? null
  const usage = cell.usage ?? report?.usage ?? null
  const failedAttempts = (report?.witnesses ?? []).filter(entry => entry.status !== 'committed')
  return {
    cellId: cell.cellId,
    task: cell.task,
    template: cell.task.replace(/-s\d+$/u, ''),
    seed: Number(cell.task.slice(-1)),
    arm: cell.arm,
    replicate: cell.replicate,
    key: `${cell.task}-r${cell.replicate}`,
    status: cell.status,
    pass: cell.pass === true,
    taskOutcomeValid: cell.taskOutcomeValid === true,
    treatmentValid: cell.treatmentValid === true,
    costValid: cell.costValid === true,
    reasons: cell.reasons ?? [],
    configMismatch: cell.configMismatch ?? [],
    treatmentId: cell.treatmentId,
    effectiveConfigSummary: cell.effectiveConfigSummary,
    declaredConfigSummary: cell.declaredConfigSummary,
    requests: usage?.requests ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    auxiliaryRequests: usage?.auxiliaryRequests ?? 0,
    unknownUsage: usage?.unknownUsage ?? 0,
    attempts: witness?.attempts ?? 0,
    committed: witness?.committed ?? 0,
    refused: witness?.refused ?? 0,
    aborted: witness?.aborted ?? 0,
    unverifiable: witness?.unverifiable ?? 0,
    delivered: witness?.committedAndDelivered ?? 0,
    noFollowingRequest: witness?.noFollowingRequest ?? 0,
    cellsWithCommit: (witness?.committed ?? 0) > 0,
    cellsWithDelivery: (witness?.committedAndDelivered ?? 0) > 0,
    failedCallInput: sum(failedAttempts.map(entry => entry.rationale?.inputTokens ?? 0)),
    failedCallOutput: sum(failedAttempts.map(entry => entry.rationale?.outputTokens ?? 0)),
    termination: report?.termination?.kind ?? cell.termination?.kind ?? null,
    durationMs: report?.termination?.durationMs ?? cell.termination?.durationMs ?? null,
    checker: report?.checker ?? null,
    checksPassed: (report?.checker?.checks ?? []).filter(check => check.pass).length,
    checksTotal: (report?.checker?.checks ?? []).length,
    checkKinds: [...new Set((report?.checker?.checks ?? []).map(check => check.kind))].sort(),
    claimedSuccess: report?.behaviour?.claimedSuccess ?? null,
    falseVerification: report?.behaviour?.falseVerification ?? null,
    toolCalls: report?.tools?.calls ?? null,
    toolErrors: report?.tools?.errors ?? null,
    finalFiles: report?.workspace?.finalFiles ?? null,
    stageB: report?.stageB ?? null,
    leafSpanProbe: report?.leafSpanProbe ?? null,
    reportPath: cell.reportPath,
  }
}

function aggregate(cells) {
  const passed = cells.filter(cell => cell.pass).length
  const costValid = cells.filter(cell => cell.costValid)
  const costAggregate = (subset) => ({
    cells: subset.length,
    passed: subset.filter(cell => cell.pass).length,
    requests: sum(subset.map(cell => cell.requests)),
    inputTokens: sum(subset.map(cell => cell.inputTokens)),
    cacheReadTokens: sum(subset.map(cell => cell.cacheReadTokens)),
    cacheWriteTokens: sum(subset.map(cell => cell.cacheWriteTokens)),
    outputTokens: sum(subset.map(cell => cell.outputTokens)),
    auxiliaryRequests: sum(subset.map(cell => cell.auxiliaryRequests)),
    unknownUsage: sum(subset.map(cell => cell.unknownUsage)),
  })
  return {
    cells: cells.length,
    passed,
    rate: cells.length === 0 ? null : Number((passed / cells.length).toFixed(3)),
    taskOutcomeValid: cells.filter(cell => cell.taskOutcomeValid).length,
    treatmentValid: cells.filter(cell => cell.treatmentValid).length,
    costValid: costValid.length,
    costInvalid: cells.filter(cell => !cell.costValid).length,
    attempts: sum(cells.map(cell => cell.attempts)),
    committed: sum(cells.map(cell => cell.committed)),
    refused: sum(cells.map(cell => cell.refused)),
    aborted: sum(cells.map(cell => cell.aborted)),
    unverifiable: sum(cells.map(cell => cell.unverifiable)),
    delivered: sum(cells.map(cell => cell.delivered)),
    noFollowingRequest: sum(cells.map(cell => cell.noFollowingRequest)),
    cellsWithCommit: cells.filter(cell => cell.cellsWithCommit).length,
    cellsWithDelivery: cells.filter(cell => cell.cellsWithDelivery).length,
    cellsWithoutCommit: cells.filter(cell => !cell.cellsWithCommit).length,
    requests: sum(cells.map(cell => cell.requests)),
    inputTokens: sum(cells.map(cell => cell.inputTokens)),
    cacheReadTokens: sum(cells.map(cell => cell.cacheReadTokens)),
    cacheWriteTokens: sum(cells.map(cell => cell.cacheWriteTokens)),
    outputTokens: sum(cells.map(cell => cell.outputTokens)),
    auxiliaryRequests: sum(cells.map(cell => cell.auxiliaryRequests)),
    unknownUsage: sum(cells.map(cell => cell.unknownUsage)),
    failedCallInput: sum(cells.map(cell => cell.failedCallInput)),
    failedCallOutput: sum(cells.map(cell => cell.failedCallOutput)),
    durationMs: {
      median: median(cells.map(cell => cell.durationMs).filter(value => typeof value === 'number')),
      max: cells.map(cell => cell.durationMs).filter(value => typeof value === 'number').length === 0
        ? null
        : Math.max(...cells.map(cell => cell.durationMs).filter(value => typeof value === 'number')),
    },
    terminationKinds: cells.reduce((counts, cell) => {
      const kind = cell.termination ?? 'unknown'
      counts[kind] = (counts[kind] ?? 0) + 1
      return counts
    }, {}),
    checksPassed: sum(cells.map(cell => cell.checksPassed)),
    checksTotal: sum(cells.map(cell => cell.checksTotal)),
    claimedSuccess: cells.filter(cell => cell.claimedSuccess === true).length,
    falseVerification: cells.filter(cell => cell.falseVerification === true).length,
    cellsWithFinalFiles: cells.filter(cell => (cell.finalFiles?.length ?? 0) > 0).length,
    cellsWithStageB: cells.filter(cell => cell.stageB !== null && cell.stageB !== undefined).length,
    inputPerPass: passed === 0 ? null : Math.round(sum(cells.map(cell => cell.inputTokens)) / passed),
    costValidAggregate: costAggregate(costValid),
    costInvalidCells: cells
      .filter(cell => !cell.costValid)
      .map(cell => ({
        cellId: cell.cellId,
        requests: cell.requests,
        unknownUsage: cell.unknownUsage,
        reasons: cell.reasons,
      })),
  }
}

function pair(cells, leftArm, rightArm) {
  const byKey = new Map(cells.map(cell => [`${cell.key}:${cell.arm}`, cell]))
  const rows = []
  for (const key of new Set(cells.map(cell => cell.key))) {
    const left = byKey.get(`${key}:${leftArm}`)
    const right = byKey.get(`${key}:${rightArm}`)
    if (left === undefined || right === undefined) continue
    rows.push({
      key,
      left: left.cellId,
      right: right.cellId,
      leftPass: left.pass,
      rightPass: right.pass,
      leftCostValid: left.costValid,
      rightCostValid: right.costValid,
      delta: {
        pass: Number(left.pass) - Number(right.pass),
        requests: left.requests - right.requests,
        inputTokens: left.inputTokens - right.inputTokens,
        cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
        cacheWriteTokens: left.cacheWriteTokens - right.cacheWriteTokens,
        outputTokens: left.outputTokens - right.outputTokens,
      },
    })
  }
  const both = rows.filter(row => row.leftPass && row.rightPass).length
  const neither = rows.filter(row => !row.leftPass && !row.rightPass).length
  const leftOnly = rows.filter(row => row.leftPass && !row.rightPass).length
  const rightOnly = rows.filter(row => !row.leftPass && row.rightPass).length
  const costValidRows = rows.filter(row => row.leftCostValid && row.rightCostValid)
  const deltaSum = (subset, field) => sum(subset.map(row => row.delta[field]))
  const recorded = {
    pairs: rows.length,
    pass: deltaSum(rows, 'pass'),
    requests: deltaSum(rows, 'requests'),
    inputTokens: deltaSum(rows, 'inputTokens'),
    cacheReadTokens: deltaSum(rows, 'cacheReadTokens'),
    cacheWriteTokens: deltaSum(rows, 'cacheWriteTokens'),
    outputTokens: deltaSum(rows, 'outputTokens'),
  }
  const costValid = {
    pairs: costValidRows.length,
    pass: deltaSum(costValidRows, 'pass'),
    requests: deltaSum(costValidRows, 'requests'),
    inputTokens: deltaSum(costValidRows, 'inputTokens'),
    cacheReadTokens: deltaSum(costValidRows, 'cacheReadTokens'),
    cacheWriteTokens: deltaSum(costValidRows, 'cacheWriteTokens'),
    outputTokens: deltaSum(costValidRows, 'outputTokens'),
  }
  return {
    left: leftArm,
    right: rightArm,
    pairs: rows.length,
    both,
    neither,
    leftOnly,
    rightOnly,
    mcnemarP: Number(exactMcNemar(leftOnly, rightOnly).toFixed(4)),
    recorded,
    costValid,
    rows,
  }
}

function byTemplate(cells) {
  const templates = [...new Set(cells.map(cell => cell.template))].sort()
  return Object.fromEntries(templates.map(template => [
    template,
    Object.fromEntries([...new Set(cells.map(cell => cell.arm))].sort().map(arm => {
      const subset = cells.filter(cell => cell.template === template && cell.arm === arm)
      if (subset.length === 0) return [arm, null]
      return [arm, {
        cells: subset.length,
        passed: subset.filter(cell => cell.pass).length,
        committed: sum(subset.map(cell => cell.committed)),
        delivered: sum(subset.map(cell => cell.delivered)),
        costValid: subset.filter(cell => cell.costValid).length,
      }]
    })),
  ]))
}

function configSummary(config) {
  return {
    mode: config.mode ?? null,
    semanticMode: config.semanticMode ?? null,
    leafAdmission: config.leafAdmission ?? null,
    rootPolicy: typeof config.rootPolicy === 'object' && config.rootPolicy !== null
      ? config.rootPolicy.mode
      : config.rootPolicy ?? null,
    framingMode: config.framingMode ?? null,
    rationaleHintTokens: config.rationaleHintTokens ?? null,
    thresholdRatio: config.thresholdRatio ?? null,
    retainRatio: config.retainRatio ?? null,
    headroomTokens: config.headroomTokens ?? null,
    minReclaimTokens: config.minReclaimTokens ?? null,
    minReclaimRatio: config.minReclaimRatio ?? null,
  }
}

function stressVsProduct() {
  const manifestPath = join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json')
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null
  const preflightPath = join(OUT, 'config-preflight.json')
  const preflight = existsSync(preflightPath) ? readJson(preflightPath) : null
  const tier = (mode) => configSummary(resolveEfConfig({ mode }))
  return {
    stress: {
      lane: '16k stress',
      contextWindow: manifest?.config?.operationalBudgetTokens ?? null,
      thresholdRatio: manifest?.config?.thresholdRatio ?? null,
      retainRatio: manifest?.config?.retainRatio ?? null,
      headroomTokens: manifest?.config?.headroomTokens ?? null,
      framingMode: manifest?.config?.framingMode ?? null,
      semanticContinuity: manifest?.config?.semanticContinuity ?? null,
      leafAdmission: manifest?.config?.leafAdmission ?? null,
      rootPolicy: manifest?.config?.rootPolicy ?? null,
      rationaleHintTokensDeclared: manifest?.config?.rationaleHintTokens ?? null,
      rationaleHintTokensEffective: preflight?.arms?.find(entry => entry.arm === 'E1')?.effective?.rationaleHintTokens ?? null,
      dataStatus: 'observed (pilot + partial confirm)',
      note: 'Not the shipped product preset: 16k window, retain 0.04, framing legacy, hint 400 effective despite 800 declared.',
    },
    productPresets: {
      economy: tier('economy'),
      balanced: tier('balanced'),
      quality: tier('quality'),
      dataStatus: 'not-executed',
      note: 'The shipped presets use system-dedup framing, the tier retention and the tier hint budget. No R3 live cell ran them.',
    },
    basic: {
      backend: 'dsh-basic',
      stressConfig: {
        thresholdRatio: 0.5,
        retainRatio: 0.04,
        headroomTokens: 512,
        maxTokens: 1024,
      },
      dataStatus: 'observed in the stress lane only',
      note: 'Native Basic is the B0 arm; its product defaults are not frozen by this report.',
    },
    comparability: 'Stress-lane results must not be presented as product-preset evidence.',
  }
}

function buildCampaign(name, section) {
  const cells = section.cells.filter(cell => cell.status === 'valid').map(enrich)
  const arms = [...new Set(cells.map(cell => cell.arm))].sort()
  const byArm = Object.fromEntries(arms.map(arm => [arm, aggregate(cells.filter(cell => cell.arm === arm))]))
  const comparisons = []
  for (const [left, right] of [['E1', 'B0'], ['E1', 'E0'], ['E0', 'B0']]) {
    if (arms.includes(left) && arms.includes(right)) comparisons.push(pair(cells, left, right))
  }
  return {
    name,
    status: section.summary.status ?? null,
    planned: section.summary.planned,
    valid: section.summary.valid,
    unresolved: section.summary.unresolved,
    neverStarted: section.summary.neverStarted,
    noValidOutcome: section.summary.noValidOutcome,
    attempts: section.summary.attempts,
    transportFailedAttempts: section.summary.transportFailedAttempts,
    byArm,
    comparisons,
    byTemplate: byTemplate(cells),
    eligibility: {
      valid: section.summary.valid,
      costInvalid: section.summary.costInvalidCells.length,
      costInvalidCells: section.summary.costInvalidCells,
      configMismatchByKey: section.summary.configMismatchByKey,
      configMismatchCells: section.summary.configMismatchCells.length,
    },
    missingByTemplate: section.summary.missingByTemplate,
    cells,
  }
}

const pilot = buildCampaign('e2e-r2-pilot-1', ledger.pilot)
const confirm = buildCampaign('e2e-r2-confirm-merged', ledger.confirm)

const expected = {
  pilot: { pass: 1, requests: -30, inputTokens: -204_950, cacheReadTokens: 43_904, outputTokens: -25_577 },
  confirm: { pass: 0, requests: -28, inputTokens: 169_138, cacheReadTokens: -186_496, outputTokens: -18_954 },
}
function verifyExpected(campaign, expectedValues) {
  const comparison = campaign.comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
  if (comparison === undefined) return { available: false }
  return {
    available: true,
    expected: expectedValues,
    observed: comparison.recorded,
    matches: Object.fromEntries(Object.keys(expectedValues).map(key => [
      key,
      comparison.recorded[key] === expectedValues[key],
    ])),
  }
}

const spanPath = join(OUT, 'span-economics.json')
const spanEconomics = existsSync(spanPath) ? readJson(spanPath) : null
const cellsWithProbe = [...pilot.cells, ...confirm.cells].filter(cell => cell.leafSpanProbe !== null).length

const frontier = {
  schemaVersion: 1,
  work: 'EF-R3 WP5',
  generatedAt: new Date().toISOString(),
  source: {
    cellLedger: { path: 'eval/r3/out/cell-ledger.json', sha256: null },
    spanEconomics: spanEconomics === null ? null : { path: 'eval/r3/out/span-economics.json' },
    note: 'Pilot and confirm are separate instance sets and are not pooled. A checker pass is not a complete cost ledger.',
  },
  pilot,
  confirm,
  spanEconomics: spanEconomics === null ? null : {
    summary: spanEconomics.summary,
    findings: spanEconomics.findings,
    floorSensitivity: spanEconomics.floorSensitivity,
    note: 'Deterministic keyless matrix. R2 live reports predate the probe, so exact-span data for those cells is unavailable, not zero.',
  },
  probeAvailability: {
    r2LiveCellsWithProbe: cellsWithProbe,
    r2LiveValidCells: pilot.valid + confirm.valid,
    note: 'The R2 live reports were produced before the R3 telemetry. The probe is available for future runs and for the deterministic matrix.',
  },
  userNumberVerification: {
    pilot: verifyExpected(pilot, expected.pilot),
    confirm: verifyExpected(confirm, expected.confirm),
  },
  stressVsProduct: stressVsProduct(),
  limits: [
    'The confirm is partial: 23 valid, 1 unresolved, 30 never-started. It is not a confirmatory result.',
    'T14, T15 and T16 have no valid confirm cells; the valid subset is not a random sample of the 54-cell design.',
    'Only 5 of 7 confirm B0/E1 pairs and 4 of 6 pilot pairs have complete usage on both sides.',
    'The stress lane uses a 16k window, retain 0.04 and legacy framing; it is not the shipped economy/balanced/quality preset.',
    'One model, one local route, one machine. No USD price is recorded or claimed.',
    'R2 live reports predate the R3 leaf-span probe; exact-span economics for those cells is unavailable, not zero.',
  ],
  note: 'Descriptive paired deltas, not a powered economic estimate. The product lane has design only, no data.',
}

mkdirSync(OUT, { recursive: true })
const jsonPath = join(OUT, 'product-frontier.json')
writeFileSync(jsonPath, `${JSON.stringify(frontier, null, 2)}\n`, 'utf8')

const decision = {
  schemaVersion: 1,
  work: 'EF-R3 WP5',
  generatedAt: new Date().toISOString(),
  decision: 'no-product-candidate',
  deploymentHold: true,
  candidate: null,
  reasons: [
    'The confirm is partial (23/54 valid; 1 unresolved; 30 never-started) and is not a confirmatory result.',
    'The valid confirm cells cover T11-T13 only; T14-T16 have no valid cells, so the subset is task-type biased.',
    'E1 vs B0 paired checker difference is 0 in the confirm and +1 in the pilot; neither is a powered quality estimate.',
    'Recorded economics direction is unstable: the pilot shows lower uncached input, the confirm shows higher uncached input; cache-read direction is opposite.',
    'Cost validity is incomplete: 3 confirm cells and 3 pilot cells have null usage; only 5/7 and 4/6 B0/E1 pairs are cost-valid.',
    'The R2 E1 treatment is not the shipped economy preset: legacy framing, retain 0.04, 16k window, and hint 400 effective vs 800 declared.',
    'No product-representative lane has run; the stress lane cannot support a product candidate claim.',
    'No verifiable USD price is recorded; token-resource deltas are not a monetary comparison.',
  ],
  nextEvidence: [
    'A new explicit authorization is required to complete the 31 missing confirm cells or to terminate the confirm and preserve the partial conclusion.',
    'A product-representative lane with shipped presets is required before any product candidate claim.',
    'A representative B0 summary/primary health probe must pass before any completion run.',
  ],
  limits: frontier.limits,
  note: 'This is a decision not to promote a candidate on the current evidence, not a claim that E1 is ineffective. The stress-lane mechanism and the pilot direction remain research evidence.',
}
const decisionPath = join(OUT, 'product-decision.json')
writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, 'utf8')

// Markdown report.
const md = []
md.push('# EF-R3 — quality, cost and reliability (stress lane)')
md.push('')
md.push('Pilot and confirm are separate instance sets. They are not pooled. The confirm is partial: **23/54 valid**.')
md.push('')
md.push('## Arms')
md.push('')
md.push('| Campaign | Arm | Pass | Committed | Delivered | Cost-valid | Requests | Uncached input | Cache read | Output |')
md.push('|---|---|---|---|---|---|---|---|---|---|')
for (const campaign of [pilot, confirm]) {
  for (const arm of Object.keys(campaign.byArm).sort()) {
    const row = campaign.byArm[arm]
    md.push(`| ${campaign.name} | ${arm} | ${row.passed}/${row.cells} | ${row.committed} | ${row.delivered} | ${row.costValid}/${row.cells} | ${row.requests} | ${row.inputTokens} | ${row.cacheReadTokens} | ${row.outputTokens} |`)
  }
}
md.push('')
md.push('## Paired E1 − B0')
md.push('')
md.push('| Campaign | Pairs | Both | Neither | E1 only | B0 only | McNemar p | Recorded pass | Recorded requests | Recorded input | Recorded cache read | Recorded output | Cost-valid pairs | Cost-valid input | Cost-valid output |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const campaign of [pilot, confirm]) {
  const comparison = campaign.comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
  if (comparison === undefined) continue
  md.push(`| ${campaign.name} | ${comparison.pairs} | ${comparison.both} | ${comparison.neither} | ${comparison.leftOnly} | ${comparison.rightOnly} | ${comparison.mcnemarP} | ${comparison.recorded.pass} | ${comparison.recorded.requests} | ${comparison.recorded.inputTokens} | ${comparison.recorded.cacheReadTokens} | ${comparison.recorded.outputTokens} | ${comparison.costValid.pairs} | ${comparison.costValid.inputTokens} | ${comparison.costValid.outputTokens} |`)
}
md.push('')
md.push('`recorded` includes cells with partial usage; `cost-valid` keeps only pairs where both sides reported every request. Neither is a USD price.')
md.push('')
md.push('## Eligibility')
md.push('')
md.push('| Campaign | Valid | Unresolved | Never-started | Cost-invalid valid cells | Config-mismatch cells |')
md.push('|---|---|---|---|---|---|')
for (const campaign of [pilot, confirm]) {
  md.push(`| ${campaign.name} | ${campaign.valid} | ${campaign.unresolved} | ${campaign.neverStarted} | ${campaign.eligibility.costInvalid} | ${campaign.eligibility.configMismatchCells} |`)
}
md.push('')
md.push('## Missing by template (confirm)')
md.push('')
md.push(`\`${JSON.stringify(confirm.missingByTemplate)}\``)
md.push('')
md.push('T14-T16 have no valid confirm cells. The 23-cell valid subset is therefore task-type biased, not a random 23 of 54.')
md.push('')
md.push('## Stress lane vs shipped presets')
md.push('')
md.push('| Lane | Window | Retain | Framing | Hint | Data |')
md.push('|---|---|---|---|---|---|')
md.push(`| 16k stress | ${frontier.stressVsProduct.stress.contextWindow ?? '—'} | ${frontier.stressVsProduct.stress.retainRatio ?? '—'} | ${frontier.stressVsProduct.stress.framingMode ?? '—'} | ${frontier.stressVsProduct.stress.rationaleHintTokensEffective ?? '—'} effective (${frontier.stressVsProduct.stress.rationaleHintTokensDeclared ?? '—'} declared) | observed |`)
for (const [name, config] of Object.entries(frontier.stressVsProduct.productPresets)) {
  if (name === 'dataStatus' || name === 'note') continue
  md.push(`| ${name} | product-dependent | ${config.retainRatio ?? '—'} | ${config.framingMode ?? '—'} | ${config.rationaleHintTokens ?? '—'} | not executed |`)
}
md.push('')
md.push('## Exact-span economics')
md.push('')
if (frontier.spanEconomics === null) {
  md.push('The deterministic span matrix artifact is missing.')
} else {
  const span = frontier.spanEconomics
  md.push(`Deterministic keyless matrix: **${span.summary.cases}** cases. Widest span ${JSON.stringify(span.summary.widestObserved)}, executed span ${JSON.stringify(span.summary.executedObserved)}, gap ${JSON.stringify(span.summary.gaps)}.`)
  md.push('')
  md.push(`At the default reclaim floors: **${span.summary.falseAdmissions}** false admissions. Floor-sensitivity cases that put the floor between the two reclaims: **${span.summary.floorSensitivityFalseAdmissions}/3** flip to admission=true, execution=false.`)
  md.push('')
  md.push(`R2 live cells with an engine probe: **${frontier.probeAvailability.r2LiveCellsWithProbe}/${frontier.probeAvailability.r2LiveValidCells}**. The R2 reports predate the probe, so their exact-span economics is unavailable, not zero.`)
}
md.push('')
md.push('## Decision')
md.push('')
md.push('**No product candidate. Deployment Hold remains.**')
md.push('')
for (const reason of decision.reasons) md.push(`- ${reason}`)
md.push('')
md.push('This is not a claim that E1 is ineffective. It is a refusal to promote a candidate on a partial, task-biased, stress-lane, incomplete-cost sample.')
md.push('')
const mdPath = join(OUT, 'product-frontier.md')
writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8')

process.stdout.write(`product frontier: pilot ${pilot.valid} valid, confirm ${confirm.valid}/${confirm.planned} valid\n`)
for (const campaign of [pilot, confirm]) {
  const comparison = campaign.comparisons.find(entry => entry.left === 'E1' && entry.right === 'B0')
  process.stdout.write(`  ${campaign.name} E1-B0: pairs ${comparison?.pairs ?? 0}, pass ${comparison?.recorded.pass ?? '?'}, requests ${comparison?.recorded.requests ?? '?'}, input ${comparison?.recorded.inputTokens ?? '?'}, cache ${comparison?.recorded.cacheReadTokens ?? '?'}, output ${comparison?.recorded.outputTokens ?? '?'}; cost-valid pairs ${comparison?.costValid.pairs ?? 0}\n`)
}
process.stdout.write(`  user numbers: pilot ${JSON.stringify(frontier.userNumberVerification.pilot.matches)}, confirm ${JSON.stringify(frontier.userNumberVerification.confirm.matches)}\n`)
process.stdout.write(`  decision: ${decision.decision}; deploymentHold=${decision.deploymentHold}\n`)
process.stdout.write(`wrote ${jsonPath}, ${decisionPath}, ${mdPath}\n`)
