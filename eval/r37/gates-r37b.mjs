#!/usr/bin/env node
/**
 * R37-B Stage 1 gates.
 *
 * These gates answer one question only: is the live measurement floor good
 * enough to justify the Stage 2 confirmatory batch? They do not turn Stage 1
 * into a product result. A missing or provider-invalid cell is reported as
 * partial/blocked, never as a task failure or a pass.
 *
 * @module eval/r37/gates-r37b
 */

import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from './src/io.mjs'
import { exitCodeFor, machineProductOutcome } from '../r37c/src/gate-exit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.R37B_GATES_OUT === undefined
  ? join(HERE, 'out', 'gate-status-r37b.json')
  : process.env.R37B_GATES_OUT
const resultsPath = process.env.R37B_RESULTS === undefined
  ? join(HERE, 'out', 'r37b-results.json')
  : process.env.R37B_RESULTS
const results = await readJson(resultsPath)
const evidencePath = process.env.R37B_RESULTS === undefined
  ? 'eval/r37/out/r37b-results.json'
  : process.env.R37B_RESULTS
const PAIR_EXPECTED = Number(process.env.R37B_PAIR_EXPECTED ?? 24)
const REP_EXPECTED = Number(process.env.R37B_REP_EXPECTED ?? 24)
const O2_MIN_VALID = Number(process.env.R37B_O2_MIN_VALID ?? 20)
const STAGE = Number(process.env.R37B_STAGE_NUMBER ?? 1)
const RESEARCHER_DECISION = process.env.R37B_PRODUCT_DECISION ?? null

const writer = results.writer?.byPrompt ?? {}
const o2 = results.o2 ?? { rows: 0, valid: 0, contractSuccesses: 0, taskSuccesses: 0 }
const e2e = results.e2e ?? { pairs: 0, contract: {} }
const representation = results.representation ?? { rows: 0, cells: {} }
const protocol = results.protocol ?? {}
const cost = results.cost ?? {}

const writerOk = (writer.W1?.attempts ?? 0) >= 24
  && (writer.W0?.attempts ?? 0) >= 24
  && (writer.W1?.parsed ?? 0) > (writer.W0?.parsed ?? 0)
  && (writer.W1?.commitRecall ?? 0) > (writer.W0?.commitRecall ?? 0)
const writerStatus = writerOk
  ? 'passed'
  : ((writer.W1?.attempts ?? 0) === 0 ? 'not-executed' : 'partial')

const o2Rate = o2.valid === 0 ? 0 : o2.contractSuccesses / o2.valid
const o2Ok = o2.valid >= O2_MIN_VALID && o2Rate >= 4 / 6
const o2Status = o2Ok ? 'passed' : (o2.valid === 0 ? 'not-executed' : 'partial')

const repRows = representation.rows ?? 0
const repValid = Object.values(representation.cells ?? {})
  .reduce((total, cell) => total + (cell.valid ?? 0), 0)
const repExpected = REP_EXPECTED
const repOk = repRows >= repExpected && repValid >= repExpected - 4
const repStatus = repRows === 0 ? 'not-executed' : (repOk ? 'passed' : 'partial')

const pairCount = e2e.pairs ?? 0
const pairExpected = PAIR_EXPECTED
const e2eValid = pairCount
const e2eOk = pairCount >= pairExpected
const e2eStatus = pairCount === 0 ? 'not-executed' : (e2eOk ? 'passed' : 'partial')

const treatmentDeliveries = (e2e.pairsDetail ?? [])
  .filter(pair => pair.valid === true)
  .map(pair => pair.treatment?.delivery)
const determined = treatmentDeliveries.filter(delivery =>
  delivery === 'semantic-committed' || delivery === 'full-history-fallback').length
const deliveryRate = treatmentDeliveries.length === 0 ? null : determined / treatmentDeliveries.length
const deliveryOk = deliveryRate !== null && deliveryRate >= 0.8
const deliveryStatus = treatmentDeliveries.length === 0 ? 'not-executed' : (deliveryOk ? 'passed' : 'partial')

let statistics = null
try {
  statistics = await readJson(join(HERE, 'out', 'r37b-stage2-statistics.json'))
} catch {
  statistics = null
}
const machineOutcome = STAGE === 2 && statistics !== null
  ? machineProductOutcome({
    rescue: e2e.contract?.rescue ?? 0,
    damage: e2e.contract?.damage ?? 0,
    p: statistics.contract?.p ?? null,
    deliveryRate,
  })
  : 'not-applicable'

const protocolOk = Array.isArray(protocol.toolProtocols)
  && protocol.toolProtocols.includes('P3e')
  && protocol.unparsedTurnRate !== null
  && protocol.unparsedTurnRate <= 0.10
const protocolStatus = protocol.rows === 0 ? 'not-executed' : (protocolOk ? 'passed' : 'partial')

const stage1Complete = [writerStatus, o2Status, repStatus, e2eStatus, deliveryStatus, protocolStatus]
  .every(status => status === 'passed')

const gates = [
  {
    id: 'R37B-W',
    name: 'Writer Pilot',
    status: writerStatus,
    detail: `W0 ${writer.W0?.parsed}/${writer.W0?.attempts} parsed, recall ${writer.W0?.commitRecall}; `
      + `W1 ${writer.W1?.parsed}/${writer.W1?.attempts} parsed, recall ${writer.W1?.commitRecall}; `
      + `${writer.W1?.accepted ?? 0} accepted / ${writer.W1?.refused ?? 0} refused`,
    evidence: `${evidencePath}#writer`,
  },
  {
    id: 'R37B-O2',
    name: 'O2 Floor Under P3e',
    status: o2Status,
    detail: `valid ${o2.valid}/${o2.rows}; contract ${o2.contractSuccesses}/${o2.valid} `
      + `(${(o2Rate * 100).toFixed(1)}%); task ${o2.taskSuccesses}/${o2.valid}`,
    evidence: `${evidencePath}#o2`,
  },
  {
    id: 'R37B-P',
    name: 'P3e Protocol',
    status: protocolStatus,
    detail: `${protocol.validActions ?? 0} valid actions, ${protocol.rejectedActions ?? 0} rejected, `
      + `invalid-action rate ${protocol.rejectionRate}; unparsed-turn rate ${protocol.unparsedTurnRate}; `
      + `reasons ${JSON.stringify(protocol.rejectedReasons ?? {})}; diagnostics ${JSON.stringify(protocol.diagnostics ?? {})}`,
    evidence: `${evidencePath}#protocol`,
  },
  {
    id: 'R37B-R',
    name: 'Controlled Representation',
    status: repStatus,
    detail: `${repValid}/${repExpected} expected cells valid; rows ${repRows}; `
      + `B2 ${['FP', 'FS', 'FN'].map(arm => `${arm} ${representation.byCase?.B2?.byArm?.[arm]?.contract ?? 0}/${representation.byCase?.B2?.byArm?.[arm]?.rows ?? 0}`).join(', ')}; `
      + `C1 ${['FP', 'FS', 'FH'].map(arm => `${arm} ${representation.byCase?.C1?.byArm?.[arm]?.contract ?? 0}/${representation.byCase?.C1?.byArm?.[arm]?.rows ?? 0}`).join(', ')}`,
    evidence: `${evidencePath}#representation`,
  },
  {
    id: 'R37B-E2E',
    name: 'Assigned-Arm B1/S Pairs',
    status: e2eStatus,
    detail: `${pairCount}/${pairExpected} pairs; contract ${JSON.stringify(e2e.contract)}; `
      + `task ${JSON.stringify(e2e.task)}`,
    evidence: `${evidencePath}#e2e`,
  },
  {
    id: 'R37B-D',
    name: 'Delivery Determination',
    status: deliveryStatus,
    detail: `${determined}/${treatmentDeliveries.length} S rows with determined delivery `
      + `(${deliveryRate === null ? 'n/a' : `${(deliveryRate * 100).toFixed(1)}%`})`,
    evidence: `${evidencePath}#e2e.pairsDetail`,
  },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-B',
  stage: STAGE,
  status: stage1Complete ? (STAGE === 2 ? 'stage-2-complete' : 'stage-1-complete') : (STAGE === 2 ? 'stage-2-incomplete' : 'stage-1-incomplete'),
  stage2: STAGE === 2 ? (stage1Complete ? 'confirmatory-batch-complete' : 'confirmatory-batch-incomplete') : (stage1Complete ? 'ready-for-stage-2' : 'blocked-on-stage-1'),
  productDecision: machineOutcome,
  researcherDecision: RESEARCHER_DECISION,
  decisionAgreement: RESEARCHER_DECISION === null ? null : RESEARCHER_DECISION === machineOutcome,
  exploratory: STAGE !== 2,
  gates,
  cost: {
    ...cost,
    note: 'Invalid transport attempts are counted in cost and excluded from the deduplicated outcome rows.',
  },
  notes: [
    STAGE === 2
      ? 'Stage 2 is the confirmatory batch under R37_B_PREREGISTRATION_AMENDMENT A1; Stage 1 is not pooled.'
      : 'Stage 1 is exploratory under R37_B_PREREGISTRATION_AMENDMENT A1.',
    'A partial or provider-invalid gate is not a task failure and is not a pass.',
    STAGE === 2
      ? 'The machine product outcome is a signal under this model/route/harness, not a population estimate.'
      : 'Stage 2 remains unstarted; no confirmatory claim is made.',
    'A researcher decision is recorded separately from the machine outcome; it never replaces the computed gates.',
    'Exit 2 means the stage is not eligible because a gate is partial/not-executed/blocked/gate-not-verifiable.',
  ],
}
await writeJson(OUT, report)
for (const gate of gates) {
  process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
}
process.stdout.write(`stage1: ${report.status}; stage2: ${report.stage2}; product ${report.productDecision}\n`)
process.exit(exitCodeFor(gates))
