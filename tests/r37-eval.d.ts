/**
 * Declarations for the plain-JS R37 evaluation libraries.
 *
 * The R37 scripts are `.mjs` so they can run without a build step. The tests
 * are TypeScript; these declarations expose only the surfaces the tests use.
 */

declare module '*/r37/src/evidence.mjs' {
  export const ARMS: readonly string[]
  export const REQUIRED_TOOLS: Set<string>
  export function digestText(text: unknown): string
  export function renderedContext(arm: string, caseData: any, checkpoint: string): string
  export function actualDelivery(row: any): string
  export function deliveryIsFallback(delivery: string): boolean
  export function factFunnel(caseData: any, row: any, trace: any): any
  export function replayToolTurns(trace: any): any
  export function firstObservableFailure(input: {
    caseData: any
    row: any
    trace: any
    replay: any
    workspace: any
  }): any
  export function outcomeClass(row: any): { classification: string; actionConsistency: string }
  export function pairOutcome(
    baseline: any,
    treatment: any,
    selector: (row: any) => boolean,
  ): string
}

declare module '*/r37/src/io.mjs' {
  export function posix(value: string): string
  export function sha256(value: string | Uint8Array): string
  export function sha256File(path: string): Promise<string>
  export function canonicalJson(value: unknown): string
  export function digestOf(value: unknown): string
  export function exists(path: string): Promise<boolean>
  export function readJson(path: string): Promise<any>
  export function writeJson(path: string, value: unknown): Promise<void>
  export function walkFiles(root: string): Promise<string[]>
  export function treeManifest(root: string): Promise<any>
  export function fileManifest(root: string, paths: readonly string[]): Promise<any>
}

declare module '*/r37/src/tool-protocol-r37.mjs' {
  export const MAX_ACTIONS_PER_TURN: number
  export const TOOLS: Set<string>
  export const LAYERS: readonly string[]
  export function decodeDsmlAttribute(value: string): string
  export function scanEmitted(text: string): any
  export function parseJsonLayer(text: string, multi: boolean): any[]
  export function parseDsmlLayer(text: string, options: any): { actions: any[]; rejected: any[] }
  export function analyzeTurn(text: string, layer: string, source?: string): any
  export function analyzeTurnLayers(text: string, source?: string): any
}
