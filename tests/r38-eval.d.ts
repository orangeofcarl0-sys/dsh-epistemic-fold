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

declare module '*/r38/working-set-ablation.mjs' {
  export interface AblationRow {
    readonly id: string
    readonly description: string
    readonly budget: number
    readonly anchors: number
    readonly greedy: { readonly aTokens: number; readonly abTokens: number; readonly acTokens: number } | null
    readonly s0: {
      readonly selected: readonly string[]
      readonly selectedCount: number
      readonly criticalVisible: number
      readonly criticalTotal: number
      readonly negativeKnowledgeVisible: number
      readonly negativeKnowledgeTotal: number
      readonly unrelatedSelected: number
      readonly unrelatedTokens: number
      readonly scopePrecision: number
      readonly tokens: number
      readonly contentTokens?: number
      readonly bodyOverBudget: boolean
      readonly pinnedOverflow: boolean
      readonly omitted: number
      readonly stable: boolean
    }
    readonly s1: {
      readonly selected: readonly string[]
      readonly selectedCount: number
      readonly criticalVisible: number
      readonly criticalTotal: number
      readonly negativeKnowledgeVisible: number
      readonly negativeKnowledgeTotal: number
      readonly unrelatedSelected: number
      readonly unrelatedTokens: number
      readonly scopePrecision: number
      readonly tokens: number
      readonly contentTokens: number
      readonly bodyOverBudget: boolean
      readonly pinnedOverflow: boolean
      readonly omitted: number
      readonly stable: boolean
      readonly unresolvedCoverage: readonly string[]
      readonly retrievalCandidates: number
      readonly scores: Readonly<Record<string, number>>
      readonly reasons: Readonly<Record<string, readonly string[]>>
    }
    readonly invariants: {
      readonly disjoint: boolean
      readonly complete: boolean
      readonly pinnedAllSelected: boolean
    }
    readonly delta: {
      readonly criticalVisible: number
      readonly negativeKnowledgeVisible: number
      readonly unrelatedTokens: number
      readonly scopePrecision: number
    }
  }
  export function runAblation(): readonly AblationRow[]
}

declare module '*/r38/archive-recovery-ablation.mjs' {
  export interface RecoveryRow {
    readonly id: string
    readonly description: string
    readonly terms: readonly string[]
    readonly criticalTerm: string
    readonly coverage: { readonly s0: boolean; readonly s1: boolean; readonly s2: boolean }
    readonly recovery: {
      readonly status: string
      readonly recovered: number
      readonly inspectedCheckpoints: readonly string[]
      readonly searchOperations: number
      readonly exactPages: number
      readonly returnedChars: number
      readonly returnedTokens: number
      readonly truncated: boolean
      readonly notes: readonly string[]
    }
    readonly metrics: {
      readonly criticalCoverage: { readonly s0: boolean; readonly s1: boolean; readonly s2: boolean }
      readonly archiveOnlyRescue: boolean
      readonly falseRetrieval: number
      readonly scopeCorrect: number
      readonly scopeCorrectness: number
      readonly tokenOverhead: number
      readonly s0Tokens: number
      readonly s1Tokens: number
      readonly s2Tokens: number
      readonly retrievalCost: number
    }
    readonly bounds: Readonly<Record<string, boolean>>
    readonly authority: {
      readonly recoveredIsArchive: boolean
      readonly stateDigestUnchanged: boolean
      readonly stateUnchangedFlag: boolean
    }
  }
  export function runAblation(): Promise<readonly RecoveryRow[]>
}
