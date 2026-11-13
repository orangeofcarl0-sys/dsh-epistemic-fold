#!/usr/bin/env node
/**
 * EF-R3 product-lane — exact-span admission candidate analysis.
 *
 * The audit records, per fold attempt, whether economic admission would admit
 * the WIDEST span and whether the same floors would admit the EXECUTED span.
 * This script quantifies the candidate rule ("admission must pass on the span
 * execution will fold") on the audited product-prelane tasks.
 *
 * It does not change the engine. It is a decision input: if the candidate
 * refuses only retries that already fail, it does not justify a default change;
 * if it would block a commit that reaches the threshold, it is a regression.
 *
 *   node eval/r3/admission-candidate.mjs
 *
 * @module eval/r3/admission-candidate
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const auditPath = join(OUT, 'product-lane-exposure-audit.json')
if (!existsSync(auditPath)) {
  process.stderr.write('admission-candidate: run eval/r3/product-lane-audit.mjs first\n')
  process.exit(2)
}
const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const cases = audit.cases.filter(entry => entry.probe !== null)
const falseAdmissions = cases.filter(entry => entry.probe.falseAdmission === true)
const candidateRefusals = cases.filter(entry => entry.probe.executionWouldAdmit === false)
const falseRefusals = cases.filter(entry => entry.probe.executionWouldAdmit === false
  && entry.leafFolds > 0
  && entry.outcome === 'returned-result')
const observedFutile = falseAdmissions.filter(entry => entry.outcome === 'threw')

const rows = falseAdmissions.map(entry => ({
  taskId: entry.taskId,
  arm: entry.arm,
  seedTokens: entry.seedTokens,
  leafFolds: entry.leafFolds,
  outcome: entry.outcome,
  error: entry.error,
  widestTokens: entry.probe.widest?.tokens ?? null,
  executedTokens: entry.probe.executed?.tokens ?? null,
  estimatedCheckpointTokens: entry.probe.estimatedCheckpointTokens,
  admissionWouldAdmit: entry.probe.admissionWouldAdmit,
  executionWouldAdmit: entry.probe.executionWouldAdmit,
}))

const output = {
  schemaVersion: 1,
  work: 'EF-R3 product-lane',
  generatedAt: new Date().toISOString(),
  input: { path: 'eval/r3/out/product-lane-exposure-audit.json', sha256: sha256(auditPath) },
  rule: 'Candidate admission uses the executed span (the span left after spec.retainTokens) rather than the widest legal span (retain 0).',
  counts: {
    auditedFoldCases: cases.length,
    falseAdmissions: falseAdmissions.length,
    candidateRefusals: candidateRefusals.length,
    falseRefusals: falseRefusals.length,
    observedFutileRetries: observedFutile.length,
  },
  falseAdmissions: rows,
  interpretation: {
    observed: falseAdmissions.length === 0
      ? 'No false admission on the audited product tasks.'
      : `The candidate would refuse ${falseAdmissions.length} attempt(s) that economic admission admitted on the widest span but execution could not fold. In the audit, all of them are the T16 retry after one committed fold; the current engine then throws instead of a successful reach.`,
    falseRefusals: falseRefusals.length === 0
      ? 'No audited case where the candidate would refuse a fold that actually reached the threshold.'
      : 'The candidate would refuse at least one fold that actually reached the threshold; this is a regression risk.',
    decision: falseRefusals.length > 0
      ? 'Do not adopt the candidate on this evidence.'
      : 'No default change is justified by this audit. The shipped preset should be tested as-is; if the pilot shows T16-like retry failures, add the candidate as a separate arm.',
  },
  limitations: [
    'The audit calls compactIfNeeded once per seeded surface with compactionRetries=1; it is not a full task run.',
    'The scripted summarizer returns a fixed checkpoint; checkpoint size is not the live model distribution.',
    'A candidate refusal changes the engine path to a rebase handoff; the final pressure after that handoff is not simulated here.',
  ],
  note: 'Analysis only. No engine behavior changed; the product lane tests the shipped preset.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'admission-candidate.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`admission candidate: ${cases.length} audited fold cases; false admissions ${falseAdmissions.length}; candidate refusals ${candidateRefusals.length}; false refusals ${falseRefusals.length}\n`)
for (const row of rows) {
  process.stdout.write(`  ${row.taskId}/${row.arm}: widest ${row.widestTokens}, executed ${row.executedTokens}, folds ${row.leafFolds}, outcome ${row.outcome}\n`)
}
process.stdout.write(`  decision: ${output.interpretation.decision}\n`)
process.stdout.write(`wrote ${path}\n`)
