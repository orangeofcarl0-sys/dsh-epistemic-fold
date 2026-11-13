/**
 * EF-R4 WP5 candidate — bounded replay of the exact active task source.
 *
 * This is a CONTRACT, not a wired policy. It never edits a fold, never pins a
 * surface position and never synthesises prose. A host that chose to use it
 * would put the ORIGINAL user event bytes (with their seq and digest) into the
 * next request projection when the source is no longer resident.
 *
 * The candidate exists because the R3 pilot recorded the exact source absent
 * after a fold in 7 of 8 EF failures, and no write in those cells. It is
 * bounded by `maxRedeliveries` and carries no authority of its own.
 *
 * @module eval/r4/candidate/active-task-delivery
 */

export const CANDIDATE = 'active-task-delivery'

/**
 * @param {object} input
 * @param {Array<{index:number,status:'exact'|'marker-only'|'absent'|'unknown'}>} input.requests
 * @param {string} input.prompt - the exact task prompt, not a summary.
 * @param {number|null} input.sourceSeq - the original user event seq.
 * @param {string|null} input.sourceDigest - digest of the original event content.
 * @param {number} [input.maxRedeliveries] - hard bound; the default is two.
 */
export function planTaskDelivery({
  requests,
  prompt,
  sourceSeq = null,
  sourceDigest = null,
  maxRedeliveries = 2,
}) {
  const bound = Number.isInteger(maxRedeliveries) && maxRedeliveries >= 0 ? maxRedeliveries : 2
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0
  const rows = []
  const deliveries = []
  let seenExact = false
  let used = 0
  for (const request of requests ?? []) {
    if (request.status === 'exact') {
      seenExact = true
      rows.push({ index: request.index, status: request.status, deliver: false, reason: 'visible' })
      continue
    }
    if (!seenExact) {
      rows.push({ index: request.index, status: request.status, deliver: false, reason: 'not-yet-active' })
      continue
    }
    if (!hasPrompt) {
      rows.push({ index: request.index, status: request.status, deliver: false, reason: 'empty-prompt' })
      continue
    }
    if ((request.status === 'absent' || request.status === 'marker-only') && used < bound) {
      used += 1
      const delivery = {
        request: request.index,
        status: request.status,
        kind: 'replay-original-user-event',
        sourceSeq,
        sourceDigest,
        chars: typeof prompt === 'string' ? prompt.length : 0,
      }
      rows.push({ index: request.index, status: request.status, deliver: true, reason: 'redeliver-exact-source' })
      deliveries.push(delivery)
      continue
    }
    rows.push({
      index: request.index,
      status: request.status,
      deliver: false,
      reason: request.status === 'unknown'
        ? 'unknown-status'
        : used >= bound ? 'redelivery-bound-reached' : 'no-delivery',
    })
  }
  return {
    candidate: CANDIDATE,
    authority: 'replay-of-original-user-event',
    notASummary: true,
    mutatesFold: false,
    pinsSurface: false,
    sourceSeq,
    sourceDigest,
    promptChars: typeof prompt === 'string' ? prompt.length : 0,
    maxRedeliveries: bound,
    deliveries,
    addedChars: deliveries.reduce((sum, delivery) => sum + delivery.chars, 0),
    rows,
  }
}
