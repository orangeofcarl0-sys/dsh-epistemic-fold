/**
 * Subagent-based recall — EXPERIMENTAL, off by default.
 *
 * ## The failure this exists for
 *
 * A direct `context_recall` is a document fetch: the caller names a checkpoint and gets
 * its content, up to one page. Measured over nine cells of the 4.1F round (docs/66):
 *
 *   57% of recall/search calls returned a MARKER with no content
 *   34% of context_search calls returned hits: []
 *   32% of context_recall calls re-opened a checkpoint already opened, up to 10x the
 *       same id, and one cell repeated the SAME depth on the SAME id four times
 *   4 of 9 cells ever recovered the task instruction, once each
 *
 * The archive was never the problem: `depth: "exact"` returned the instruction
 * character-for-character. The problem is that the caller must NAME what it wants using
 * an opaque id, and a document fetch has no size control — a large checkpoint is pulled
 * into the live surface page by page, and the surface then folds again.
 *
 * ## What this does instead
 *
 * Retrieval becomes a bounded QUERY. The caller states a GOAL; a subagent reads the
 * archive (descriptors, search, exact pages) and returns only what answers the goal,
 * plus a short list of what ELSE it saw that the caller may want next. Two consequences:
 *
 *   - the answer is bounded by a reply budget, not by the size of what it read, so a
 *     50,000-token checkpoint can yield a 500-token answer;
 *   - the caller never needs a checkpoint id, because the subagent does the locating.
 *
 * ## The non-goal half
 *
 * Not every recall need is known in advance, so every run returns a `further` list:
 * material the subagent saw that the goal did not ask for, as candidate questions. In
 * SURVEY mode (no goal) that list IS the answer — it is how a caller discovers what is
 * in an archive it has never read.
 *
 * ## Gating
 *
 * `subagentRecall` is false by default, and the tools are only registered when it is on.
 * The direct `context_recall` changes behaviour ONLY under the same flag, so a default
 * deployment cannot observe this feature at all.
 *
 * @module dsh-epistemic-fold/subagent-recall
 */

import { BlockAssembler, LlmError } from "@deepseek-ai/dsh-llm"
import type { ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage } from "@deepseek-ai/dsh-llm"
import type { Context } from "@deepseek-ai/cordis"
import type { SessionId } from "@deepseek-ai/dsh-session"
import { archiveMessages } from "./recall.ts"
import type { EventSource } from "./archive-refs.ts"
import type { RecallDepth } from "./recall.ts"
import type { CheckpointBundleV1 } from "./types.ts"

// ---------------------------------------------------------------- telemetry

/**
 * What this experiment did, in the shape `summaryRetryStats` established: a module-level
 * counter the host publishes rather than a value a caller has to remember.
 *
 * `gated` is the one that matters most: it counts direct recalls that were REFUSED for
 * size. A run where that stays 0 has not exercised the feature, whatever else it shows.
 */
export interface SubagentRecallStats {
  /** Direct recalls refused because they would have exceeded the threshold. */
  gated: number
  /** Subagent runs, split by whether a goal was given. */
  invocations: number
  surveyInvocations: number
  /** Model calls: one to plan the fetches, one to answer. */
  planCalls: number
  answerCalls: number
  /** Fetches the subagent executed, and the characters they cost it. */
  fetches: number
  fetchedChars: number
  /** Characters returned to the caller, which is the number the budget bounds. */
  answerChars: number
  /** Runs that ended without an answer: reported, never silently empty. */
  failures: number
  lastError: string | null
}

export const subagentRecallStats: SubagentRecallStats = {
  gated: 0,
  invocations: 0,
  surveyInvocations: 0,
  planCalls: 0,
  answerCalls: 0,
  fetches: 0,
  fetchedChars: 0,
  answerChars: 0,
  failures: 0,
  lastError: null,
}

/** Zero the counters. Called per episode by a host that reports per-episode telemetry. */
export function resetSubagentRecallStats(): void {
  subagentRecallStats.gated = 0
  subagentRecallStats.invocations = 0
  subagentRecallStats.surveyInvocations = 0
  subagentRecallStats.planCalls = 0
  subagentRecallStats.answerCalls = 0
  subagentRecallStats.fetches = 0
  subagentRecallStats.fetchedChars = 0
  subagentRecallStats.answerChars = 0
  subagentRecallStats.failures = 0
  subagentRecallStats.lastError = null
}

// ---------------------------------------------------------------- the gate

/**
 * Characters per token used to price a refusal.
 *
 * Deliberately a constant rather than a tokenizer: the gate runs inside a tool call,
 * before any model call, and an estimate that is off by a few percent cannot change the
 * decision it informs. It is LABELLED as an estimate in the payload so a reader never
 * mistakes it for a measurement.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/** The rendered size of a recall result, which is what the caller would receive. */
export function estimateRenderedChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export interface RecallBudgetVerdict {
  readonly allowed: boolean
  readonly projectedChars: number
  readonly thresholdChars: number
  readonly estimatedTokens: number
  /** How far over the threshold, in characters; 0 when allowed. */
  readonly overBy: number
}

/**
 * Whether a direct recall may return its content, or must be redirected.
 *
 * A pure function so the policy can be pinned without a store, a session or a model: the
 * decision is one comparison, and the failure mode this feature exists for (a caller
 * pulling a large checkpoint into a small surface) is exactly a size question.
 */
export function recallBudgetVerdict(
  projectedChars: number,
  thresholdChars: number,
): RecallBudgetVerdict {
  const over = projectedChars - thresholdChars
  return {
    allowed: over <= 0,
    projectedChars,
    thresholdChars,
    estimatedTokens: Math.ceil(projectedChars / CHARS_PER_TOKEN_ESTIMATE),
    overBy: Math.max(0, over),
  }
}

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
  const seqs = bundle.source.orderedSurfaceSeqs.map(seq => Number(seq))
  const span = seqs.length === 0
    ? undefined
    : { first: Math.min(...seqs), last: Math.max(...seqs) }
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

// ---------------------------------------------------------------- the loop

export interface SubagentFetchRequest {
  readonly ref: string
  readonly depth: RecallDepth
  readonly offset?: number
  readonly limit?: number
}

/** A fetch the subagent asked for, already executed by the caller. */
export interface SubagentFetched {
  readonly request: SubagentFetchRequest
  readonly text: string
  readonly chars: number
}

export interface SubagentFurther {
  readonly question: string
  readonly why: string
}

export interface SubagentAnswer {
  readonly mode: "goal" | "survey"
  readonly answer: string
  /** Verbatim excerpts the answer rests on, so an exact fact can cross the boundary. */
  readonly quotes: readonly string[]
  /**
   * What else the subagent saw that the goal did not ask for.
   *
   * This is the NON-GOAL half, and in survey mode it is the whole answer: a caller that
   * does not yet know what to ask discovers the archive from here.
   */
  readonly further: readonly SubagentFurther[]
  readonly used: {
    readonly queries: readonly string[]
    readonly refs: readonly string[]
    readonly fetchedChars: number
    readonly planCalls: number
    readonly answerCalls: number
    /** True when the fetch budget stopped the subagent short of its plan. */
    readonly truncated: boolean
  }
  /**
   * PROVENANCE, and the reason it is a named field rather than implied.
   *
   * ## The risk this closes
   *
   * The answer lands on the caller surface as an ordinary `tool/result`, so the fold
   * policy may archive it into the main tree like any other material — and
   * `tool/result` is an AUTHORITATIVE kind (`src/anchor-service.ts:19-24`), so a later
   * reader has no way to tell a derived answer from raw history. A paraphrase then
   * becomes a source, which is exactly the laundering `src/authority.ts` refuses to
   * let an anchor do.
   *
   * This field is the mark that makes the distinction recoverable AFTER the fold: it is
   * in the archived bytes, it is cheap to detect (`DERIVED_SENTINEL`), and it names what
   * the answer was derived FROM. The descriptor builder labels any message carrying it
   * as `derived answer (retrieval subagent)`, so a checkpoint that holds a folded answer
   * says so instead of presenting it as history.
   */
  readonly efDerived: {
    readonly by: string
    /** The checkpoints and queries the answer was derived from. */
    readonly refs: readonly string[]
    readonly reads: number
    readonly fetchedChars: number
    readonly truncated: boolean
  }
}

/** The plan the subagent is asked to produce, and the deterministic fallback. */
export interface SubagentPlan {
  readonly fetches: readonly SubagentFetchRequest[]
  readonly queries: readonly string[]
}

const PLAN_INSTRUCTION = [
  "You are a RETRIEVAL SUBAGENT. You are choosing what to read from an archive of a",
  "conversation that has been folded away. You do NOT answer the question yet, and you",
  "do not see the archive: you see a DESCRIPTOR LIST of what each checkpoint holds.",
  "",
  "Output ONLY a JSON object, no prose:",
  "{\"queries\": [\"...\"], \"fetches\": [{\"ref\": \"cp:...\", \"depth\": \"exact\", \"offset\": 0, \"limit\": 20}]}",
  "",
  "Rules:",
  "- Prefer the FEWEST reads that could answer the goal. A fetch costs the caller budget.",
  "- depth \"summary\" or \"detail\" is cheap; \"exact\" is a page of archived messages.",
  "- Use \"queries\" when no descriptor obviously holds the answer, so the caller can search.",
  "- If the goal is absent, choose reads that would let you DESCRIBE what this archive",
  "  holds and what a reader might want next.",
  "- Material labelled a DERIVED ANSWER is an earlier retrieval paraphrase, not history.",
  "  Read the raw checkpoint it names instead of re-reading the paraphrase.",
].join("\n")

const ANSWER_INSTRUCTION = [
  "You are a RETRIEVAL SUBAGENT answering from material that was just read for you.",
  "",
  "Output ONLY a JSON object, no prose:",
  "{\"answer\": \"...\", \"quotes\": [\"...\"], \"further\": [{\"question\": \"...\", \"why\": \"...\"}]}",
  "",
  "Rules:",
  "- The answer must be short: what the goal needs, nothing else. The caller has a small",
  "  context and is paying for every token you return.",
  "- Put anything that must be EXACT (a name, a unit, a number, a hash, a path) in",
  "  \"quotes\" verbatim. Do not paraphrase it in the answer alone.",
  "- \"further\" is what else you saw that the goal did not ask for but the caller may",
  "  want next, as candidate questions. This is required even when the goal is met.",
  "- If the material does not answer the goal, say so in \"answer\" rather than guessing.",
  "- Some material may be labelled a DERIVED ANSWER from an earlier retrieval. That is a",
  "  paraphrase, not evidence: prefer the raw material it names, and if the only thing that",
  "  answers the goal is derived, SAY SO in \"answer\" instead of restating it as fact.",
].join("\n")

/**
 * The JSON object embedded in a model reply, or null.
 *
 * Tolerant on purpose: models wrap JSON in prose and in code fences. This finds the
 * outermost braces and parses what is between them. It does NOT try to repair malformed
 * JSON — a plan that has to be repaired is a plan the caller cannot trust, and the
 * fallback below is deterministic.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The plan in a model reply, or null when it did not produce a usable one. */
export function parsePlan(text: string): SubagentPlan | null {
  const parsed = extractJsonObject(text)
  if (parsed === null) return null
  const fetches: SubagentFetchRequest[] = []
  const rawFetches = parsed["fetches"]
  if (Array.isArray(rawFetches)) {
    for (const entry of rawFetches) {
      if (entry === null || typeof entry !== "object") continue
      const record = entry as Record<string, unknown>
      const ref = record["ref"]
      if (typeof ref !== "string" || ref.length === 0) continue
      const depth = record["depth"]
      fetches.push({
        ref,
        depth: depth === "summary" || depth === "detail" || depth === "exact" ? depth : "exact",
        ...(typeof record["offset"] === "number" ? { offset: record["offset"] } : {}),
        ...(typeof record["limit"] === "number" ? { limit: record["limit"] } : {}),
      })
    }
  }
  const queries: string[] = []
  const rawQueries = parsed["queries"]
  if (Array.isArray(rawQueries)) {
    for (const entry of rawQueries) if (typeof entry === "string" && entry.length > 0) queries.push(entry)
  }
  if (fetches.length === 0 && queries.length === 0) return null
  return { fetches, queries }
}

/** Characters of archive the subagent may read for one goal. */
export const SUBAGENT_FETCH_BUDGET_CHARS = 120_000
/** Reads one subagent run may execute, whatever its plan says. */
export const SUBAGENT_MAX_FETCHES = 6
/**
 * Descriptors the planner is shown. The MOST RECENT are kept when there are more.
 *
 * A bound is needed because the descriptor list goes into a prompt: an episode that folded
 * 100 times would otherwise spend more on the inventory than on the answer. The most recent
 * are kept because a question is usually about the recent past, and the older ones remain
 * reachable through `context_search`, which the planner is told to use when no descriptor
 * obviously holds the answer.
 */
export const SUBAGENT_MAX_DESCRIPTORS = 40
/** Reply budget for the planning call. A plan is a short JSON object. */
export const SUBAGENT_PLAN_MAX_TOKENS = 512
/**
 * Reply budget for the answer, and therefore the bound on what the caller receives.
 *
 * This is the number that makes the feature worth having: the subagent may read 120,000
 * characters and must answer in 1,024 tokens. Without a cap here the interface would
 * only be a document fetch with extra steps.
 */
export const SUBAGENT_ANSWER_MAX_TOKENS = 1_024

export interface SubagentMessage {
  readonly role: "system" | "user"
  readonly text: string
}

export interface SubagentRecallOptions {
  /** What the caller wants to know. ABSENT means survey mode. */
  readonly goal?: string
  /** Scope: one checkpoint, or a search query, or neither (the whole archive). */
  readonly ref?: string
  readonly query?: string
  /** The descriptor list the planner chooses from. */
  readonly descriptors: readonly CheckpointDescriptor[]
  /** Execute one read against the SAME archive. `null` when the ref is unavailable. */
  readonly fetch: (request: SubagentFetchRequest) => Promise<{ text: string; chars: number } | null>
  /** Execute one search; already bounded by the search layer. */
  readonly search: (query: string) => Promise<{ text: string; chars: number }>
  /** One model call, injected so the loop is testable without a provider. */
  readonly complete: (messages: readonly SubagentMessage[], maxTokens: number) => Promise<string>
  readonly fetchBudgetChars?: number
  readonly maxFetches?: number
  readonly planMaxTokens?: number
  readonly answerMaxTokens?: number
}

function planMessages(options: SubagentRecallOptions): SubagentMessage[] {
  const scope = [
    options.ref === undefined ? null : "scope ref: " + options.ref,
    options.query === undefined ? null : "scope query: " + options.query,
  ].filter((line): line is string => line !== null)
  const descriptorLines = options.descriptors.map(d => {
    const span = d.span === undefined ? "" : " turns(seq) " + d.span.first + "-" + d.span.last
    return [
      d.handle + "  mode=" + d.mode + "  messages=" + d.messageCount + span,
      ...d.inventory.map(line => "    " + line),
    ].join("\n")
  })
  return [
    { role: "system", text: PLAN_INSTRUCTION },
    {
      role: "user",
      text: [
        options.goal === undefined || options.goal.trim().length === 0
          ? "GOAL: (none given — this is a SURVEY. Choose reads that let you describe what"
            + " this archive holds and what a reader might want next.)"
          : "GOAL: " + options.goal,
        ...scope,
        "",
        "DESCRIPTOR LIST (" + options.descriptors.length + " checkpoint(s)):",
        ...(descriptorLines.length === 0 ? ["(empty — nothing has been folded yet)"] : descriptorLines),
      ].join("\n"),
    },
  ]
}

/**
 * The plan to use when the model did not produce one.
 *
 * Deterministic and deliberately cheap: the caller named a ref or a query, so use it;
 * otherwise read the summaries of the first few descriptors, which is enough for a survey
 * answer because the descriptor list is already in the prompt.
 */
export function fallbackPlan(options: SubagentRecallOptions, maxFetches: number): SubagentPlan {
  if (options.ref !== undefined && options.ref.length > 0) {
    return { fetches: [{ ref: options.ref, depth: "exact", offset: 0 }], queries: [] }
  }
  if (options.query !== undefined && options.query.length > 0) {
    return { fetches: [], queries: [options.query] }
  }
  return {
    fetches: options.descriptors.slice(0, maxFetches).map(d => ({ ref: d.handle, depth: "summary" as RecallDepth })),
    queries: [],
  }
}

function answerMessages(
  options: SubagentRecallOptions,
  fetched: readonly SubagentFetched[],
  truncated: boolean,
): SubagentMessage[] {
  const material = fetched.map(f => {
    const where = f.request.depth + " " + f.request.ref
      + (f.request.offset === undefined ? "" : " offset=" + f.request.offset)
    return "----- " + where + " (" + f.chars + " chars)\n" + f.text
  })
  return [
    { role: "system", text: ANSWER_INSTRUCTION },
    {
      role: "user",
      text: [
        options.goal === undefined || options.goal.trim().length === 0
          ? "GOAL: (none — describe what this archive holds and what the reader may want next.)"
          : "GOAL: " + options.goal,
        "",
        truncated
          ? "NOTE: the read budget stopped the subagent short; some planned reads were not made."
          : "NOTE: all planned reads were made.",
        "",
        material.length === 0 ? "MATERIAL: (nothing was read)" : "MATERIAL:\n" + material.join("\n\n"),
      ].join("\n"),
    },
  ]
}

/** The `{answer, quotes, further}` in a model reply, with the raw text as the fallback. */
export function parseAnswer(text: string): {
  answer: string
  quotes: string[]
  further: SubagentFurther[]
} {
  const parsed = extractJsonObject(text)
  if (parsed === null) return { answer: text.trim(), quotes: [], further: [] }
  const answer = typeof parsed["answer"] === "string" ? parsed["answer"].trim() : ""
  const quotes: string[] = []
  if (Array.isArray(parsed["quotes"])) {
    for (const q of parsed["quotes"]) if (typeof q === "string" && q.length > 0) quotes.push(q)
  }
  const further: SubagentFurther[] = []
  if (Array.isArray(parsed["further"])) {
    for (const entry of parsed["further"]) {
      if (entry === null || typeof entry !== "object") continue
      const record = entry as Record<string, unknown>
      const question = record["question"]
      if (typeof question !== "string" || question.length === 0) continue
      const why = record["why"]
      further.push({ question, why: typeof why === "string" ? why : "" })
    }
  }
  // An object with no answer at all is not an answer: the raw reply is more useful than
  // an empty string, and the caller can see that the subagent failed to follow the shape.
  return { answer: answer.length === 0 ? text.trim() : answer, quotes, further }
}

function recordFailure(error: unknown): void {
  subagentRecallStats.failures += 1
  subagentRecallStats.lastError = error instanceof Error ? error.message : String(error)
}

/**
 * Run one subagent recall: plan the reads, make them, answer.
 *
 * Every step is bounded — reads by `fetchBudgetChars` and `maxFetches`, the answer by
 * `answerMaxTokens` — and every failure is recorded rather than thrown, because a
 * retrieval helper that can end an episode is worse than one that returns a short answer
 * saying it could not.
 */
export async function runSubagentRecall(options: SubagentRecallOptions): Promise<SubagentAnswer> {
  const goal = options.goal === undefined ? "" : options.goal.trim()
  const mode: "goal" | "survey" = goal.length === 0 ? "survey" : "goal"
  const fetchBudget = options.fetchBudgetChars ?? SUBAGENT_FETCH_BUDGET_CHARS
  const maxFetches = options.maxFetches ?? SUBAGENT_MAX_FETCHES
  subagentRecallStats.invocations += 1
  if (mode === "survey") subagentRecallStats.surveyInvocations += 1

  let plan: SubagentPlan | null = null
  subagentRecallStats.planCalls += 1
  try {
    plan = parsePlan(await options.complete(planMessages(options), options.planMaxTokens ?? SUBAGENT_PLAN_MAX_TOKENS))
  } catch (error) {
    recordFailure(error)
  }
  if (plan === null) plan = fallbackPlan(options, maxFetches)

  const fetched: SubagentFetched[] = []
  let usedChars = 0
  let truncated = false
  // Searches first: they are pointers, bounded by the search layer, and they locate a
  // checkpoint the planner could not name. A fetch is only worth its budget after that.
  for (const query of plan.queries) {
    try {
      const found = await options.search(query)
      if (usedChars + found.chars > fetchBudget) { truncated = true; break }
      usedChars += found.chars
      fetched.push({ request: { ref: "search:" + query, depth: "summary" }, text: found.text, chars: found.chars })
    } catch (error) { recordFailure(error) }
  }
  for (const request of plan.fetches) {
    if (fetched.length >= maxFetches) { truncated = true; break }
    try {
      const found = await options.fetch(request)
      if (found === null) {
        fetched.push({ request, text: "(unavailable: " + request.ref + ")", chars: 0 })
        continue
      }
      if (usedChars + found.chars > fetchBudget) { truncated = true; break }
      usedChars += found.chars
      fetched.push({ request, text: found.text, chars: found.chars })
    } catch (error) { recordFailure(error) }
  }

  let raw = ""
  subagentRecallStats.answerCalls += 1
  try {
    raw = await options.complete(answerMessages(options, fetched, truncated), options.answerMaxTokens ?? SUBAGENT_ANSWER_MAX_TOKENS)
  } catch (error) {
    recordFailure(error)
    raw = "(the retrieval subagent could not produce an answer: " + (error instanceof Error ? error.message : String(error)) + ")"
  }
  const parsed = parseAnswer(raw)
  subagentRecallStats.fetches += fetched.length
  subagentRecallStats.fetchedChars += usedChars
  subagentRecallStats.answerChars += parsed.answer.length
  return {
    mode,
    answer: parsed.answer,
    quotes: parsed.quotes,
    further: parsed.further,
    used: {
      queries: plan.queries,
      refs: plan.fetches.map(f => f.ref),
      fetchedChars: usedChars,
      planCalls: 1,
      answerCalls: 1,
      truncated,
    },
    efDerived: {
      by: 'retrieval-subagent',
      refs: [...plan.fetches.map(f => f.ref), ...plan.queries.map(q => 'search:' + q)],
      reads: fetched.length,
      fetchedChars: usedChars,
      truncated,
    },
  }
}

// ---------------------------------------------------------------- the model call

/**
 * Map a terminal finish to its fail-closed error, as `rationale.ts` does.
 *
 * A truncated reply is an ERROR rather than a short answer: the subagent output is JSON
 * with three required faces, and a cap that cuts one of them off produces a reply that
 * parses as something else. Reporting it lets the caller retry or fall back; accepting it
 * silently would put a half-answer in the caller context wearing a complete one shape.
 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case "error":
    case "aborted": {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case "max-tokens": {
      const error = new Error("retrieval subagent reply truncated at the token cap") as Error & { code?: string }
      error.code = "MAX_TOKENS"
      return error
    }
    default:
      return undefined
  }
}

/**
 * One auxiliary model call for the retrieval subagent.
 *
 * ## Why the purpose is labelled `compaction`
 *
 * `GenerateOptions.purpose` is a closed union, `"compaction" | "session-title"`
 * (`@deepseek-ai/dsh-llm` types.d.ts:530), and there is no retrieval value. Labelling it
 * `compaction` is therefore the only type-safe choice, and it is a MISLABEL: a host that
 * attributes cost by purpose will bill these calls to compaction. The subagent counters
 * (`subagentRecallStats`) exist partly because of that: the calls are attributable from
 * here even when the transport label is not.
 *
 * The subagent deliberately does NOT replay the conversation prefix. A compaction call
 * reuses the prefix so the provider warm cache still applies; a retrieval question is
 * asked about the ARCHIVE, not about the live conversation, and shipping the live surface
 * to it would spend the budget this feature exists to protect.
 */
export async function completeWithContext(options: {
  readonly ctx: Context
  readonly target: { readonly provider: string; readonly model: string }
  readonly sessionId: SessionId
  readonly messages: readonly SubagentMessage[]
  readonly maxTokens: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const assembler = new BlockAssembler()
  const messages: RequestMessage[] = options.messages.map(message => ({
    role: message.role,
    content: [{ type: "text", text: message.text }],
  })) as RequestMessage[]
  const generateOptions: GenerateOptions = {
    provider: options.target.provider,
    model: options.target.model,
    messages,
    maxTokens: options.maxTokens,
    sessionId: options.sessionId,
    purpose: "compaction",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  for await (const chunk of options.ctx.llm.stream(generateOptions)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const text = assembler.blocks().map(block => block.type === "text" ? block.text : "").join("\n").trim()
  if (text.length === 0) {
    throw new LlmError("retrieval subagent produced no text content", "UNSUPPORTED_CONTENT")
  }
  return text
}
