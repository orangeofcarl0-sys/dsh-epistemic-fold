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
