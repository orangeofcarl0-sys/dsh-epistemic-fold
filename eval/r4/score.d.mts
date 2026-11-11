export declare const SCORER_VERSION: string
export declare function exactMcNemar(b: number, c: number): number
export declare function taskOutcomeOf(input: { taskPass: boolean; finishCalled: boolean }): 'correct' | 'incorrect' | 'incomplete'
export declare function usageCompleteOf(requests: ReadonlyArray<{ usage?: { inputTokens?: number | null; outputTokens?: number | null } | null }>): boolean
export declare function scoreReport(input: {
  report: any
  task: any
  historicalPass: boolean
  fallback?: any
}): any
export declare function aggregate(cells: any[]): any
export declare function pair(cells: any[], left: string, right: string): any
