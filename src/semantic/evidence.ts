/**
 * Evidence resolution: turn a model-supplied QUOTE into a runtime-verified
 * reference to one committed event.
 *
 * ## Why the model never supplies a seq or a digest
 *
 * A writer that could name its own evidence could invent it. The failure is not
 * hypothetical: an `eventSeq` is a small integer, and a model that wants a
 * claim to look grounded will happily produce a plausible one. Requiring the
 * model to copy an exact substring instead makes fabrication detectable — the
 * text either occurs in the folded span or it does not.
 *
 * The runtime then derives `(seq, messageDigest)` itself:
 *
 *   - the seq identifies the surface position the quote was found in;
 *   - the digest is `canonicalHash` of the DERIVED message at that position, so
 *     a later reader can re-derive the message and prove it still says what the
 *     evidence claims. This is the same identity rule the checkpoint archive
 *     uses (`ArchiveRef`), for the same reason.
 *
 * ## What a quote may not point at
 *
 * Only messages inside the folded span are searched. A checkpoint's own
 * narrative is NOT evidence: it is a derived summary of earlier history, so
 * citing it would launder derived authority into state (the exact chain the
 * `authority.ts` comment forbids). It is refused with `evidence-derived`.
 *
 * @module dsh-epistemic-fold/semantic/evidence
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import type { AuthoritativeEventKind } from '../state/authority.ts'
import type { ProposedEvidence } from './types.ts'

/** Shortest quote the runtime will accept; below this a match is meaningless. */
export const MIN_QUOTE_CHARS = 8
/** Longest quote kept; the model is asked for a short exact phrase. */
export const MAX_QUOTE_CHARS = 240

/**
 * The searchable text of one message.
 *
 * Text blocks only: reasoning and images are not citable evidence, and the
 * model cannot quote them verbatim in the first place. Blocks are joined with a
 * newline so a quote spanning two blocks is still findable.
 *
 * @param message - one derived message.
 * @returns its model-visible text.
 */
export function messageText(message: Message): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

/** One message the runtime may cite, paired with its surface position. */
export interface CitableMessage {
  readonly seq: number
  readonly message: Message
  readonly text: string
  /**
   * The raw authority kind this message can ground, or `undefined` when it can
   * ground nothing. Derived from ROLE + PRODUCER, exactly as the anchor service
   * does it for an event ref: a user-role message a plugin injected is not the
   * human user.
   */
  readonly kind: AuthoritativeEventKind | undefined
}

/**
 * The citable set for one fold: the folded span's messages, in order.
 *
 * @param foldedSeqs - surface seqs of the folded span.
 * @param messages - the derived messages of that span, positionally paired.
 * @returns one entry per message, preserving span order.
 * @throws when the two lists disagree in length, which would silently pair a
 *   quote with the wrong event — a wrong answer that looks like a right one.
 */
export function citableMessages(
  foldedSeqs: readonly number[],
  messages: readonly Message[],
): readonly CitableMessage[] {
  if (foldedSeqs.length !== messages.length) {
    throw new Error(
      `epistemic-fold: cannot build the citable set — ${foldedSeqs.length} seq(s) against `
      + `${messages.length} message(s); a quote could be attributed to the wrong event`,
    )
  }
  return foldedSeqs.map((seq, index) => {
    const message = messages[index]!
    return {
      seq,
      message,
      text: messageText(message),
      kind: authorityKindOfMessage(message),
    }
  })
}

/**
 * The authority kind one derived message can ground.
 *
 * Deliberately identical in spirit to `authoritativeKindOf` in `authority.ts`,
 * but evaluated on the MESSAGE rather than a raw event, because the span is
 * already derived. `compact-checkpoint` and every unknown producer fall through
 * to `undefined`: derived narrative is never an authority root.
 *
 * @param message - a derived message.
 * @returns the groundable kind, or `undefined`.
 */
function authorityKindOfMessage(message: Message): AuthoritativeEventKind | undefined {
  const sourceKind = message.source.kind
  switch (message.role) {
    case 'user':
      return sourceKind === 'user' ? 'user/message' : undefined
    case 'system':
      return 'system/message'
    case 'assistant':
      return 'assistant/message'
    case 'tool':
      return 'tool/result'
    default:
      return undefined
  }
}

/** Outcome of resolving one quote. */
export type QuoteResolution =
  | { readonly status: 'found'; readonly evidence: { seq: number; messageDigest: string; quote: string }; readonly kind: AuthoritativeEventKind }
  | { readonly status: 'not-found' }
  | { readonly status: 'ambiguous'; readonly seqs: readonly number[] }
  | { readonly status: 'derived'; readonly seq: number }

/**
 * Locate one quote inside the citable set.
 *
 * The quote is trimmed and clamped. A quote that occurs in MORE THAN ONE
 * message is refused rather than resolved to the first: "which event says this"
 * is the question the evidence is supposed to answer, and picking arbitrarily
 * would record a provenance claim the text does not uniquely support.
 *
 * @param quote - the model's verbatim phrase.
 * @param citable - the folded span's messages.
 * @returns the resolution, including the runtime-derived identity when found.
 */
export function resolveQuote(quote: string, citable: readonly CitableMessage[]): QuoteResolution {
  const needle = quote.trim().slice(0, MAX_QUOTE_CHARS)
  if (needle.length < MIN_QUOTE_CHARS) return { status: 'not-found' }
  const hits = citable.filter(entry => entry.text.includes(needle))
  if (hits.length === 0) return { status: 'not-found' }
  const underived = hits.filter(entry => entry.kind !== undefined)
  if (underived.length === 0) {
    // Matched only derived narrative (a checkpoint) — locatable, but not
    // evidence. Reported apart from "not found" so the diagnostic says which.
    return { status: 'derived', seq: hits[0]!.seq }
  }
  if (underived.length > 1) {
    return { status: 'ambiguous', seqs: underived.map(entry => entry.seq) }
  }
  const hit = underived[0]!
  return {
    status: 'found',
    kind: hit.kind!,
    evidence: {
      seq: hit.seq,
      messageDigest: canonicalHash(hit.message),
      quote: needle,
    },
  }
}

/**
 * Resolve every proposed quote, stopping at the first failure.
 *
 * @param proposed - the model's evidence list.
 * @param citable - the folded span's messages.
 * @returns the resolved refs and their authority kinds, or the first refusal.
 */
export function resolveEvidence(
  proposed: readonly ProposedEvidence[],
  citable: readonly CitableMessage[],
): {
  readonly ok: true
  readonly evidence: readonly { seq: number; messageDigest: string; quote: string }[]
  readonly kinds: readonly AuthoritativeEventKind[]
} | {
  readonly ok: false
  readonly reason: 'no-evidence' | 'evidence-not-found' | 'evidence-ambiguous' | 'evidence-derived'
  readonly detail: string
} {
  if (proposed.length === 0) {
    return { ok: false, reason: 'no-evidence', detail: 'a proposal must cite at least one quote' }
  }
  const evidence: { seq: number; messageDigest: string; quote: string }[] = []
  const kinds: AuthoritativeEventKind[] = []
  for (const [index, item] of proposed.entries()) {
    const resolution = resolveQuote(item.quote, citable)
    switch (resolution.status) {
      case 'not-found':
        return {
          ok: false,
          reason: 'evidence-not-found',
          detail: `evidence[${index}] does not occur verbatim in the folded span`,
        }
      case 'ambiguous':
        return {
          ok: false,
          reason: 'evidence-ambiguous',
          detail: `evidence[${index}] occurs in ${resolution.seqs.length} messages `
            + `(seq ${resolution.seqs.join(', ')}); a quote must identify one event`,
        }
      case 'derived':
        return {
          ok: false,
          reason: 'evidence-derived',
          detail: `evidence[${index}] matched only a checkpoint summary at seq ${resolution.seq}; `
            + 'derived narrative is not an authority root',
        }
      case 'found':
        evidence.push(resolution.evidence)
        kinds.push(resolution.kind)
        break
    }
  }
  return { ok: true, evidence, kinds }
}

/** Re-derive one message's digest, for journal verification. */
export function messageDigestOf(message: Message): string {
  return canonicalHash(message)
}

/** Convenience: the session's derived message at one surface seq. */
export function messageAt(session: Session, seq: number): Message | undefined {
  const event = session.eventAt(seq as never)
  if (event === undefined) return undefined
  return session.deriveEventMessage(event) ?? undefined
}
