/**
 * Declarations for the plain-JS R33 evaluation libraries.
 *
 * The libraries are `.mjs` so the opt-in live runner can execute them without a
 * build step. The Vitest arms runner is TypeScript, so this file gives those
 * modules the surface it uses instead of weakening the project's strict
 * TypeScript settings for `eval/`.
 */

declare module '*/r33/src/canonical.mjs' {
  export function canonicalJson(value: unknown): string
  export function digestOf(value: unknown): string
  export function shortDigest(value: unknown): string
}

declare module '*/r33/src/dataset.mjs' {
  export const CASES_ROOT: string
  export const MANIFEST_PATH: string
  export const DATASET_ID: string
  export const HOLDOUT_ROOT: string
  export const HOLDOUT_MANIFEST_PATH: string
  export const HOLDOUT_ID: string
  export const DATASET_V1: string
  export const DATASET_V1_GIT: string
  export function readTree(root: string): Promise<Record<string, string>>
  export function listCaseIds(root?: string): Promise<string[]>
  export function loadCase(id: string, casesRoot?: string): Promise<any>
  export function loadDataset(): Promise<{ cases: any[]; errors: any[]; datasetDigest: string }>
  export function loadHoldoutDataset(): Promise<{ cases: any[]; errors: any[]; datasetDigest: string }>
  export function freezeDataset(now?: Date): Promise<any>
  export function freezeHoldout(now?: Date): Promise<any>
  export function verifyFrozen(manifestPath?: string): Promise<any>
  export function verifyHoldout(manifestPath?: string): Promise<any>
}

declare module '*/r33/src/context.mjs' {
  export function literalSummary(transcript: readonly any[]): string
  export function fullHistory(transcript: readonly any[]): string
  export function goldFactsBlock(gold: readonly any[], options?: { includeSuperseded?: boolean }): string
  export function goldEvidenceBlock(
    gold: readonly any[],
    transcript: readonly any[],
    options?: { includeSuperseded?: boolean },
  ): string
  export function withTask(context: string, task: string): string
  export function scriptedDecision(caseData: any, context: string): {
    action: string
    matchedProbe: string | null
    basis: string
  }
  export function followUpSystemPrompt(): string
}

declare module '*/r33/src/workspace.mjs' {
  export const ISOLATION_LEVEL: Record<string, string>
  export function childEnvironment(extras?: Record<string, string>): Record<string, string>
  export function materialize(files: Record<string, string>, root: string): Promise<void>
  export function materializeFresh(files: Record<string, string>, root: string): Promise<string>
  export function createReplicateLayout(input: {
    root: string
    runId: string
    caseId: string
    arm: string
    replicateId: string
  }): Promise<{
    base: string
    workspace: string
    session: string
    bundles: string
    journal: string
    trace: string
  }>
  export function applyAction(action: any, root: string): Promise<void>
  export function resolveInside(root: string, relativePath: string): Promise<string | undefined>
  export function readWorkspaceFile(
    root: string,
    path: string,
    cap?: number,
  ): Promise<{ ok: boolean; content?: string; truncated?: boolean; reason?: string }>
  export function writeWorkspaceFile(
    root: string,
    path: string,
    content: unknown,
  ): Promise<{ ok: boolean; reason?: string }>
  export function listWorkspace(
    root: string,
    options?: { limit?: number },
  ): Promise<{ text: string; truncated: boolean; entries: number }>
  export function runNode(args: string[], options?: any): Promise<{
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
    processError?: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
    durationMs: number
  }>
  export function runChecker(caseData: any, workspaceRoot: string, options?: any): Promise<any>
  export function runVisibleTests(workspaceRoot: string, timeoutMs?: number, options?: any): Promise<any>
  export function readVerification(workspaceRoot: string): Promise<any>
  export function relativePath(root: string, path: string): string
}

declare module '*/r33/src/grade.mjs' {
  export const SCORER_VERSION: number
  export const SCORER_V1_NOTE: string
  export function sourceBindings(caseData: any, eventSeqs?: readonly number[]): any[]
  export function extractionMetrics(caseData: any, input: any): any
  export function behaviourMetrics(caseData: any, input: any): any
  export function aggregateArm(arm: string, rows: readonly any[]): any
  export function compareTreatment(input: {
    rows: readonly any[]
    baselineArm: string
    treatmentArm: string
  }): any
  export function pairedBootstrap(
    rows: readonly any[],
    options?: {
      baselineArm?: string
      treatmentArm?: string
      clusterBy?: (row: any) => string
      iterations?: number
      seed?: number
    },
  ): any
}

declare module '*/r33/src/budget.mjs' {
  export const BUDGET_SCHEMA_VERSION: number
  export const RUN_STATUS: string[]
  export const STATUS_EXIT_CODE: Record<string, number>
  export class BudgetExhausted extends Error {
    reason: string
    code: string
    snapshot?: any
  }
  export class BudgetLedger {
    constructor(limits: any, options?: { maxRequestOutputTokens?: number })
    get limits(): any
    canReserve(estimate: any): string | undefined
    admit(requestReserve?: any): { id: number; inputTokens: number; outputTokens: number }
    settle(reservation: any): void
    release(reservation: any): void
    retry(reservation: any): void
    record(usage: any, fallback: any, reported: any, reservation: any): void
    reserve(estimate: any): { id: number; inputTokens: number; outputTokens: number }
    recordStream(input: any): void
    noteRetry(): void
    snapshot(): any
    elapsedMs(): number
  }
  export function snapshotDelta(before: any, after: any): any
  export function loadLiveGate(manifestPath: string | undefined, env?: Record<string, string | undefined>): Promise<any>
  export function runStatus(input: any): string
  export function runQuality(cases: readonly any[]): any
}
