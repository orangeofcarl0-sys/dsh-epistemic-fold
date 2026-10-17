/**
 * The bounded subagent recall loop (docs/67): plan the reads, make them, answer.
 *
 * Every step is bounded — reads by `fetchBudgetChars` and `maxFetches`, the answer
 * by `answerMaxTokens` — and every failure is recorded rather than thrown. The loop
 * is pure logic over three injected callbacks, which is what makes it testable
 * without a provider.
 *
 * @module dsh-epistemic-fold/recall-loop
 */

import type { CheckpointDescriptor } from "./descriptors.ts"
import type { RecallDepth } from "./recall.ts"
import { subagentRecallStats } from "./recall-telemetry.ts"
import type { SubagentMessage } from "./recall-transport.ts"

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
   * `tool/result` is an AUTHORITATIVE kind (`src/state/anchor-service.ts:19-24`), so a later
   * reader has no way to tell a derived answer from raw history. A paraphrase then
   * becomes a source, which is exactly the laundering `src/state/authority.ts` refuses to
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
