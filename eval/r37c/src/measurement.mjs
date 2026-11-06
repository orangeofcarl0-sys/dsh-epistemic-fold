/**
 * R37-C0-C: measurement status is not pipeline outcome.
 *
 * R37-B used one `valid` flag for both. A fold refusal is an observable
 * product-pipeline result and must stay in the assigned-arm denominator. A
 * provider transport failure before any action is a censored measurement and
 * is reported separately. This module names the two axes independently.
 *
 * @module eval/r37c/src/measurement
 */

export const MEASUREMENT_STATUSES = [
  'valid',
  'provider-invalid',
  'budget-censored',
  'trace-incomplete',
  'scorer-invalid',
  'unknown',
]

export const PIPELINE_OUTCOMES = [
  'semantic-committed',
  'controlled-oracle-facts',
  'fold-refused',
  'full-history-fallback',
  'no-packet',
  'empty-commit',
  'protocol-failed',
  'not-applicable',
  'other',
]

const PROVIDER_KINDS = new Set([
  'provider-transport-error',
  'provider-auth',
  'provider-rate-limit',
  'provider-timeout',
  'provider-response-invalid',
])

const BUDGET_KINDS = new Set([
  'budget-exhausted',
  'budget-refused',
  'request-cap',
  'input-token-cap',
  'output-token-cap',
  'wall-clock-cap',
])

function failureKinds(row) {
  return {
    provider: (row.failures?.provider ?? []).map(entry => entry.kind).filter(Boolean),
    budget: (row.failures?.budget ?? []).map(entry => entry.kind).filter(Boolean),
    checker: (row.failures?.checker ?? []).map(entry => entry.kind).filter(Boolean),
    harness: (row.failures?.harness ?? []).map(entry => entry.kind).filter(Boolean),
  }
}

/**
 * Classify why a row can or cannot be scored.
 *
 * A fold refusal is deliberately NOT a measurement failure: the fold ran and
 * produced an observable refusal. A missing trace or an unparsable scorer
 * output is a measurement failure.
 */
export function measurementStatus(row, options = {}) {
  if (row.measurementValid === true && row.valid === true) return 'valid'
  const kinds = failureKinds(row)
  if (kinds.provider.some(kind => PROVIDER_KINDS.has(kind))
    || row.failures?.outcome === 'provider-transport-error') return 'provider-invalid'
  if (kinds.budget.some(kind => BUDGET_KINDS.has(kind))) return 'budget-censored'
  if (options.tracePresent === false) return 'trace-incomplete'
  if (kinds.checker.length > 0) return 'scorer-invalid'
  if (row.failures?.outcome === 'fold-invalid'
    || row.fold?.valid === false
    || (row.failures?.fold ?? []).some(entry => entry.kind === 'fold-refused')) return 'valid'
  if (row.measurementValid === false) return 'unknown'
  return row.valid === true ? 'valid' : 'unknown'
}

/**
 * Classify what the pipeline actually delivered, independent of scoring.
 */
export function pipelineOutcome(row, options = {}) {
  const arm = row.arm
  if (arm === 'B1') return 'not-applicable'
  if (arm === 'O2') return 'not-applicable'
  const fixture = row.fixture
  if (fixture !== undefined && fixture !== null) return 'controlled-oracle-facts'
  if (row.foldFallback === 'full-history') return 'full-history-fallback'
  if (row.fold?.valid === false) return 'fold-refused'
  if (row.fold?.valid !== true) return 'no-packet'
  if ((row.state?.commits ?? 0) === 0) {
    if (row.writer?.commitStatus === 'protocol-not-parsed') return 'protocol-failed'
    if (row.writer?.commitStatus === 'nothing-accepted') return 'no-packet'
    return 'no-packet'
  }
  const anchors = Array.isArray(row.state?.anchors) ? row.state.anchors.length : 0
  if (anchors === 0) return 'empty-commit'
  if (row.writer?.commitStatus === 'committed') return 'semantic-committed'
  if (row.writer?.commitStatus === 'fold-refused') return 'fold-refused'
  if (row.writer?.commitStatus === 'protocol-not-parsed') return 'protocol-failed'
  if (row.writer?.commitStatus === 'nothing-accepted') return 'no-packet'
  if (options.writerOnly === true && row.writer?.commitStatus === 'committed') return 'semantic-committed'
  return 'other'
}

export function classifyRow(row, options = {}) {
  const measurement = measurementStatus(row, options)
  return {
    measurement,
    pipeline: pipelineOutcome(row, options),
    assignedArm: row.arm,
    scored: measurement === 'valid',
  }
}

/**
 * Assigned-arm (intention-to-treat) denominators.
 *
 * Provider-invalid rows are censored; they are not task failures and not
 * product successes. Fold refusals and fallbacks stay in the denominator.
 */
export function assignedArmSummary(rows) {
  const byArm = {}
  for (const row of rows) {
    const arm = row.arm
    const entry = byArm[arm] ?? {
      rows: 0,
      valid: 0,
      providerInvalid: 0,
      budgetCensored: 0,
      pipeline: {},
      contractSuccesses: 0,
      taskSuccesses: 0,
    }
    entry.rows += 1
    const status = measurementStatus(row)
    if (status === 'valid') entry.valid += 1
    else if (status === 'provider-invalid') entry.providerInvalid += 1
    else if (status === 'budget-censored') entry.budgetCensored += 1
    const outcome = pipelineOutcome(row)
    entry.pipeline[outcome] = (entry.pipeline[outcome] ?? 0) + 1
    if (row.behaviour?.contractSuccess === true) entry.contractSuccesses += 1
    if (row.behaviour?.taskSuccess === true) entry.taskSuccesses += 1
    byArm[arm] = entry
  }
  return byArm
}
