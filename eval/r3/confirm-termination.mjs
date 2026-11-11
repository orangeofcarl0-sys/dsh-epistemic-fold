#!/usr/bin/env node
/**
 * EF-R3 — explicitly terminate the old 54-cell confirm as a stress-lane result.
 *
 * The confirm is not completed and will not be completed on its original
 * treatment: it is a 16k stress lane (retain 0.04, legacy framing, effective
 * hint 400), not the shipped preset. The 23 valid cells remain evidence; the
 * 1 unresolved and 30 never-started cells remain an explicit partial record.
 *
 * This is a decision artifact. It does not rewrite any historical result.
 *
 *   node eval/r3/confirm-termination.mjs
 *
 * @module eval/r3/confirm-termination
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const reconciliationPath = join(OUT, 'live-confirm-reconciliation.json')
const decisionPath = join(OUT, 'product-decision.json')
for (const path of [reconciliationPath, decisionPath]) {
  if (!existsSync(path)) {
    process.stderr.write(`confirm-termination: ${path} is missing\n`)
    process.exit(2)
  }
}
const reconciliation = readJson(reconciliationPath)
const corrected = reconciliation.corrected
const decision = readJson(decisionPath)

const output = {
  schemaVersion: 1,
  work: 'EF-R3 termination',
  generatedAt: new Date().toISOString(),
  campaign: 'e2e-r2-confirm-merged',
  decision: 'terminated-partial',
  status: 'closed',
  furtherLiveCalls: false,
  counts: {
    planned: 54,
    valid: corrected.valid,
    unresolved: corrected.unresolved,
    neverStarted: corrected.neverStarted,
    noValidOutcome: corrected.noValidOutcome,
    attempts: corrected.attempts,
    transportFailedAttempts: corrected.transportFailedAttempts,
  },
  missingByTemplate: corrected.missingByTemplate,
  reasons: [
    'The treatment is the 16k stress lane: retain 0.04, legacy framing, effective hint 400. It is not the shipped economy preset.',
    'The missing cells are task-type concentrated: T13=4, T14=9, T15=9, T16=9. Completing them would improve balance but would not make the treatment product-representative.',
    'The product question is native Basic vs the shipped preset, which this campaign cannot answer.',
    'The 23 valid cells and the corrected ledger remain the stress-lane evidence; no historical file is rewritten.',
  ],
  preservedEvidence: {
    reconciliation: { path: 'eval/r3/out/live-confirm-reconciliation.json', sha256: sha256(reconciliationPath) },
    productDecision: { path: 'eval/r3/out/product-decision.json', sha256: sha256(decisionPath) },
  },
  next: 'A separate product-lane pilot under a new manifest and authorization, after a representative transport health probe. The old confirm is not reopened.',
  note: 'Termination is a decision not to spend more live calls on a non-product treatment. It is not a claim that the missing cells would have failed.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'confirm-termination.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`confirm termination: ${output.decision}; ${output.counts.valid} valid, ${output.counts.unresolved} unresolved, ${output.counts.neverStarted} never-started; furtherLiveCalls=${output.furtherLiveCalls}\n`)
process.stdout.write(`wrote ${path}\n`)
