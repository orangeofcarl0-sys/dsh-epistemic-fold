export const DSML: string
export const TOOLS: ReadonlySet<string>
export const DIRECT_PARAMETERS: ReadonlySet<string>
export const PARAMETER_NAMES: ReadonlySet<string>
export function encodeDsmlAttribute(value: any): string
export function decodeDsmlAttribute(value: any): string
export function readDsmlTag(text: string, start: number): any
export function parseDsmlStrict(text: string): any
export function validateAction(action: any): any[]
export function analyzeTurnStrict(text: string, source?: string): any
export function encodeDirectWrite(input: any): string
export function encodeParameterWrite(input: any): string
export const FIDELITY_SAMPLES: readonly string[]
