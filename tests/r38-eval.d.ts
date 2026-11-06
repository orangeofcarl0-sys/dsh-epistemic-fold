declare module '*/r38/integrity-audit.mjs' {
  export interface IntegrityCaseResult {
    readonly id: string
    readonly description: string
    readonly expectedCodes: readonly string[]
    readonly forbiddenCodes: readonly string[]
    readonly actualCodes: readonly string[]
    readonly counts: Readonly<Record<'blocking' | 'requires-review' | 'informational', number>>
    readonly anchors: number
    readonly activeAnchors: number
    readonly relations: number
    readonly findings: readonly {
      readonly code: string
      readonly severity: 'blocking' | 'requires-review' | 'informational'
      readonly anchorIds: readonly string[]
      readonly detail: string
      readonly evidence?: Readonly<Record<string, unknown>>
    }[]
    readonly pass: boolean
    readonly missing: readonly string[]
    readonly forbidden: readonly string[]
    readonly wrongSeverity: readonly { readonly code: string; readonly expected: string }[]
  }
  export function buildCases(): readonly unknown[]
  export function runCases(): readonly IntegrityCaseResult[]
}
