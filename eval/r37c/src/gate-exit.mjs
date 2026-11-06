/**
 * R37-C0-D: strict gate exit semantics.
 *
 * A gate report is not a pass just because it was written. Automated entry
 * points must distinguish:
 *
 *   evaluated       the gate produced a status
 *   passed          the gate's criterion is satisfied
 *   eligible        every required gate passed, so the next stage may start
 *
 * Exit codes:
 *   0  all required gates passed
 *   1  at least one gate failed
 *   2  no failure, but at least one gate is partial/not-executed/blocked/
 *      gate-not-verifiable, so the stage is not eligible
 *
 * @module eval/r37c/src/gate-exit
 */

export const NON_PASS_STATUSES = new Set([
  'partial',
  'not-executed',
  'blocked',
  'gate-not-verifiable',
  'ready-for-authorization',
  'incomplete',
  'unknown',
])

export function gateEvaluation(gates) {
  const failed = gates.filter(gate => gate.status === 'failed')
  const nonPass = gates.filter(gate => NON_PASS_STATUSES.has(gate.status))
  return {
    evaluated: gates.length,
    passed: gates.filter(gate => gate.status === 'passed').length,
    failed: failed.length,
    nonPass: nonPass.length,
    eligible: failed.length === 0 && nonPass.length === 0,
    failedIds: failed.map(gate => gate.id),
    nonPassIds: nonPass.map(gate => gate.id),
  }
}

export function exitCodeFor(gates) {
  const evaluation = gateEvaluation(gates)
  if (evaluation.failed > 0) return 1
  if (evaluation.nonPass > 0) return 2
  return 0
}

/**
 * Machine product outcome, separate from a researcher's written decision.
 *
 * This is deliberately narrow: it only reports the preregistered benefit
 * criterion and the observed harm direction. It does not turn a small pilot
 * into a product claim.
 */
export function machineProductOutcome({ rescue, damage, p, deliveryRate, threshold = 0.05 }) {
  if (rescue > damage && typeof p === 'number' && p < threshold
    && typeof deliveryRate === 'number' && deliveryRate >= 0.8) {
    return 'active-benefit-signal'
  }
  if (damage > rescue && typeof p === 'number' && p < threshold) return 'active-harm-signal'
  return 'insufficient-evidence'
}
