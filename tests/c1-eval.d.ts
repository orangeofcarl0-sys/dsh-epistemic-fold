/**
 * Module declarations for the EF-C1 gate script, so the gate test can import it
 * under `tsc --noEmit` without turning the module into `any`.
 */

declare module '*/c1/gates.mjs' {
  export interface C1TestResult {
    readonly success: boolean
    readonly numFailedTests: number
    readonly numPassedTests: number
    readonly numTotalTests: number
  }

  export interface C1Gate {
    readonly id: string
    readonly name: string
    readonly status: 'passed' | 'failed' | 'blocked' | 'not-executed' | 'not-verifiable'
    readonly detail: string
    readonly evidence: string
  }

  export interface C1Eligibility {
    readonly evaluated: number
    readonly passed: number
    readonly failed: number
    readonly nonPass: number
    readonly stageComplete: boolean
    readonly failedIds: readonly string[]
    readonly nonPassIds: readonly string[]
  }

  export interface C1GateEvaluation {
    readonly gates: readonly C1Gate[]
    readonly eligibility: C1Eligibility
    readonly decisions: {
      readonly coreReleaseEligible: boolean
      readonly coreReleaseReason: string
      readonly semanticActiveEligible: boolean
      readonly semanticActiveReason: string
    }
    readonly product: {
      readonly deploymentEligible: boolean
      readonly decision: string
    }
  }

  export function evaluateGates(options?: { readonly testsOverride?: C1TestResult }): C1GateEvaluation
  export function exitCodeFor(eligibility: { readonly failed: number; readonly nonPass: number }): number
  export function runGates(): { readonly report: C1GateEvaluation; readonly exitCode: number }
}
