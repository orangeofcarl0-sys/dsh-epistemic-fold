/**
 * What a checkpoint HOLDS, in words a model can act on, with the index of every message.
 *
 * ## Why this is its own module
 *
 * Two consumers need this and they sit on opposite sides of a dependency:
 *
 *  - `descriptors.ts` builds the subagent's descriptor list, and it imports `recall.ts`
 *    for `archiveMessages` / `sourceRangeOf`.
 *  - `recall.ts` serves `context_recall depth="detail"`, which for a checkpoint with no
 *    semantic digest must return THIS inventory — the main agent has no other way to see
 *    what was folded away.
 *
 * So `recall.ts` importing `descriptors.ts` would close a cycle. Everything that needs
 * nothing but a `Message[]` lives here instead: zero local imports, so both sides can
 * depend on it and the classification exists exactly once.
 *
 * @module dsh-epistemic-fold/inventory
 */

import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm"

/** Characters of a message that an inventory line carries. */
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

/** How many message lines an inventory carries before it summarises the rest. */
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
  for (const line of classifyMessages(messages, 0, lines)) out.push(renderInventoryLine(line))
  if (messages.length > lines) out.push("... and " + (messages.length - lines) + " more message(s)")
  return out
}

/**
 * One message classified for display, with its ARCHIVE INDEX.
 *
 * ## Why the index is carried here and not appended to `inventoryOf`'s lines
 *
 * The two consumers want different things from the same classification. The retrieval
 * subagent reads a descriptor list to decide WHICH checkpoint to fetch, so its lines are
 * prose. The main agent reading `context_recall depth="detail"` needs the index, because
 * that index IS the `offset` an `exact` page takes — it is the difference between
 * "this archive mentions a task statement" and being able to open that message.
 *
 * The CLASSIFICATION is shared (`classifyMessages`) so the two renderings cannot drift
 * apart; only the rendering differs. A second classifier would be a second opinion about
 * what a message is, which is the drift this split exists to avoid.
 */
export interface InventoryEntry {
  /** Position in the archived message list — the `offset` for an exact page. */
  readonly index: number
  readonly role: string
  /** What this message is, bounded; never the whole body. */
  readonly preview: string
}

/** One classified message, before rendering. Internal to this module. */
type ClassifiedLine =
  | { readonly kind: "tool-call"; readonly role: string; readonly names: string; readonly args: string }
  | { readonly kind: "empty"; readonly role: string }
  | { readonly kind: "retired-derived" }
  | { readonly kind: "derived"; readonly preview: string }
  | { readonly kind: "text"; readonly role: string; readonly preview: string }

/** Classify `messages[from, to)` — the SINGLE decision about what a message is. */
function classifyMessages(messages: readonly Message[], from: number, to: number): ClassifiedLine[] {
  const out: ClassifiedLine[] = []
  for (const message of messages.slice(from, to)) {
    const calls = message.content.filter(block => block.type === "tool-call")
    const names = calls.map(block => block.type === "tool-call" ? block.name : "").filter(n => n.length > 0)
    if (names.length > 0) {
      const first = calls[0]
      const args = first !== undefined && first.type === "tool-call" ? clip(first.arguments, 60) : ""
      out.push({ kind: "tool-call", role: message.role, names: names.join(","), args })
      continue
    }
    const body = message.content.filter(block => block.type === "text").map(textOf).join(" ").trim()
    if (body.length === 0) {
      out.push({ kind: "empty", role: message.role })
      continue
    }
    // A derived answer must never read as raw history. This is the label that survives
    // the fold: if the answer was archived into the main tree, its descriptor says so.
    if (isRetiredDerived(body)) {
      out.push({ kind: "retired-derived" })
      continue
    }
    if (isDerivedAnswer(body)) {
      out.push({ kind: "derived", preview: clip(body) })
      continue
    }
    out.push({ kind: "text", role: message.role, preview: clip(body) })
  }
  return out
}

/** `inventoryOf`'s rendering, byte-identical to the pre-split format. */
function renderInventoryLine(line: ClassifiedLine): string {
  switch (line.kind) {
    case "tool-call":
      return line.role + " -> " + line.names + (line.args.length === 0 ? "" : " " + line.args)
    case "empty":
      return line.role + " (no text)"
    case "retired-derived":
      return "RETIRED DERIVED ANSWER (dropped at fold; re-ask the subagent for it)"
    case "derived":
      return "DERIVED ANSWER (retrieval subagent) - not raw history: " + line.preview
    case "text":
      return line.role + ": " + line.preview
  }
}

/** A model-facing preview for one classified line, without the prose framing. */
function previewOf(line: ClassifiedLine): { role: string; preview: string } {
  switch (line.kind) {
    case "tool-call":
      return { role: line.role, preview: "tool " + line.names + (line.args.length === 0 ? "" : " " + line.args) }
    case "empty":
      return { role: line.role, preview: "(no text)" }
    case "retired-derived":
      return { role: "system", preview: "RETIRED DERIVED ANSWER (dropped at fold)" }
    case "derived":
      return { role: "system", preview: "DERIVED ANSWER (retrieval subagent), not raw history: " + line.preview }
    case "text":
      return { role: line.role, preview: line.preview }
  }
}

/**
 * A bounded, navigable inventory of an archive, with the index of every entry.
 *
 * Bounded twice over, because this payload is what a model reads after a fold and an
 * unbounded one would undo the fold: at most `limit` entries, and each preview clipped.
 * `nextIndex` is the offset to continue from, so a caller that does not find what it
 * wants in the first page can ask for the next one instead of paging blind.
 *
 * The FIRST messages are included, not the newest. A task statement lives at index 0 and a
 * "most recent N" slice would drop exactly the message whose loss cannot be repaired —
 * which is the failure this exists to fix.
 */
export function inventoryEntriesOf(
  messages: readonly Message[],
  options: { readonly offset?: number; readonly limit?: number } = {},
): { readonly entries: readonly InventoryEntry[]; readonly nextIndex?: number; readonly total: number } {
  const total = messages.length
  const offset = Math.max(0, Math.min(options.offset ?? 0, total))
  const limit = Math.max(1, options.limit ?? INVENTORY_LINES)
  const end = Math.min(total, offset + limit)
  const entries = classifyMessages(messages, offset, end).map((line, at) => {
    const { role, preview } = previewOf(line)
    return { index: offset + at, role, preview }
  })
  return { entries, ...(end < total ? { nextIndex: end } : {}), total }
}
