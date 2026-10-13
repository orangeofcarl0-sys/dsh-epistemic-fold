/**
 * Deterministic checkpoint descriptors for the retrieval subagent (docs/67).
 *
 * No model call here, so an EF leaf fold still makes zero auxiliary calls and
 * this adds nothing to its cost or latency. The span is `sourceRangeOf` from
 * `recall.ts`, so a descriptor orders by the same source chronology the search
 * layer does rather than recomputing it.
 *
 * @module dsh-epistemic-fold/descriptors
 */

import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm"
import type { EventSource } from "./archive-refs.ts"
import { archiveMessages, sourceRangeOf } from "./recall.ts"
import type { CheckpointBundleV1 } from "./types.ts"

// ---------------------------------------------------------------- descriptors

/**
 * What a checkpoint holds, in words a model can reason with.
 *
 * The alternative — the checkpoint marker, `[EF1 L cp:<uuid>]` — names a location and
 * nothing else, which is what made targeting fail: the retrieval decision is a match
 * between "what I need" and "what was dropped", and an id supplies neither side.
 *
 * Everything here is DETERMINISTIC. No model call, so an EF leaf fold still makes zero
 * auxiliary calls and this adds nothing to its cost or latency.
 */
export interface CheckpointDescriptor {
  /** The handle to fetch with, e.g. `cp:56aee82f`. */
  readonly handle: string
  readonly mode: string
  /** Where in the conversation it sits, as the surface positions the fold recorded. */
  readonly span?: { readonly first: number; readonly last: number }
  readonly messageCount: number
  /** One line per archived message: role, tool name, and a leading excerpt. */
  readonly inventory: readonly string[]
}

/** Characters of a message that a descriptor line carries. */
export const INVENTORY_EXCERPT_CHARS = 80

/**
 * The key that marks a retrieval answer as DERIVED.
 *
 * A substring test on the rendered message is deliberately the detection mechanism: the
 * answer is archived as the JSON a tool returned, so the mark has to survive that
 * round-trip, and re-parsing every archived message to find it would cost more than the
 * descriptor it feeds. It is a distinctive key rather than a prose sentence because the
 * caller may paraphrase or quote the prose away.
 */
export const DERIVED_SENTINEL = 'efDerived'

/**
 * Whether a rendered message is a LIVE retrieval answer rather than raw history.
 *
 * Used by the descriptor builder, so that a checkpoint which holds a FOLDED derived
 * answer advertises that instead of presenting a paraphrase as if it were the record.
 * A retired one is excluded: it is a different fact, and conflating the two would say a
 * paraphrase is still available when it is not.
 */
export function isDerivedAnswer(text: string): boolean {
  return text.includes(DERIVED_SENTINEL) && !isRetiredDerived(text)
}

/**
 * The key that marks a derived answer as RETIRED, i.e. dropped at fold time.
 *
 * Deliberately a superset of `DERIVED_SENTINEL` so a single substring test can find both,
 * with `isDerivedAnswer` excluding this one: a retired answer and a live one are different
 * facts and a descriptor that conflated them would say a paraphrase is still available.
 */
export const DERIVED_RETIRED_SENTINEL = 'efDerivedRetired'

/**
 * What replaces a derived answer when the fold retires it.
 *
 * ## Why a TOMBSTONE and not a removal
 *
 * The obvious implementation — drop the message from the archived list — cannot be used.
 * `currentSpanSeqs` (`src/engine.ts:1595-1630`) counts the messages the fold span derives
 * and THROWS when that disagrees with the archived count, and the throw ends the episode. So
 * a naive drop converts a provenance problem into a lost run.
 *
 * The tombstone keeps the count, the surface seqs and the archive refs exactly as they were,
 * and retires only the CONTENT. That is what the requirement actually needs: the paraphrase
 * must not enter the next round. It does not, and the record still says a derived answer was
 * here and that re-asking regenerates it from raw checkpoints that ARE archived.
 */
export const DERIVED_RETIRED_TOMBSTONE = [
  '[' + DERIVED_RETIRED_SENTINEL + '] A retrieval-subagent answer was retired here by the fold.',
  'It was a paraphrase, not history, and it is regenerable: ask context_recall_subagent the',
  'same goal again, or read the raw checkpoints it cited. Nothing was lost from the record.',
].join('\n')

/** Whether a rendered message is a derived answer that the fold has already retired. */
export function isRetiredDerived(text: string): boolean {
  return text.includes(DERIVED_RETIRED_SENTINEL)
}

/**
 * Retire every derived answer in a fold span, IN PLACE.
 *
 * Length-preserving on purpose: see the tombstone note. The count of what was retired is
 * returned rather than inferred, because a fold that silently retired material would be the
 * same class of defect as one that silently dropped it.
 */
export function retireDerivedAnswers(messages: readonly Message[]): {
  readonly messages: Message[]
  readonly retired: number
} {
  let retired = 0
  const out = messages.map(message => {
    const text = message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')
    if (!isDerivedAnswer(text)) return message
    retired += 1
    return { ...message, content: [{ type: 'text', text: DERIVED_RETIRED_TOMBSTONE }] } as Message
  })
  return { messages: out, retired }
}

/**

/** How many message lines a descriptor carries before it summarises the rest. */
export const INVENTORY_LINES = 10

function textOf(block: ContentBlock): string {
  return block.type === "text" ? block.text : ""
}

function clip(text: string, limit = INVENTORY_EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length <= limit ? flat : flat.slice(0, limit) + "..."
}

/**
 * One line per message, in conversation order.
 *
 * The line answers "what is this" rather than "what does it say": role, the tool it
 * called or the tool that produced it, and enough of the text to tell a task statement
 * from a `cat` of a log. A caller reads this to decide WHETHER to fetch, not to work
 * from — the content is still behind the handle.
 */
export function inventoryOf(messages: readonly Message[], lines = INVENTORY_LINES): string[] {
  const out: string[] = []
  for (const message of messages.slice(0, lines)) {
    const calls = message.content.filter(block => block.type === "tool-call")
    const texts = message.content.filter(block => block.type === "text")
    const names = calls.map(block => block.type === "tool-call" ? block.name : "").filter(n => n.length > 0)
    if (names.length > 0) {
      const first = calls[0]
      const args = first !== undefined && first.type === "tool-call" ? clip(first.arguments, 60) : ""
      out.push(message.role + " -> " + names.join(",") + (args.length === 0 ? "" : " " + args))
      continue
    }
    const body = texts.map(textOf).join(" ").trim()
    if (body.length === 0) {
      out.push(message.role + " (no text)")
      continue
    }
    // A derived answer must never read as raw history. This is the label that survives
    // the fold: if the answer was archived into the main tree, its descriptor says so.
    if (isRetiredDerived(body)) {
      out.push("RETIRED DERIVED ANSWER (dropped at fold; re-ask the subagent for it)")
      continue
    }
    if (isDerivedAnswer(body)) {
      out.push("DERIVED ANSWER (retrieval subagent) - not raw history: " + clip(body))
      continue
    }
    out.push(message.role + ": " + clip(body))
  }
  if (messages.length > lines) out.push("... and " + (messages.length - lines) + " more message(s)")
  return out
}

/**
 * The descriptor of one bundle.
 *
 * An archive that cannot be resolved yields a descriptor with no inventory and an
 * explicit note, rather than an empty one: "I could not read this" and "this is empty"
 * are different claims and a caller acting on the wrong one is how a fact gets reported
 * as unknown.
 */
export function describeCheckpoint(
  bundle: CheckpointBundleV1,
  source?: EventSource,
): CheckpointDescriptor {
  const span = sourceRangeOf(bundle)
  const resolved = archiveMessages(bundle, source)
  const inventory = resolved.status === "resolved"
    ? inventoryOf(resolved.messages)
    : ["(archive unreadable: " + resolved.failures.map(f => f.reason).join(", ") + ")"]
  return {
    handle: bundle.checkpointId,
    mode: bundle.mode,
    ...(span === undefined ? {} : { span }),
    messageCount: bundle.archive.messageCount,
    inventory,
  }
}
