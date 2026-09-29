/**
 * RC1.3 retrieval failure taxonomy: WHERE the recall chain broke.
 *
 * RC1.2.1 established that the EF recall MECHANISM works — a folded fact is
 * reachable through `context_search` → `context_recall` — and that the residual
 * end-to-end gap is the model's USE of it. "The model scored 2.4/3" is not an
 * actionable finding, though: a run that never searched, a run that searched and
 * missed, and a run that read the fact and then answered wrongly all need
 * different remedies, and only the first of them would justify touching the
 * system prompt.
 *
 * So this module turns a loop's transcript into a stage-by-stage verdict. The
 * chain has five links, and a fact is lost at exactly one of them:
 *
 *   decide to search → search hits → decide to recall → recall returns it → use it
 *
 * The classifier names the FIRST link that failed, because that is the one a
 * change could fix: adding a retrieval instruction cannot help a run that
 * already recalled the fact and then answered badly, and enriching the search
 * result cannot help a run that never searched at all.
 *
 * This is deliberately pure: it takes what the loop observed and returns labels.
 * No provider, no store, no timing. That is what lets the taxonomy be pinned by
 * keyless tests and then applied verbatim to live transcripts.
 *
 * @module eval/retrieval-taxonomy
 */

/** One fact a probe asks about, with its own matcher. */
export interface ProbeFact {
  readonly id: string
  /** Whether some text carries this fact. */
  readonly present: (text: string) => boolean
}

/**
 * What the loop did about ONE fact, in chain order.
 *
 * Every field is an observation, never an inference: `searched` means a search
 * call was made, `searchHitRelevant` means a search result's payload carried
 * this fact. Deriving them is the caller's job (the live harness knows what the
 * tools returned); classifying them is this module's.
 *
 * `searchHitRelevant` and `recallRelevant` are kept SEPARATE, and each means
 * "THAT tool's output carried the fact". Collapsing them into one flag would
 * make `recall-miss` unreachable — a search hit would always satisfy the union,
 * so the classifier could never report that a recall came back empty. The
 * distinction is the whole point: a bounded excerpt that mentions a fact is not
 * the same as a recall that returns it.
 */
export interface FactTrace {
  /** The final answer carried the fact. */
  readonly answerCarries: boolean
  /** The loop called `context_search` at least once. */
  readonly searched: boolean
  /** A `context_search` output carried this fact. */
  readonly searchHitRelevant: boolean
  /** The loop called `context_recall` at least once. */
  readonly recalled: boolean
  /** A `context_recall` output carried this fact. */
  readonly recallRelevant: boolean
}

/**
 * Where the chain broke for one fact.
 *
 * `pass` is the only non-failure. The failure labels are ordered by how far down
 * the chain the run got, so a label reads as "it got this far and stopped".
 */
export type RetrievalFailure =
  | 'pass'
  /** Never attempted retrieval at all. */
  | 'no-search'
  /**
   * Searched and nothing came back carrying the fact.
   *
   * The model stopped at search, so this is a query-or-index problem: either it
   * asked the wrong thing or the index could not reach the fact.
   */
  | 'search-miss'
  /** Search hit the fact, but the model never opened the archive. */
  | 'search-hit-no-recall'
  /**
   * The model went as deep as it could — it recalled — and NOTHING returned the
   * fact, from either tool.
   *
   * Not one of RC1.3's four named categories, and it is added because they leave
   * a real gap: this is the only label that would be an EF-side defect rather
   * than a model-side one, so conflating it with a model failure would hide the
   * single outcome that matters most. It outranks every other failure for that
   * reason.
   */
  | 'recall-miss'
  /** A tool DID return the fact; the answer still missed it. */
  | 'recall-returned-fact-but-answer-missed'

/**
 * Classify one fact by the first link that failed.
 *
 * The order of the checks IS the chain, so a label never claims a later link
 * broke while an earlier one was already broken.
 */
export function classifyFact(trace: FactTrace): RetrievalFailure {
  if (trace.answerCarries) return 'pass'
  // Nothing was attempted, so nothing downstream is meaningful.
  if (!trace.searched && !trace.recalled) return 'no-search'
  // Nothing anywhere carried the fact. Which label depends on how deep the
  // model went: a recall that also came back empty is the deeper failure.
  if (!trace.searchHitRelevant && !trace.recallRelevant) {
    return trace.recalled ? 'recall-miss' : 'search-miss'
  }
  // The fact was in a search result and the model stopped there. Checked only
  // once something carried it, so this cannot mask a total miss.
  if (!trace.recalled) return 'search-hit-no-recall'
  return 'recall-returned-fact-but-answer-missed'
}

/**
 * The failure order used for aggregation and reporting.
 *
 * `recall-miss` is FIRST among failures because it is the only EF-side
 * candidate: if it ever dominates, the conclusion is about the product rather
 * than about model tool use, and that must not be buried under a majority of
 * model-side labels.
 */
export const FAILURE_ORDER: readonly RetrievalFailure[] = [
  'recall-miss',
  'no-search',
  'search-miss',
  'search-hit-no-recall',
  'recall-returned-fact-but-answer-missed',
  'pass',
]

/** One fact's verdict. */
export interface FactVerdict {
  readonly factId: string
  readonly failure: RetrievalFailure
}

/** A run's verdict: per-fact labels plus the run's primary failure. */
export interface RunVerdict {
  readonly facts: readonly FactVerdict[]
  /**
   * The run's headline failure, or `pass` when every fact was answered.
   *
   * Chosen by {@link FAILURE_ORDER}: the most upstream EF-side-relevant failure
   * among the missed facts, so a run cannot be summarized as a mild problem
   * while hiding a `recall-miss`.
   */
  readonly primary: RetrievalFailure
  /** Facts the answer carried, out of all facts. */
  readonly score: number
  readonly total: number
}

/** Classify one run's facts and pick its headline failure. */
export function classifyRun(traces: ReadonlyMap<string, FactTrace>): RunVerdict {
  const facts: FactVerdict[] = []
  for (const [factId, trace] of traces) {
    facts.push({ factId, failure: classifyFact(trace) })
  }
  const failures = facts.filter(fact => fact.failure !== 'pass').map(fact => fact.failure)
  const primary = failures.length === 0
    ? 'pass'
    : [...failures].sort(
      (a, b) => FAILURE_ORDER.indexOf(a) - FAILURE_ORDER.indexOf(b),
    )[0]!
  return {
    facts,
    primary,
    score: facts.filter(fact => fact.failure === 'pass').length,
    total: facts.length,
  }
}

/** A tally over many runs, in {@link FAILURE_ORDER}. */
export interface TaxonomySummary {
  readonly runs: number
  /** How many runs had each primary failure. */
  readonly byPrimary: Readonly<Record<RetrievalFailure, number>>
  /** How many individual facts failed at each link. */
  readonly byFact: Readonly<Record<RetrievalFailure, number>>
  readonly meanScore: number
}

/** Tally run verdicts into a report. */
export function summarizeTaxonomy(verdicts: readonly RunVerdict[]): TaxonomySummary {
  const byPrimary = emptyCounts()
  const byFact = emptyCounts()
  for (const verdict of verdicts) {
    byPrimary[verdict.primary] += 1
    for (const fact of verdict.facts) byFact[fact.failure] += 1
  }
  const meanScore = verdicts.length === 0
    ? 0
    : verdicts.reduce((sum, verdict) => sum + verdict.score, 0) / verdicts.length
  return { runs: verdicts.length, byPrimary, byFact, meanScore }
}

function emptyCounts(): Record<RetrievalFailure, number> {
  return {
    pass: 0,
    'no-search': 0,
    'search-miss': 0,
    'search-hit-no-recall': 0,
    'recall-miss': 0,
    'recall-returned-fact-but-answer-missed': 0,
  }
}

/**
 * The remedy the taxonomy points to, stated so a report cannot pick one later.
 *
 * The mapping is the whole reason for classifying: each dominant failure names
 * exactly one change, and RC1.3's rule is to make ONE change at a time so the
 * effect stays attributable.
 */
export function recommendedAction(summary: TaxonomySummary): {
  readonly action: string
  readonly rationale: string
} {
  const failures = summary.runs - summary.byPrimary.pass
  if (failures === 0) {
    return {
      action: 'none — freeze the quality side',
      rationale: 'every completed run answered every fact; nothing is broken to fix',
    }
  }
  // A `recall-miss` anywhere is an EF-side candidate and outranks the
  // model-side labels, even if it is not the majority.
  if (summary.byFact['recall-miss'] > 0) {
    return {
      action: 'investigate recall coverage before touching ergonomics',
      rationale: 'a tool was asked for the fact and did not return it — that is a product-side '
        + 'finding, and no instruction or result-shape change would fix it',
    }
  }
  if (summary.byPrimary['no-search'] > failures / 2) {
    return {
      action: 'add a stable retrieval instruction',
      rationale: 'the majority of failures never searched, so the model is not attempting retrieval; '
        + 'only a framing rule addresses that',
    }
  }
  if (summary.byPrimary['search-miss'] > 0) {
    return {
      action: 'improve the search return shape / query affordance',
      rationale: 'the model searched and did not find, so the problem is the hit quality or the '
        + 'query it was led to make, not its willingness to search',
    }
  }
  if (summary.byPrimary['search-hit-no-recall'] > 0) {
    return {
      action: 'make the search hit self-evidently a pointer to recall',
      rationale: 'search found the fact and the model stopped there; the hit must state that the '
        + 'excerpt is a preview and the full text needs a recall',
    }
  }
  return {
    action: 'do not change retrieval; the residual is answer synthesis',
    rationale: 'tools returned the facts and the answer still missed them, so the loss is in the '
      + 'final step, which retrieval ergonomics does not touch',
  }
}
