/**
 * Oracle applicability by arm (R0-C): which oracles a given arm can satisfy.
 * The keyless tier (work-order §10) proves infrastructure determinism; the B1
 * arm carries no EF state projection and no EF checkpoint bundles, so
 * state-based and EF-recall oracles are reported as not-applicable for it
 * rather than as failures.
 *
 * @module eval/arm-scope
 */

/** Oracles backed by the deterministic EF current state. */
export function isStateOracle(type: string): boolean {
  return type === 'anchor-active'
    || type === 'state-key-equals'
    || type === 'failure-open'
    || type === 'failure-retired'
    || type === 'obligation-open'
    // EF checkpoint recovery: Basic checkpoints carry no EF bundle, so
    // exact/structured recall of EF checkpoint ids is EF-arm-only.
    || type === 'recall-contains'
}

/** Oracle types that only an EF arm can satisfy (state + EF recall tooling). */
export function isEfOnlyOracle(oracle: { type: string; family?: string }): boolean {
  return isStateOracle(oracle.type)
    || (oracle.type === 'tool-action-present' && oracle.family === 'recall')
}
