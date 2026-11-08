/**
 * Module declarations for the EF-C0 gate script, so the convergence test can
 * import it under `tsc --noEmit` without turning the whole module into `any`.
 */

declare module '*/c0/gates.mjs' {
  export interface C0TestResult {
    readonly success: boolean
    readonly numFailedTests: number
    readonly numPassedTests: number
    readonly numTotalTests: number
  }

  export interface C0Gate {
    readonly id: string
    readonly name: string
    readonly status: 'passed' | 'failed' | 'blocked' | 'not-executed' | 'not-verifiable'
    readonly detail: string
    readonly evidence: string
  }

  export interface C0Eligibility {
    readonly evaluated: number
    readonly passed: number
    readonly failed: number
    readonly nonPass: number
    readonly eligible: boolean
    readonly failedIds: readonly string[]
    readonly nonPassIds: readonly string[]
  }

  export interface C0GateEvaluation {
    readonly gates: readonly C0Gate[]
    readonly eligibility: C0Eligibility
  }

  export function evaluateGates(options?: { readonly testsOverride?: C0TestResult }): C0GateEvaluation
  export function exitCodeFor(eligibility: C0Eligibility): number
  export function runGates(): { readonly report: unknown; readonly exitCode: number }
}
