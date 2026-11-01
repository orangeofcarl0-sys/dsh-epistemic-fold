/**
 * Declarations for the plain-JS R33 evaluation libraries.
 *
 * The libraries are `.mjs` so the opt-in live runner can execute them without a
 * build step. The Vitest arms runner is TypeScript, so this file gives those
 * modules the small surface it uses instead of weakening the project's strict
 * TypeScript settings for `eval/`.
 */

declare module '*/r33/lib/canonical.mjs' {
  export function canonicalJson(value: unknown): string
  export function digestOf(value: unknown): string
  export function shortDigest(value: unknown): string
}

declare module '*/r33/lib/dataset.mjs' {
  export const CASES_ROOT: string
  export const MANIFEST_PATH: string
  export const DATASET_ID: string
  export function readTree(root: string): Promise<Record<string, string>>
  export function listCaseIds(): Promise<string[]>
  export function loadCase(id: string): Promise<any>
  export function loadDataset(): Promise<{ cases: any[]; errors: any[]; datasetDigest: string }>
  export function freezeDataset(now?: Date): Promise<any>
  export function verifyFrozen(manifestPath?: string): Promise<any>
}

declare module '*/r33/lib/context.mjs' {
  export function literalSummary(transcript: readonly any[]): string
  export function fullHistory(transcript: readonly any[]): string
  export function goldFactsBlock(gold: readonly any[]): string
  export function goldEvidenceBlock(gold: readonly any[], transcript: readonly any[]): string
  export function withTask(context: string, task: string): string
  export function scriptedDecision(caseData: any, context: string): {
    action: string
    matchedProbe: string | null
    basis: string
  }
  export function followUpSystemPrompt(caseData: any): string
}

declare module '*/r33/lib/workspace.mjs' {
  export function materialize(files: Record<string, string>, root: string): Promise<void>
  export function applyAction(action: any, root: string): Promise<void>
  export function runNode(args: string[], options?: any): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
  }>
  export function runChecker(caseData: any, workspaceRoot: string): Promise<any>
  export function runVisibleTests(workspaceRoot: string, timeoutMs?: number): Promise<any>
  export function readVerification(workspaceRoot: string): Promise<any>
}

declare module '*/r33/lib/grade.mjs' {
  export function extractionMetrics(caseData: any, input: any): any
  export function behaviourMetrics(caseData: any, input: any): any
  export function aggregateArm(arm: string, rows: readonly any[]): any
  export function pairwise(rows: readonly any[], leftArm: string, rightArm: string): any
  export function pairedBootstrap(rows: readonly any[], leftArm: string, rightArm: string, options?: any): any
}

declare module '*/r33/lib/budget.mjs' {
  export const RUN_STATUS: string[]
  export const STATUS_EXIT_CODE: Record<string, number>
  export class BudgetExhausted extends Error {
    reason: string
  }
  export class BudgetLedger {
    constructor(limits: any)
    canReserve(estimate: any): string | undefined
    reserve(estimate: any): void
    record(input: any): void
    snapshot(): any
    elapsedMs(): number
  }
  export function loadLiveGate(manifestPath: string | undefined, env?: Record<string, string | undefined>): Promise<any>
  export function runStatus(input: any): string
}
