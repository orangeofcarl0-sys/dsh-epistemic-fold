export declare function sectionOf(text: string, header: string): string
export declare function failureRows(checkpointText: string): {
  open: string
  rows: Array<{ id: string; state: string; value: string; callId: string }>
}
export declare function pathOf(argsText: string | null | undefined): string | null
export declare function errorClassOf(text: string | null | undefined): string
