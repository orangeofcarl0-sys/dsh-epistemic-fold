export declare const CANDIDATE: string
export declare function planTaskDelivery(input: {
  requests: Array<{ index: number; status: 'exact' | 'marker-only' | 'absent' | 'unknown' }>
  prompt: string
  sourceSeq?: number | null
  sourceDigest?: string | null
  maxRedeliveries?: number
}): {
  candidate: string
  authority: string
  notASummary: boolean
  mutatesFold: boolean
  pinsSurface: boolean
  sourceSeq: number | null
  sourceDigest: string | null
  promptChars: number
  maxRedeliveries: number
  deliveries: Array<{ request: number; status: string; kind: string; sourceSeq: number | null; sourceDigest: string | null; chars: number }>
  addedChars: number
  rows: Array<{ index: number; status: string; deliver: boolean; reason: string }>
}
