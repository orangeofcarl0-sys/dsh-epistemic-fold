/**
 * One vocabulary for "why did this row end the way it did".
 *
 * ## The defect this replaces
 *
 * R34 wrote a provider failure into `row.behaviourDetail.providerFailure` on
 * the normal path and into `row.providerFailures` on the exception path, then
 * asked `row.providerFailures?.length > 0` whether the provider was down. The
 * normal path therefore never satisfied the predicate: a run in which every
 * model call failed could still be reported as an ordinary negative task
 * result. Two shapes for one fact is the bug, not the missing field.
 *
 * ## The rule
 *
 * A row has FOUR independent axes:
 *
 *   measurement   did the harness produce a usable observation?
 *   task          did the agent solve the task, under its contract?
 *   provider      did the model/provider fail (and at which stage)?
 *   harness       did the benchmark itself break?
 *
 * They may co-occur. A provider failure means "not measured", never "the
 * agent failed". A failed hidden check means "the agent failed", never
 * "the harness broke". This module names the distinctions once.
 *
 * @module eval/r33/src/failures
 */

/** Terminal outcome for one case/arm row. */
export const OUTCOMES = [
  'valid-task-success',
  'valid-task-failure',
  'writer-only-measured',
  'writer-only-fold-invalid',
  'provider-unavailable',
  'provider-http-error',
  'provider-transport-error',
  'provider-protocol-error',
  'provider-aborted',
  'provider-error',
  'budget-exhausted',
  'fold-invalid',
  'checker-invalid',
  'checker-timeout',
  'checker-crashed',
  'harness-error',
]

/** Kinds that mean "the model route did not produce a usable response". */
export const PROVIDER_KINDS = new Set([
  'provider-unavailable',
  'provider-http-error',
  'provider-transport-error',
  'provider-protocol-error',
  'provider-aborted',
  'provider-error',
])

/**
 * Map a finish/protocol code onto the provider axis.
 *
 * `LIVE_TRANSPORT` and `LIVE_HTTP` come from the adapter. `UNSUPPORTED_CONTENT`
 * comes from `rationaleOnly` when a 200 carried no text: the provider answered,
 * so it is a protocol failure, not a transport failure. `BUDGET_EXHAUSTED` is
 * not a provider failure at all; it has its own axis.
 */
export function providerFailureKind(code) {
  switch (code) {
    case 'BUDGET_EXHAUSTED':
      return 'budget-exhausted'
    case 'LIVE_TRANSPORT':
      return 'provider-transport-error'
    case 'LIVE_HTTP':
      return 'provider-http-error'
    case 'UNSUPPORTED_CONTENT':
    case 'LIVE_PROTOCOL':
      return 'provider-protocol-error'
    case 'ABORTED':
      return 'provider-aborted'
    default:
      return 'provider-error'
  }
}

/** A provider failure record, with no credential and no invented detail. */
export function providerFailureRecord({ code, message, stage, writer = false }) {
  return {
    kind: providerFailureKind(code),
    code: String(code ?? 'unknown'),
    stage,
    writer: writer === true,
    message: String(message ?? ''),
  }
}

/** The empty four-axis record. */
export function emptyFailures() {
  return {
    provider: [],
    budget: [],
    fold: [],
    checker: [],
    harness: [],
    task: {
      /** False when no valid task measurement exists (provider failure, writer-only). */
      assessed: false,
      functionalFailure: null,
      historicalConstraintViolation: false,
      processViolation: false,
      falseVerificationClaim: false,
    },
  }
}

/** True when a row's only reason for invalidity is the provider route. */
export function rowIsProviderBlocked(row) {
  const failures = row?.failures
  if (failures === undefined) return false
  if (failures.provider.length === 0) return false
  if (failures.budget.length > 0) return false
  if (failures.fold.some(entry => entry.kind !== 'provider')) return false
  if (failures.checker.length > 0) return false
  if (failures.harness.length > 0) return false
  return true
}

/**
 * Resolve the row outcome from independent observations.
 *
 * Precedence is deliberate. A budget refusal outranks a provider failure
 * because the request never existed. A FATAL provider failure outranks a
 * failed check because the agent never got a working model. A checker fault
 * outranks task failure because the measurement itself is invalid.
 *
 * A non-fatal provider failure — a writer call that failed but whose fold
 * still committed a deterministic checkpoint — does NOT erase a valid task
 * outcome. It is recorded on the provider axis and reported as treatment
 * degradation; the row's task result remains measurable.
 */
export function classifyOutcome({
  stage = 'continuation',
  valid,
  foldValid,
  providerFailures = [],
  fatalProviderFailure = false,
  budgetExhausted = false,
  checkerStatus,
  behaviour,
  harnessError,
}) {
  if (harnessError !== undefined) return 'harness-error'
  if (budgetExhausted) return 'budget-exhausted'
  const providerOutcome = () => {
    const kinds = new Set(providerFailures.map(entry => entry.kind))
    if (kinds.has('provider-transport-error')) return 'provider-transport-error'
    if (kinds.has('provider-http-error')) return 'provider-http-error'
    if (kinds.has('provider-protocol-error')) return 'provider-protocol-error'
    if (kinds.has('provider-aborted')) return 'provider-aborted'
    if (kinds.has('provider-unavailable')) return 'provider-unavailable'
    return 'provider-error'
  }
  if (!foldValid) {
    if (fatalProviderFailure && providerFailures.length > 0) return providerOutcome()
    return 'fold-invalid'
  }
  if (stage === 'writer-only') return 'writer-only-measured'
  if (valid !== true) {
    if (fatalProviderFailure && providerFailures.length > 0) return providerOutcome()
    if (checkerStatus === 'checker-invalid') return 'checker-invalid'
    if (checkerStatus === 'checker-timeout') return 'checker-timeout'
    if (checkerStatus === 'checker-crashed') return 'checker-crashed'
    return 'harness-error'
  }
  return behaviour?.taskSuccess === true ? 'valid-task-success' : 'valid-task-failure'
}

/** Aggregate counts over the outcome strings, for a report. */
export function outcomeCounts(rows) {
  const counts = {}
  for (const row of rows) {
    const outcome = row?.failures?.outcome ?? 'harness-error'
    counts[outcome] = (counts[outcome] ?? 0) + 1
  }
  return counts
}
