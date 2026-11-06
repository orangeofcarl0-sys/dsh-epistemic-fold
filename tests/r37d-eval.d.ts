declare module '*/r37d/src/operational-completion.mjs' {
  export const OPERATIONAL_SCHEMA_VERSION: number
  export const OPERATIONAL_SCORER_VERSION: string
  export function operationalContract(caseData: any): any
  export function assessVerificationArtifact(
    artifact: any,
    contract: any,
    testsExecuted: number,
  ): {
    present: boolean | null
    schemaValid: boolean | null
    claim: string | null
    claimSupported: boolean | null
    selfReportConsistent: boolean | null
    problems: string[]
  }
  export function classifyOperationalCompletion(input: any): any
}

declare module '*/r37d/src/action-accounting.mjs' {
  export const NO_VALID_ACTION_CLASSES: readonly string[]
  export function classifyNoValidAction(input: {
    text: string
    finishReason: string
    actions: any[]
    invalid: any[]
    diagnostics: any[]
    capped: boolean
  }): string | null
  export function accountTurn(input: {
    turn: { step?: number; text?: string; finishReason?: { kind?: string } }
    maxSteps: number
    index: number
  }): any
  export function summarizeCell(input: {
    cell: any
    turns: any[]
    detail?: any
    harness?: any
    verificationArtifact?: boolean | object | null
    requiresVerificationArtifact?: boolean
  }): any
}

declare module '*/r33/src/action-order.mjs' {
  export function splitFinishActions(actions: readonly any[]): {
    nonFinish: any[]
    finish: any | null
    finishPosition: number
  }
}

declare module '*/r33/src/schema.mjs' {
  export const CASE_SCHEMA_VERSION: number
  export function validateCase(raw: unknown):
    | { ok: true; case: any }
    | { ok: false; code: string; detail: string }
}
