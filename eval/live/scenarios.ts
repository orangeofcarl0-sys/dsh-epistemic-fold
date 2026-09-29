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
 * Non-inferiority verdict for one arm against a reference (R4 §32).
 *
 * The bar is `candidate >= reference - epsilon` on the pass COUNT, with the
 * epsilon expressed as a fraction of the reference's total so it means the
 * same thing at any replicate count. It deliberately does NOT require the
 * candidate to be better: R4 §32 states that proving superiority is not a
 * precondition for shipping an economy mode.
 */
export interface NonInferiorityVerdict {
  readonly candidate: string
  readonly reference: string
  readonly candidatePassed: number
  readonly referencePassed: number
  readonly total: number
  /** Absolute passes the candidate may trail by and still count as equal. */
  readonly epsilon: number
  readonly nonInferior: boolean
  readonly reason: string
}

/** Evaluate non-inferiority of one arm against a reference arm. */
export function nonInferiority(options: {
  readonly candidate: readonly ScenarioReplicate[]
  readonly reference: readonly ScenarioReplicate[]
  readonly candidateId: string
  readonly referenceId: string
  /** Fraction of the reference's total that a shortfall may reach. */
  readonly epsilonRatio?: number
}): NonInferiorityVerdict {
  const epsilonRatio = options.epsilonRatio ?? 0.1
  const candidatePassed = options.candidate.filter(r => r.passed).length
  const referencePassed = options.reference.filter(r => r.passed).length
  const total = options.reference.length
  const epsilon = Math.ceil(total * epsilonRatio)
  const shortfall = referencePassed - candidatePassed
  const nonInferior = shortfall <= epsilon
  return {
    candidate: options.candidateId,
    reference: options.referenceId,
    candidatePassed,
    referencePassed,
    total,
    epsilon,
    nonInferior,
    reason: nonInferior
      ? `${options.candidateId} ${candidatePassed}/${total} vs ${options.referenceId} ${referencePassed}/${total}; `
        + `shortfall ${shortfall} <= epsilon ${epsilon}`
      : `${options.candidateId} ${candidatePassed}/${total} vs ${options.referenceId} ${referencePassed}/${total}; `
        + `shortfall ${shortfall} > epsilon ${epsilon}`,
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
