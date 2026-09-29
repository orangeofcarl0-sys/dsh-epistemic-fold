/**
 * R4-E: live paired non-inferiority across scenario families.
 *
 * R3-F validated ONE chain with three facts. That was enough to prove the
 * rebase path runs and preserves state once, but a production default needs
 * more: R4 §29 asks for at least four scenario families × five replicates,
 * and §30 names the four families, because a policy can be fine at remembering
 * a value and bad at noticing a SUPERSEDED one.
 *
 * The families:
 *
 *   constraint      a hard normative limit that must survive folding
 *   supersession    a value that CHANGED, where recalling the old one is a
 *                   failure — the family most likely to catch a state bug
 *   obligation      an open, unresolved failure that must still read as open
 *   delayed-exact   a verbatim token (an error code) only recoverable from the
 *                   folded archive, so it tests exact recall specifically
 *
 * Each scenario must experience MULTIPLE leaf folds and at least one root
 * rebase (§30), or it degenerates into the single-fold test R3 already had.
 * That requirement is asserted, not assumed — the same vacuity guard lesson
 * that caught the first R3-F attempt reporting a pass on one fold.
 *
 * Three arms (§31), so a regression can be attributed:
 *
 *   B1  Basic            the incumbent
 *   E0  legacy EF        the R0/R1 policy
 *   E4  economy EF       the candidate preset
 *
 * The quality bar is NON-INFERIORITY (§32): `Q_economy >= Q_basic - ε` and
 * `Q_economy >= Q_legacy - ε`. Proving EF strictly better is not required to
 * ship an economy mode, and demanding it would be moving the goalposts.
 *
 * @module eval/live/scenarios
 */

/** One planted fact and the machine check for it. */
export interface ScenarioFact {
  /** The scenario family this fact belongs to. */
  readonly family: 'constraint' | 'supersession' | 'obligation' | 'delayed-exact'
  /** Verbatim text planted early in the conversation. */
  readonly plant: string
  /** Probe asked at the end. */
  readonly probe: string
  /** Machine check on the answer, so scoring is not a judgement call. */
  readonly check: (answer: string) => boolean
  /** How the EF arms carry it as machine state. */
  readonly anchor: {
    readonly kind: 'constraint' | 'value' | 'failure'
    readonly authority: 'normative' | 'decision' | 'empirical'
    readonly value: unknown
    readonly stateKey: { readonly namespace: string; readonly entity: string; readonly property: string }
  }
  /**
   * Whether the fact needs an EMPIRICAL source (a tool result) rather than a
   * user message. Authority must terminate at raw roots, and a failure claim
   * cannot be grounded in prose.
   */
  readonly needsToolResult?: boolean
}

/** Every scenario family, with one fact each. */
export const SCENARIO_FACTS: readonly ScenarioFact[] = [
  {
    family: 'constraint',
    plant:
      'Hard constraint: the public API must NOT change. No new required parameters and no renamed fields '
      + 'are permitted, under any circumstances.',
    probe: 'May I add a new required parameter to the public API endpoint? Answer yes or no, then one short sentence.',
    check: answer => /\bno\b/iu.test(answer.slice(0, 40)),
    anchor: {
      kind: 'constraint', authority: 'normative',
      value: 'the public API must not change',
      stateKey: { namespace: 'scope', entity: 'work', property: 'public-api' },
    },
  },
  {
    family: 'supersession',
    plant:
      'Configuration history: the worker timeout was 30 seconds, and after the incident review it is now '
      + '60 seconds. The value 30 is superseded and must not be reused.',
    probe: 'What is the current worker timeout in seconds? Reply with only the number.',
    // The superseded value appearing anywhere is a FAILURE — this is the check
    // that catches a state bug the other families would miss.
    check: answer => /\b60\b/u.test(answer) && !/\b30\b/u.test(answer),
    anchor: {
      kind: 'value', authority: 'decision', value: 60,
      stateKey: { namespace: 'config', entity: 'worker', property: 'timeout' },
    },
  },
  {
    family: 'obligation',
    plant:
      'Known unresolved failure: 2 tests in the parser module fail with an unexpected token at line 42. '
      + 'This is not fixed yet and remains open.',
    probe: 'Is there any known unresolved failure in the parser module? Answer yes or no.',
    check: answer => /\byes\b/iu.test(answer.slice(0, 40)),
    anchor: {
      kind: 'failure', authority: 'empirical', value: '2 tests fail in the parser module',
      stateKey: { namespace: 'failure', entity: 'test', property: 'parser' },
    },
    needsToolResult: true,
  },
  {
    family: 'delayed-exact',
    plant:
      'Diagnostic code registry entry: the parser emits PARSE-7741 when it encounters an unexpected token, '
      + 'and downstream tooling matches on that exact string. It must not be renamed or renumbered.',
    probe: 'What is the exact diagnostic code the parser emits for an unexpected token? Reply with only the code.',
    // Exact string, not a paraphrase: this family tests whether the folded
    // archive is recoverable verbatim.
    check: answer => answer.includes('PARSE-7741'),
    anchor: {
      kind: 'value', authority: 'decision', value: 'PARSE-7741',
      stateKey: { namespace: 'config', entity: 'parser', property: 'diagnostic-code' },
    },
  },
]

/** One arm under test. */
export interface ScenarioArm {
  readonly id: string
  readonly basic: boolean
  /** Whether this arm performs idle maintenance (rebase). */
  readonly idleMaintenance: boolean
  /** EF config additions; ignored for Basic. */
  readonly config: Readonly<Record<string, unknown>>
}

/** The three arms R4 §31 requires. */
export const SCENARIO_ARMS: readonly ScenarioArm[] = [
  { id: 'B1-basic', basic: true, idleMaintenance: false, config: {} },
  { id: 'E0-legacy', basic: false, idleMaintenance: false, config: {} },
  {
    id: 'E4-economy',
    basic: false,
    idleMaintenance: true,
    config: {
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'none',
      framingMode: 'system-dedup',
      // Sized so the frozen prefix actually crosses it within the horizon,
      // which is what justifies a rebase. Checkpoints in a compressed window
      // carry only a marker, so a default-sized budget never trips.
      frozenCheckpointTokenBudget: 100,
    },
  },
]

/** One replicate's outcome. */
export interface ScenarioReplicate {
  readonly arm: string
  readonly family: string
  /**
   * Which replicate this observation came from. REQUIRED for pairing: the
   * comparison is per (family, replicate), because the two arms must be judged
   * on the SAME trajectory rather than on aggregate pass counts.
   */
  readonly replicate: number
  /** Whether the machine check passed. */
  readonly passed: boolean
  /** The model's raw answer, kept for diagnosis. */
  readonly answer: string
  readonly folds: number
  readonly roots: number
}

/** Per-family, per-arm tally across replicates. */
export interface ScenarioTally {
  readonly arm: string
  readonly family: string
  readonly passed: number
  readonly total: number
}

/** Fold a replicate list into per-(arm, family) tallies. */
export function tallyScenarios(replicates: readonly ScenarioReplicate[]): readonly ScenarioTally[] {
  const tallies = new Map<string, { arm: string; family: string; passed: number; total: number }>()
  for (const replicate of replicates) {
    const key = `${replicate.arm}\u0000${replicate.family}`
    const existing = tallies.get(key) ?? { arm: replicate.arm, family: replicate.family, passed: 0, total: 0 }
    existing.total += 1
    if (replicate.passed) existing.passed += 1
    tallies.set(key, existing)
  }
  return [...tallies.values()].sort((left, right) =>
    left.arm === right.arm
      ? left.family.localeCompare(right.family)
      : left.arm.localeCompare(right.arm))
}

/**
 * One paired comparison's outcome (RC0-D).
 *
 * The four cells exist because the DANGEROUS one is not "candidate scored
 * lower" in aggregate — it is the specific case where the reference got it
 * right and the candidate did not. That is a candidate-only regression, and it
 * is the thing a default flip must not introduce.
 */
export interface PairedOutcome {
  /** Both passed: agreement, not evidence of quality. */
  readonly bothPass: number
  /** Reference passed, candidate FAILED — the candidate-only regression. */
  readonly referenceOnlyPass: number
  /** Candidate passed, reference failed — a candidate win. */
  readonly candidateOnlyPass: number
  /** Both failed: usually a scenario or harness problem, not a policy one. */
  readonly bothFail: number
  /** Pairs that could not be formed (a missing or duplicate observation). */
  readonly unpaired: number
}

/**
 * Non-inferiority verdict for one arm against a reference (R4 §32, RC0-D).
 *
 * **RC0-D replaced the aggregate-count rule with a pairwise one.** The old
 * version compared total passes with `epsilon = ceil(total * 0.1)`, which at
 * `n = 1` gave `epsilon = 1` and therefore declared "Basic 1/1, candidate 0/1"
 * NON-INFERIOR. A helper that passes a candidate which failed everything is not
 * a release gate, and R4's real result (20/20 vs 20/20) was never affected by
 * it — but it would have become the long-term regression gate after a flip.
 *
 * The gate is now stated on the count that actually matters:
 *
 *   N(reference pass, candidate fail) <= epsilon
 *
 * so a single candidate-only regression on a probe the reference got right is
 * visible immediately instead of being absorbed by a favourable aggregate.
 */
export interface NonInferiorityVerdict {
  readonly candidate: string
  readonly reference: string
  readonly outcomes: PairedOutcome
  /** Paired observations actually compared. */
  readonly pairs: number
  /** Absolute candidate-only regressions the gate tolerates. */
  readonly epsilon: number
  readonly nonInferior: boolean
  /** Candidate wins minus candidate-only regressions; a tie is 0. */
  readonly netWins: number
  readonly reason: string
}

/**
 * Compare two arms PAIRWISE, by (family, replicate).
 *
 * @param options - the two arms' observations and the tolerated regression count.
 * @returns the paired outcome counts and the verdict.
 */
export function nonInferiority(options: {
  readonly candidate: readonly ScenarioReplicate[]
  readonly reference: readonly ScenarioReplicate[]
  readonly candidateId: string
  readonly referenceId: string
  /**
   * Candidate-only regressions the gate tolerates. Defaults to 0: RC0's first
   * default-flip gate is deliberately strict ("not worse than Basic" needs no
   * statistical margin), and a margin can be introduced once N is large enough
   * to justify one.
   */
  readonly epsilon?: number
}): NonInferiorityVerdict {
  const epsilon = options.epsilon ?? 0
  const key = (entry: ScenarioReplicate): string => `${entry.family}\u0000${entry.replicate}`
  const referenceByKey = new Map(options.reference.map(entry => [key(entry), entry]))

  let bothPass = 0
  let referenceOnlyPass = 0
  let candidateOnlyPass = 0
  let bothFail = 0
  let unpaired = 0
  const seen = new Set<string>()

  for (const candidate of options.candidate) {
    const mapKey = key(candidate)
    const reference = referenceByKey.get(mapKey)
    if (reference === undefined) {
      // A candidate observation with no reference counterpart cannot be
      // compared. It is reported rather than silently dropped, because a
      // systematically missing reference would otherwise look like a clean run.
      unpaired += 1
      continue
    }
    seen.add(mapKey)
    if (reference.passed && candidate.passed) bothPass += 1
    else if (reference.passed && !candidate.passed) referenceOnlyPass += 1
    else if (!reference.passed && candidate.passed) candidateOnlyPass += 1
    else bothFail += 1
  }
  // Reference observations with no candidate counterpart are also unpaired.
  for (const reference of options.reference) {
    if (!seen.has(key(reference))) unpaired += 1
  }

  const pairs = bothPass + referenceOnlyPass + candidateOnlyPass + bothFail
  const netWins = candidateOnlyPass - referenceOnlyPass
  const nonInferior = referenceOnlyPass <= epsilon
  return {
    candidate: options.candidateId,
    reference: options.referenceId,
    outcomes: { bothPass, referenceOnlyPass, candidateOnlyPass, bothFail, unpaired },
    pairs,
    epsilon,
    nonInferior,
    netWins,
    reason: nonInferior
      ? `${options.candidateId} vs ${options.referenceId}: ${pairs} paired probes, `
        + `${referenceOnlyPass} candidate-only regression(s) <= epsilon ${epsilon} `
        + `(both-pass ${bothPass}, candidate-only wins ${candidateOnlyPass}, both-fail ${bothFail}`
        + `${unpaired === 0 ? '' : `, UNPAIRED ${unpaired}`})`
      : `${options.candidateId} vs ${options.referenceId}: ${referenceOnlyPass} candidate-only `
        + `regression(s) > epsilon ${epsilon} — the reference passed probes the candidate failed `
        + `(pairs ${pairs}, both-pass ${bothPass})`,
  }
}

/**
 * Availability and retry load, kept separate from semantic quality (RC0-D).
 *
 * A transport failure is correctly NOT a quality error — the model was never
 * asked. But it is not nothing either: if the candidate needs 20 retries to
 * reach the same answers the reference reached with none, the two are not
 * equivalent products. Conflating the two is how a reliability regression gets
 * recorded as a quality result, in either direction.
 */
export interface AvailabilitySummary {
  readonly arm: string
  /** Probes that produced an answer, over probes attempted. */
  readonly answered: number
  readonly attempted: number
  /** `answered / attempted`; 1 when nothing was attempted. */
  readonly availability: number
  /** Provider attempts that returned nothing and had to be retried. */
  readonly transportFailures: number
  /** `transportFailures / attempted`; the retry load the arm imposes. */
  readonly retryRate: number
}

/** Summarize one arm's availability from its observed and failed probes. */
export function summarizeAvailability(options: {
  readonly arm: string
  readonly answered: number
  readonly transportFailures: number
}): AvailabilitySummary {
  const attempted = options.answered + options.transportFailures
  return {
    arm: options.arm,
    answered: options.answered,
    attempted,
    availability: attempted === 0 ? 1 : options.answered / attempted,
    transportFailures: options.transportFailures,
    retryRate: attempted === 0 ? 0 : options.transportFailures / attempted,
  }
}

/**
 * Availability non-inferiority: `A_candidate >= A_reference - epsilon_A`.
 *
 * Reported alongside semantic quality, never merged into it.
 */
export function availabilityNonInferior(options: {
  readonly candidate: AvailabilitySummary
  readonly reference: AvailabilitySummary
  readonly epsilon?: number
}): { readonly nonInferior: boolean; readonly reason: string } {
  const epsilon = options.epsilon ?? 0.05
  const shortfall = options.reference.availability - options.candidate.availability
  // Boundary comparison on ratios needs a tolerance: `1 - 0.95` evaluates to
  // 0.050000000000000044, so a gate stated at exactly 0.05 would FAIL a
  // candidate that sits precisely on its threshold. The gate's contract is
  // `>=`, so a floating-point artifact must not flip it.
  const TOLERANCE = 1e-9
  const nonInferior = shortfall <= epsilon + TOLERANCE
  return {
    nonInferior,
    reason: `availability ${options.candidate.arm} ${options.candidate.availability.toFixed(3)} vs `
      + `${options.reference.arm} ${options.reference.availability.toFixed(3)}; `
      + `shortfall ${shortfall.toFixed(3)} ${nonInferior ? '<=' : '>'} epsilon ${epsilon}`
      + ` (retry rates ${options.candidate.retryRate.toFixed(3)} vs ${options.reference.retryRate.toFixed(3)})`,
  }
}

/** Render the family-by-arm table for a report. */
export function scenariosToMarkdown(tallies: readonly ScenarioTally[], arms: readonly string[]): string {
  const families = [...new Set(tallies.map(tally => tally.family))].sort()
  const lines = [
    `| Family | ${arms.join(' | ')} |`,
    `|---|${arms.map(() => '---:').join('|')}|`,
  ]
  for (const family of families) {
    const cells = arms.map(arm => {
      const tally = tallies.find(entry => entry.arm === arm && entry.family === family)
      return tally === undefined ? 'n/a' : `${tally.passed}/${tally.total}`
    })
    lines.push(`| ${family} | ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}
