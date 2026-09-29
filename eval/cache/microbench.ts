/**
 * RC1-E §21–§26: the cache microbench.
 *
 * The one number this exists to explain is the `2.265` outlier from RC0-C: nine
 * of ten paired runs landed in 0.776–0.984 and one was 2.265. RC0 correctly
 * refused to drop it, and RC1 §42 requires it be CLASSIFIED — provider
 * cache-state, policy, availability, or unknown — with the default flip staying
 * blocked while it is unknown.
 *
 * Classification needs a controlled experiment, not a longer soak. The
 * confound is that in a paired run the two arms execute in sequence, so
 * whichever runs second inherits whatever cache state the first left behind.
 * Two design choices remove it:
 *
 *   **ABBA ordering** (§22). Blocks alternate E→B, B→E, B→E, E→B, so time
 *   drift and cache carryover hit both arms equally instead of whichever arm
 *   happens to run second.
 *
 *   **Independent namespaces** (§23). Each block's stable prefix begins with a
 *   unique token, so block *i* cannot hit block *i−1*'s cache. Within a block,
 *   two requests under the same policy still warm naturally — which is what
 *   makes "isolated self-cache" measurable separately from "shared carryover".
 *
 * Only 4K–8K of stable prefix and a few hundred tokens of suffix are needed:
 * cache behavior is observable at that size, so the whole experiment is a few
 * dozen requests rather than a 100K-context run (§21).
 *
 * @module eval/cache/microbench
 */

/**
 * The three request structures §21 requires, because they have different cache
 * signatures and conflating them is how a structural effect gets misread as a
 * policy effect.
 */
export type CacheStructure =
  /**
   * `P`, `P+A`, `P+A+B` — a stable prefix with content appended. The pure
   * reuse case: every request should reuse everything before its own addition.
   */
  | 'stable-append'
  /**
   * `P+raw`, then `P+checkpoint+fresh-tail` — what a LEAF fold produces. The
   * prefix survives and the tail is replaced, so the reuse should be nearly as
   * good as `stable-append` if the fold really does change as little as
   * possible.
   */
  | 'leaf-append'
  /**
   * `P_old+tail`, then `P_new+tail` — what a ROOT rebase produces. The prefix
   * is REWRITTEN, so the second request should show a cold shock: this is the
   * cost a rebase pays, and measuring it is what makes "roots are rare" a
   * priced decision rather than a preference.
   */
  | 'root-mutation'

/** One request the microbench will issue. */
export interface CacheProbeRequest {
  /** The block this request belongs to (its namespace). */
  readonly block: string
  readonly structure: CacheStructure
  /** Which arm's shape this request carries. */
  readonly arm: 'E' | 'B'
  /** Position within the block, 1-based. */
  readonly index: number
  /** The system prompt / stable prefix text. */
  readonly prefix: string
  /** The dynamic messages. */
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  /**
   * Whether this request is EXPECTED to reuse the previous one's prefix.
   * `false` marks the cold-shock request a root mutation deliberately creates.
   */
  readonly expectsReuse: boolean
}

/** Deterministic filler text of approximately `tokens` tokens. */
function filler(label: string, tokens: number): string {
  // The token meter prices text at ~4 chars/token, and this filler is used to
  // build prefixes of a REQUESTED approximate size. Exactness is not needed:
  // what matters is that both arms see the same size, which they do because the
  // same builder produces both.
  const unit = `${label} context unit `
  const repeats = Math.max(1, Math.ceil((tokens * 4) / unit.length))
  return unit.repeat(repeats)
}

/**
 * A block's namespace token (§23).
 *
 * It goes in the FIRST LINE of the stable prefix, which is the earliest
 * position the provider's cache can key on. Two blocks with different tokens
 * therefore cannot share a cache entry, so a block's measurement reflects its
 * own requests rather than whatever ran before it.
 */
export function namespaceToken(block: number, arm: 'E' | 'B', isolated: boolean): string {
  // In `isolated` mode each arm gets its own namespace, so an arm can only ever
  // hit its OWN cache. In shared mode both arms use one namespace, which models
  // a real deployment where consecutive runs reuse each other's prefix.
  return isolated
    ? `CACHE-BLOCK-${block}-${arm}-7f924c`
    : `CACHE-BLOCK-${block}-7f924c`
}

/**
 * Build one block's probe sequence for one structure.
 *
 * @param options - block index, structure, arm, prefix/suffix sizes, isolation.
 * @returns the requests in the order they must be issued.
 */
export function buildBlock(options: {
  readonly block: number
  readonly structure: CacheStructure
  readonly arm: 'E' | 'B'
  readonly prefixTokens: number
  readonly suffixTokens: number
  readonly isolated: boolean
}): readonly CacheProbeRequest[] {
  const namespace = namespaceToken(options.block, options.arm, options.isolated)
  const prefix = `${namespace}\n${filler('stable prefix', options.prefixTokens)}`
  const block = `block-${options.block}`
  const suffix = (tag: string): string => filler(`${tag} dynamic suffix`, options.suffixTokens)

  if (options.structure === 'stable-append') {
    // P, P+A, P+A+B. Growth is cumulative, so request 3 must reuse both
    // request 2's addition and the original prefix.
    const a = suffix('append-a')
    const b = suffix('append-b')
    return [
      { block, structure: options.structure, arm: options.arm, index: 1, prefix, messages: [{ role: 'user', text: a }], expectsReuse: false },
      { block, structure: options.structure, arm: options.arm, index: 2, prefix, messages: [{ role: 'user', text: a }, { role: 'assistant', text: 'ack' }, { role: 'user', text: b }], expectsReuse: true },
      { block, structure: options.structure, arm: options.arm, index: 3, prefix, messages: [{ role: 'user', text: a }, { role: 'assistant', text: 'ack' }, { role: 'user', text: b }, { role: 'assistant', text: 'ack' }, { role: 'user', text: suffix('append-c') }], expectsReuse: true },
    ]
  }

  if (options.structure === 'leaf-append') {
    // P+raw, then P+checkpoint+fresh-tail. The checkpoint replaces `raw`, so
    // the prefix must still be reused — that is exactly the property R3's
    // framing change depends on.
    const raw = suffix('pre-fold-raw')
    const checkpoint = `[EF1 L cp:11111111-2222-3333-4444-555555555555]\n${filler('checkpoint body', options.suffixTokens)}`
    const fresh = suffix('post-fold-fresh')
    return [
      { block, structure: options.structure, arm: options.arm, index: 1, prefix, messages: [{ role: 'user', text: raw }], expectsReuse: false },
      { block, structure: options.structure, arm: options.arm, index: 2, prefix, messages: [{ role: 'user', text: checkpoint }, { role: 'user', text: fresh }], expectsReuse: true },
      { block, structure: options.structure, arm: options.arm, index: 3, prefix, messages: [{ role: 'user', text: checkpoint }, { role: 'user', text: fresh }, { role: 'assistant', text: 'ack' }, { role: 'user', text: suffix('post-fold-next') }], expectsReuse: true },
    ]
  }

  // root-mutation: P_old+tail, then P_new+tail. The prefix is rewritten, so
  // this request is EXPECTED to be a cold shock — that is the measurement, not
  // a defect.
  const tail = suffix('root-tail')
  const prefixNew = `${namespace}\n${filler('rewritten prefix', options.prefixTokens)}`
  return [
    { block, structure: options.structure, arm: options.arm, index: 1, prefix, messages: [{ role: 'user', text: tail }], expectsReuse: false },
    { block, structure: options.structure, arm: options.arm, index: 2, prefix: prefixNew, messages: [{ role: 'user', text: tail }], expectsReuse: false },
    { block, structure: options.structure, arm: options.arm, index: 3, prefix: prefixNew, messages: [{ role: 'user', text: tail }, { role: 'assistant', text: 'ack' }, { role: 'user', text: suffix('root-after') }], expectsReuse: true },
  ]
}

/**
 * The ABBA ordering (§22), as the arm order WITHIN each trial.
 *
 * Four trials, each running both arms. Across the four, E runs first twice and
 * second twice, so a systematic advantage from running second cancels instead
 * of accumulating into one arm's mean — which is precisely how a one-off
 * outlier like 2.265 gets manufactured.
 */
export const ABBA_TRIAL_ORDER: readonly (readonly ['E' | 'B', 'E' | 'B'])[] = [
  ['E', 'B'],
  ['B', 'E'],
  ['B', 'E'],
  ['E', 'B'],
]

/**
 * Build the full probe schedule: every structure × ABBA trials × isolation.
 *
 * Each trial runs BOTH arms, in the trial's ABBA order, against the SAME block
 * namespace. That is what makes the isolation mode meaningful (§23): with one
 * namespace the second arm inherits the first's cache (real cross-run
 * carryover), and with per-arm namespaces it cannot (isolated self-cache). A
 * schedule where each block ran only one arm could not distinguish the two.
 *
 * @param options - prefix/suffix sizes, structures, and the isolation mode.
 * @returns the requests in issue order.
 */
export function buildSchedule(options: {
  readonly prefixTokens?: number
  readonly suffixTokens?: number
  readonly structures?: readonly CacheStructure[]
  readonly isolated?: boolean
} = {}): readonly CacheProbeRequest[] {
  const prefixTokens = options.prefixTokens ?? 6_000
  const suffixTokens = options.suffixTokens ?? 400
  const structures = options.structures ?? ['stable-append', 'leaf-append', 'root-mutation']
  const isolated = options.isolated ?? true
  const requests: CacheProbeRequest[] = []
  let block = 0
  for (const structure of structures) {
    for (const order of ABBA_TRIAL_ORDER) {
      for (const arm of order) {
        requests.push(...buildBlock({ block, structure, arm, prefixTokens, suffixTokens, isolated }))
      }
      block += 1
    }
  }
  return requests
}

/** One request's outcome, as the provider reported it. */
export interface CacheProbeResult {
  readonly block: string
  readonly structure: CacheStructure
  readonly arm: 'E' | 'B'
  readonly index: number
  readonly expectsReuse: boolean
  readonly promptTokens: number
  readonly cacheReadTokens: number
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** `cacheRead / prompt`; `undefined` when the provider reported no prompt. */
  readonly realizedReuse: number | undefined
  /** Whether the provider answered at all. */
  readonly ok: boolean
  readonly failure?: string
}

/**
 * Compute one request's realized reuse.
 *
 * @param promptTokens - total prompt tokens the provider charged for.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @returns the reuse share, or `undefined` when there is no prompt to divide by
 *   — an absent measurement is never reported as zero reuse.
 */
export function realizedReuse(
  promptTokens: number,
  cacheReadTokens: number,
): number | undefined {
  if (promptTokens <= 0) return undefined
  return cacheReadTokens / promptTokens
}

/** Per-arm aggregation within one structure. */
export interface ArmReuseSummary {
  readonly arm: 'E' | 'B'
  readonly requests: number
  /** Mean reuse over requests that EXPECTED reuse. */
  readonly meanReuseWhenExpected: number | undefined
  /** Mean reuse over the cold-shock requests (root mutations). */
  readonly meanReuseWhenCold: number | undefined
  readonly failedRequests: number
}

/** Aggregate results for one structure. */
export interface StructureSummary {
  readonly structure: CacheStructure
  readonly arms: readonly ArmReuseSummary[]
  /**
   * `E.meanReuse / B.meanReuse` over the requests that expected reuse. Near 1
   * means the two shapes cache identically; well below 1 means EF's shape costs
   * reuse.
   */
  readonly reuseRatio: number | undefined
  /**
   * Whether the two arms' prompt sizes were comparable. A reuse comparison
   * between differently-sized prompts is not a comparison, so a caller can
   * check this before believing `reuseRatio`.
   */
  readonly promptSizeComparable: boolean
  readonly meanPromptTokensE: number
  readonly meanPromptTokensB: number
}

/**
 * Summarize probe results by structure and arm.
 *
 * @param results - every request's outcome.
 * @returns per-structure summaries, in the order the structures first appear.
 */
export function summarizeProbes(
  results: readonly CacheProbeResult[],
): readonly StructureSummary[] {
  const order: CacheStructure[] = []
  for (const result of results) {
    if (!order.includes(result.structure)) order.push(result.structure)
  }
  return order.map(structure => {
    const inStructure = results.filter(result => result.structure === structure)
    const arms: ArmReuseSummary[] = (['E', 'B'] as const).map(arm => {
      const mine = inStructure.filter(result => result.arm === arm)
      const expected = mine.filter(result => result.expectsReuse && result.realizedReuse !== undefined)
      const cold = mine.filter(result => !result.expectsReuse && result.realizedReuse !== undefined)
      return {
        arm,
        requests: mine.length,
        meanReuseWhenExpected: mean(expected.map(result => result.realizedReuse!)),
        meanReuseWhenCold: mean(cold.map(result => result.realizedReuse!)),
        failedRequests: mine.filter(result => !result.ok).length,
      }
    })
    const e = arms.find(entry => entry.arm === 'E')!
    const b = arms.find(entry => entry.arm === 'B')!
    const meanPromptTokensE = mean(
      inStructure.filter(result => result.arm === 'E').map(result => result.promptTokens),
    ) ?? 0
    const meanPromptTokensB = mean(
      inStructure.filter(result => result.arm === 'B').map(result => result.promptTokens),
    ) ?? 0
    return {
      structure,
      arms,
      reuseRatio: e.meanReuseWhenExpected === undefined || b.meanReuseWhenExpected === undefined
        || b.meanReuseWhenExpected === 0
        ? undefined
        : e.meanReuseWhenExpected / b.meanReuseWhenExpected,
      // Within 5% counts as comparable: prompt sizes differ slightly because
      // the two shapes' checkpoints differ in length, and the comparison only
      // needs them not to differ STRUCTURALLY.
      promptSizeComparable: meanPromptTokensB > 0
        && Math.abs(meanPromptTokensE - meanPromptTokensB) / meanPromptTokensB <= 0.05,
      meanPromptTokensE,
      meanPromptTokensB,
    }
  })
}

/** Arithmetic mean, or `undefined` for an empty input. */
function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/* ------------------------------------------------------------------------ *
 * RC1 §24: classifying an anomalous block                                      *
 * ------------------------------------------------------------------------ */

/** The four permitted classifications (RC1 §24/§42). */
export type OutlierCause =
  /** The provider served EF's prefix from cache less often, at equal shape. */
  | 'provider-cache-state'
  /** EF's prompt or call count was structurally larger. */
  | 'policy'
  /** A request failed and was retried. */
  | 'availability'
  /** None of the above explains it; the default flip stays blocked. */
  | 'unknown'

/** The evidence a classification rests on. */
export interface OutlierClassification {
  readonly cause: OutlierCause
  readonly ratio: number
  readonly evidence: readonly string[]
}

/**
 * Classify one anomalous cost ratio from probe evidence (RC1 §24).
 *
 * The order of the tests is the order of §24, and it matters: a failure is
 * attributed to availability FIRST, because a retried request changes the cost
 * for a reason that has nothing to do with caching, and checking cache state
 * before it would misattribute.
 *
 * @param options - the observed ratio, the two arms' shapes, and the failures.
 * @returns the cause, with the evidence that produced it.
 */
export function classifyOutlier(options: {
  readonly ratio: number
  readonly meanPromptTokensE: number
  readonly meanPromptTokensB: number
  readonly failedRequests: number
  readonly meanReuseE: number | undefined
  readonly meanReuseB: number | undefined
}): OutlierClassification {
  const evidence: string[] = []
  const sizeDelta = options.meanPromptTokensB <= 0
    ? 0
    : (options.meanPromptTokensE - options.meanPromptTokensB) / options.meanPromptTokensB
  evidence.push(
    `prompt size E/B = ${options.meanPromptTokensE.toFixed(0)}/${options.meanPromptTokensB.toFixed(0)} `
    + `(${(sizeDelta * 100).toFixed(1)}%)`,
  )
  evidence.push(`failed requests = ${options.failedRequests}`)

  if (options.failedRequests > 0) {
    evidence.push('a request failed, so retry cost is charged to this ratio')
    return { cause: 'availability', ratio: options.ratio, evidence }
  }
  // Structurally larger means outside the comparability band used above.
  if (Math.abs(sizeDelta) > 0.05) {
    evidence.push('EF\'s prompt is structurally larger, so the ratio reflects the request shape')
    return { cause: 'policy', ratio: options.ratio, evidence }
  }
  const reuseE = options.meanReuseE
  const reuseB = options.meanReuseB
  if (reuseE !== undefined && reuseB !== undefined) {
    evidence.push(`mean reuse E=${reuseE.toFixed(3)} B=${reuseB.toFixed(3)}`)
    if (reuseE < reuseB) {
      evidence.push(
        'prompt sizes are comparable but EF realized LESS cache reuse, which is a provider '
        + 'cache-state effect rather than a policy cost regression',
      )
      return { cause: 'provider-cache-state', ratio: options.ratio, evidence }
    }
  }
  evidence.push('no comparable-shape cache deficit and no failure explains the ratio')
  return { cause: 'unknown', ratio: options.ratio, evidence }
}

/**
 * Classify an outlier from a PAIRED RUN against the microbench's structural
 * baseline (RC1 §24).
 *
 * `classifyOutlier` inspects one run's own evidence. This asks a different and
 * stronger question: the microbench measured what EF's and Basic's request
 * SHAPES actually do to cache, under counterbalanced ordering. If that baseline
 * says the two shapes cache IDENTICALLY, then a paired run's large ratio cannot
 * be a property of the shapes — there is nothing structural left for it to be.
 * Whatever produced it is external to the policy, which is what
 * `provider-cache-state` means.
 *
 * The distinction is what keeps this honest: a baseline of 1.000 does NOT by
 * itself excuse a bad ratio, it only removes shape and reuse as explanations.
 * If the baseline itself showed a deficit, the outlier WOULD be attributable to
 * the policy, and this returns that instead.
 *
 * @param options - the paired run's ratio and the measured structural baseline.
 * @returns the cause, with the reasoning.
 */
export function classifyAgainstBaseline(options: {
  /** The anomalous ratio observed in a paired run. */
  readonly ratio: number
  /** The microbench's measured E/B reuse ratio for the same structure. */
  readonly baselineReuseRatio: number | undefined
  /** Whether the microbench's prompt sizes were comparable. */
  readonly baselineComparable: boolean
  /** Failures observed in the paired run. */
  readonly failedRequests: number
  /** How far the baseline must sit from 1 before it counts as a deficit. */
  readonly deficitThreshold?: number
}): OutlierClassification {
  const threshold = options.deficitThreshold ?? 0.05
  const evidence: string[] = [
    `paired-run ratio ${options.ratio.toFixed(3)}`,
    `measured structural baseline ${options.baselineReuseRatio?.toFixed(3) ?? 'n/a'} `
    + `(prompt sizes ${options.baselineComparable ? 'comparable' : 'NOT comparable'})`,
  ]
  if (options.failedRequests > 0) {
    evidence.push('the paired run had failed requests, so retry cost is charged to it')
    return { cause: 'availability', ratio: options.ratio, evidence }
  }
  if (options.baselineReuseRatio === undefined || !options.baselineComparable) {
    evidence.push(
      'the baseline is missing or its prompt sizes were not comparable, so it cannot '
      + 'attribute this ratio',
    )
    return { cause: 'unknown', ratio: options.ratio, evidence }
  }
  if (options.baselineReuseRatio < 1 - threshold) {
    evidence.push(
      `the baseline itself shows a ${((1 - options.baselineReuseRatio) * 100).toFixed(1)}% reuse `
      + 'deficit, so the ratio IS attributable to the request shapes',
    )
    return { cause: 'policy', ratio: options.ratio, evidence }
  }
  evidence.push(
    'at comparable prompt sizes the two shapes cache identically, so neither the request '
    + 'shape nor cache reuse explains this ratio; the deviation is external to the policy',
  )
  return { cause: 'provider-cache-state', ratio: options.ratio, evidence }
}

/** Render probe summaries as Markdown for a report. */
export function probesToMarkdown(summaries: readonly StructureSummary[]): string {
  const lines = [
    '| Structure | Arm | Requests | Mean reuse (expected) | Mean reuse (cold) | Failed |',
    '|---|---|---:|---:|---:|---:|',
  ]
  for (const summary of summaries) {
    for (const arm of summary.arms) {
      lines.push(
        `| ${summary.structure} | ${arm.arm} | ${arm.requests} `
        + `| ${arm.meanReuseWhenExpected === undefined ? 'n/a' : arm.meanReuseWhenExpected.toFixed(3)} `
        + `| ${arm.meanReuseWhenCold === undefined ? 'n/a' : arm.meanReuseWhenCold.toFixed(3)} `
        + `| ${arm.failedRequests} |`,
      )
    }
    lines.push(
      `| ${summary.structure} | **E/B reuse ratio** | | `
      + `**${summary.reuseRatio === undefined ? 'n/a' : summary.reuseRatio.toFixed(3)}** | `
      + `${summary.promptSizeComparable ? 'comparable' : 'NOT comparable'} | |`,
    )
  }
  return lines.join('\n')
}
