/**
 * Scoring: extraction, claim correctness, grounding, delivery, and behaviour.
 *
 * ## What R33 got wrong
 *
 * `extractionMetrics` tried an exact statement match and, when that failed,
 * accepted ANY gold fact at the same coordinate. A delta that said "must remove
 * the legacy API" therefore scored as correct against gold "must preserve the
 * legacy API" — the same coordinate, the opposite claim. That fallback is gone.
 *
 * Correctness is now three separate observations:
 *
 *   coordinateRecall   a proposal exists at the right subject (weak: it may say
 *                      the opposite, or carry the wrong status)
 *   claimCorrectness   the statement matches the frozen gold statement
 *   sourceSupport      the proposal's OWN evidence quotes occur in the gold
 *                      fact's cited source messages
 *
 * A same-coordinate different-statement proposal is `requires-review`. It is
 * never counted as correct, and it is not automatically counted as false: the
 * instrument cannot prove contradiction from one string, and pretending to
 * would be a fabricated verdict.
 *
 * ## Versioning
 *
 * `SCORER_VERSION` changes whenever the interpretation of a number changes.
 * R33's scorer v1 used the coordinate fallback; v2 does not. Reports carry the
 * scorer version, and the R33.1 audit records old/new values per affected case.
 *
 * @module eval/r33/src/grade
 */

export const SCORER_VERSION = 2

/** The exact scorer whose numbers R33 published, kept for audit comparison. */
export const SCORER_V1_NOTE = 'coordinate fallback counted a same-subject counter-claim as correct'

const NORMATIVE = new Set(['constraint', 'objective', 'obligation'])
const WEIGHT = { high: 3, medium: 2, low: 1 }

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** Scope participates in identity: two branches may hold the same subjectKey. */
function scopeKey(scope) {
  if (scope === undefined || scope === null) return ''
  return Object.keys(scope).sort().map(key => `${key}=${scope[key]}`).join('&')
}

function factKey(kind, subjectKey, scope) {
  return `${kind}#${subjectKey}#${scopeKey(scope)}`
}

/**
 * The verification state a gold fact should carry.
 *
 * Derived from the AUTHORITY of its citation, not from a hand-written table:
 * a fact whose authoritative source includes a tool result is an observation;
 * a fact grounded only in user/assistant speech is a claim. An explicit
 * `expectedStatus` overrides this when a case needs to say so.
 */
function expectedStatusOf(fact, transcript) {
  if (typeof fact.expectedStatus === 'string') return fact.expectedStatus
  if (Array.isArray(transcript)) {
    const roles = fact.sourceRefs.map(ref => transcript[ref]?.role)
    if (roles.includes('tool')) return 'observed'
  }
  return fact.kind === 'finding' ? 'observed' : 'claimed'
}

function evidenceQuotes(delta) {
  if (!Array.isArray(delta.evidence)) return []
  return delta.evidence
    .map(entry => entry !== null && typeof entry === 'object' ? entry.quote : undefined)
    .filter(quote => typeof quote === 'string' && quote.length > 0)
}

function sourceTexts(fact, transcript) {
  if (!Array.isArray(transcript)) return undefined
  return fact.sourceRefs
    .map(ref => transcript[ref]?.text)
    .filter(text => typeof text === 'string')
}

/**
 * Gold quote provenance, bound to the message each `sourceRef` names.
 *
 * The schema already refuses a quote that is absent from the whole transcript.
 * This binds it to EVERY cited message and records the DSH event seq of each
 * source, so an attribution can point at a log position rather than an array
 * index.
 *
 * @param {object} caseData - frozen case.
 * @param {readonly number[]} [eventSeqs] - transcript index -> DSH event seq.
 */
export function sourceBindings(caseData, eventSeqs) {
  return caseData.gold.map(fact => {
    const refs = fact.sourceRefs.map(index => {
      const entry = caseData.transcript[index]
      return {
        transcriptIndex: index,
        eventSeq: Array.isArray(eventSeqs) ? eventSeqs[index] ?? null : null,
        role: entry?.role ?? null,
        name: entry?.name ?? null,
        containsQuote: typeof entry?.text === 'string' && entry.text.includes(fact.quote),
      }
    })
    return {
      factId: fact.factId,
      quote: fact.quote,
      refs,
      /// True only when EVERY cited message contains the quote.
      quoteBoundToEveryRef: refs.length > 0 && refs.every(ref => ref.containsQuote),
      authority: refs.some(ref => ref.role === 'user') ? 'user'
        : refs.some(ref => ref.role === 'tool') ? 'tool'
          : refs.some(ref => ref.role === 'assistant') ? 'assistant' : 'unknown',
    }
  })
}

/**
 * Compute extraction, state, and direct-visibility metrics for one fold.
 *
 * @param {object} caseData - frozen case.
 * @param {object} input
 * @param {readonly object[]|undefined} input.accepted - accepted deltas.
 * @param {readonly object[]|undefined} input.refused - refused proposals.
 * @param {object|undefined} input.writer - writer observation.
 * @param {string} input.checkpoint - visible checkpoint body.
 * @param {readonly string[]} input.anchorValues - values of the replayed state.
 * @param {readonly object[]|undefined} input.transcript - frozen transcript.
 * @returns {object} metrics with denominators.
 */
export function extractionMetrics(caseData, input) {
  const { accepted, refused, writer, checkpoint, anchorValues, transcript } = input
  if (accepted === undefined || caseData.historyIndependent === true) {
    return {
      scorerVersion: SCORER_VERSION,
      applicable: false,
      reason: accepted === undefined
        ? 'this arm commits no semantic deltas'
        : 'history-independent control: there is no memory extraction to score',
      writer: writer ?? null,
      criticalRecall: null,
      coordinateRecall: null,
      claimCorrectness: null,
      sourceSupport: null,
      groundedPrecision: null,
      falseNormativeRate: null,
      currentStateAccuracy: null,
      directVisibility: null,
      requiresReview: null,
      counts: { gold: caseData.gold.length, matched: 0, accepted: 0, refused: 0 },
    }
  }

  const goldByStatement = new Map()
  const goldByCoordinate = new Map()
  for (const fact of caseData.gold) {
    const key = factKey(fact.kind, fact.subjectKey, fact.scope)
    const statement = `${key}#${normalize(fact.statement)}`
    goldByStatement.set(statement, fact)
    const bucket = goldByCoordinate.get(key) ?? []
    bucket.push(fact)
    goldByCoordinate.set(key, bucket)
  }

  const used = new Set()
  const matched = []
  const review = []
  const unsupported = []
  const unsupportedNormative = []
  const reviewNormative = []

  for (const delta of accepted) {
    const coordinate = factKey(delta.kind, delta.subjectKey, delta.scope)
    const exact = goldByStatement.get(`${coordinate}#${normalize(delta.statement)}`)
    const sameCoordinate = goldByCoordinate.get(coordinate) ?? []
    if (exact !== undefined && !used.has(exact.factId)) {
      const statusMismatch = typeof delta.status === 'string'
        && delta.status !== expectedStatusOf(exact, transcript)
      const texts = sourceTexts(exact, transcript)
      const quotes = evidenceQuotes(delta)
      // One authoritative quote is enough to ground the claim. A delta may
      // cite corroborating narrative as well; requiring EVERY quote to be in
      // the authoritative source would reject a correctly grounded claim that
      // also points at the assistant's summary of it.
      const support = texts === undefined
        ? null
        : quotes.some(quote => texts.some(text => text.includes(quote)))
      if (statusMismatch) {
        review.push({ delta, fact: exact, reason: 'verification-state' })
      } else {
        matched.push({ delta, fact: exact, sourceSupported: support })
        used.add(exact.factId)
      }
      continue
    }
    if (sameCoordinate.length > 0) {
      review.push({ delta, fact: sameCoordinate.find(fact => !used.has(fact.factId)) ?? sameCoordinate[0], reason: 'claim-mismatch' })
      if (NORMATIVE.has(delta.kind)) reviewNormative.push(delta)
    } else {
      unsupported.push(delta)
      if (NORMATIVE.has(delta.kind)) unsupportedNormative.push(delta)
    }
  }

  const matchedFacts = new Set(matched.map(entry => entry.fact.factId))
  const coordinateFacts = new Set([
    ...matched.map(entry => entry.fact.factId),
    ...review.map(entry => entry.fact?.factId).filter(id => id !== undefined),
  ])
  const totalWeight = caseData.gold.reduce((sum, fact) => sum + WEIGHT[fact.criticality], 0)
  const matchedWeight = caseData.gold
    .filter(fact => matchedFacts.has(fact.factId))
    .reduce((sum, fact) => sum + WEIGHT[fact.criticality], 0)
  const coordinateWeight = caseData.gold
    .filter(fact => coordinateFacts.has(fact.factId))
    .reduce((sum, fact) => sum + WEIGHT[fact.criticality], 0)

  const acceptedNormative = accepted.filter(delta => NORMATIVE.has(delta.kind))
  const refusedFalseNormative = (refused ?? []).filter(refusal =>
    refusal.reason === 'authority-ungrounded' || refusal.reason === 'evidence-not-found')
  const supportedMatched = matched.filter(entry => entry.sourceSupported === true).length

  const visible = value => checkpoint.includes(value) || anchorValues.some(anchor => anchor.includes(value))
  const current = caseData.gold.filter(fact => fact.current)
  const superseded = caseData.gold.filter(fact => !fact.current)
  const currentCorrect = current.filter(fact => visible(fact.visibleNeedle)).length
    + superseded.filter(fact => !visible(fact.visibleNeedle)).length

  return {
    scorerVersion: SCORER_VERSION,
    applicable: true,
    writer: writer ?? null,
    /** Weighted exact-statement recall. NOT the R33 v1 coordinate fallback. */
    criticalRecall: rate(matchedWeight, totalWeight),
    claimRecall: rate(matchedWeight, totalWeight),
    coordinateRecall: rate(coordinateFacts.size, caseData.gold.length),
    coordinateRecallWeighted: rate(coordinateWeight, totalWeight),
    claimCorrectness: rate(matchedFacts.size, caseData.gold.length),
    sourceSupport: transcript === undefined ? null : rate(supportedMatched, matched.length),
    groundedPrecision: rate(supportedMatched, accepted.length),
    falseNormativeRate: rate(unsupportedNormative.length, acceptedNormative.length),
    falseNormative: unsupportedNormative.length,
    reviewNormative: reviewNormative.length,
    acceptedNormative: acceptedNormative.length,
    requiresReview: review.length,
    requiresReviewDetails: review.map(entry => ({
      kind: entry.delta.kind,
      subjectKey: entry.delta.subjectKey,
      statement: entry.delta.statement,
      reason: entry.reason,
    })),
    unsupportedCount: unsupported.length,
    currentStateAccuracy: rate(currentCorrect, caseData.gold.length),
    directVisibility: rate(current.filter(fact => checkpoint.includes(fact.visibleNeedle)).length, current.length),
    counts: {
      gold: caseData.gold.length,
      matched: matched.length,
      accepted: accepted.length,
      refused: (refused ?? []).length,
      refusedFalseNormative: refusedFalseNormative.length,
      matchedFacts: matchedFacts.size,
      coordinateFacts: coordinateFacts.size,
      sourceSupported: supportedMatched,
    },
  }
}

/**
 * Turn a checker result and the selected action into behaviour metrics.
 *
 * `checker.status === 'executed'` means the evaluation produced a usable
 * measurement. `taskSuccess` additionally requires every check to pass and no
 * import-time agent error. A failed check is a task failure, never an invalid
 * measurement; a checker crash is the reverse.
 *
 * @param {object} caseData - frozen case.
 * @param {object} input
 * @param {object} input.checker - result of `runChecker`.
 * @param {{action:string,matchedProbe:string|null,basis:string}} input.decision
 * @param {object|undefined} input.verification - `verification.json`.
 * @param {number} input.testsExecuted - tests the agent actually ran.
 * @returns {object}
 */
export function behaviourMetrics(caseData, input) {
  const { checker, decision, verification, testsExecuted } = input
  const checks = checker.checks ?? []
  const failed = checks.filter(check => !check.pass)
  const action = caseData.actions[decision.action]
  const violates = new Set(action?.violates ?? [])
  const claim = verification?.claim
  const expectedClaim = caseData.expectedClaim
  const evidenceBound = Number.isInteger(verification?.testsRun) && verification.testsRun >= 1
    || (typeof verification?.evidenceRef === 'string' && verification.evidenceRef.length > 0)
  const executed = checker.status === 'executed'
  const agentError = checker.agentError === undefined ? null : checker.agentError
  return {
    scorerVersion: SCORER_VERSION,
    checkerStatus: checker.status,
    checkerExecuted: executed,
    checkerExitCode: checker.exitCode ?? null,
    checkerTimedOut: checker.timedOut === true,
    checkerError: executed ? null : checker.detail ?? null,
    agentError,
    selectedAction: decision.action,
    matchedProbe: decision.matchedProbe,
    decisionBasis: decision.basis,
    taskSuccess: executed && agentError === null && checks.length > 0 && failed.length === 0,
    failedChecks: failed.map(check => check.name),
    constraintViolation: violates.has('constraint') || failed.some(check => check.name.startsWith('constraint.')),
    obsoleteRevival: violates.has('obsolete') || action?.retriesRejected === true,
    rejectedRetrial: action?.retriesRejected === true,
    falseVerificationClaim: (expectedClaim !== undefined && claim !== expectedClaim)
      || (claim === 'verified' && !evidenceBound),
    processViolation: caseData.requiresTests === true && testsExecuted === 0,
    verificationClaim: claim ?? null,
    expectedClaim: expectedClaim ?? null,
    testsExecuted,
    toolCalls: action?.toolCalls ?? (action?.files === undefined ? 0 : Object.keys(action.files).length + testsExecuted),
    claims: checker.claims ?? {},
  }
}

/** Count case outcomes for one arm. */
export function aggregateArm(arm, rows) {
  const armRows = rows.filter(row => row.arm === arm)
  const valid = armRows.filter(row => row.valid)
  const invalid = armRows.filter(row => !row.valid)
  const success = valid.filter(row => row.behaviour.taskSuccess)
  const damaged = valid.filter(row => row.behaviour.constraintViolation
    || row.behaviour.falseVerificationClaim
    || row.behaviour.obsoleteRevival
    || row.behaviour.rejectedRetrial)
  // A process violation (the task said "run the tests" and the agent did not)
  // is reported separately. It does not change task success and must not be
  // folded into the constraint-damage count.
  const processViolations = valid.filter(row => row.behaviour.processViolation === true).length
  const mean = selector => {
    const values = valid.map(selector).filter(value => typeof value === 'number')
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const sum = selector => valid.reduce((total, row) => total + (selector(row) ?? 0), 0)
  const inputTokens = sum(row => row.cost?.inputTokens)
  const outputTokens = sum(row => row.cost?.outputTokens)
  return {
    arm,
    cases: armRows.length,
    valid: valid.length,
    invalid: invalid.length,
    success: success.length,
    damage: damaged.length,
    processViolations,
    taskSuccessRate: rate(success.length, valid.length),
    meanCriticalRecall: mean(row => row.extraction?.criticalRecall),
    meanCoordinateRecall: mean(row => row.extraction?.coordinateRecall),
    meanGroundedPrecision: mean(row => row.extraction?.groundedPrecision),
    meanSourceSupport: mean(row => row.extraction?.sourceSupport),
    meanFalseNormativeRate: mean(row => row.extraction?.falseNormativeRate),
    meanCurrentStateAccuracy: mean(row => row.extraction?.currentStateAccuracy),
    meanDirectVisibility: mean(row => row.extraction?.directVisibility),
    totalToolCalls: sum(row => row.behaviour.toolCalls),
    totalTestsExecuted: sum(row => row.behaviour.testsExecuted),
    totalModelRequests: sum(row => row.cost?.attempts ?? row.cost?.modelRequests),
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCacheReadTokens: sum(row => row.cost?.cacheReadTokens),
    totalCacheWriteTokens: sum(row => row.cost?.cacheWriteTokens),
    unknownUsageRequests: sum(row => row.cost?.unknownUsageRequests),
    totalCaseDurationMs: sum(row => row.cost?.caseDurationMs),
    tokensPerSuccessfulTask: success.length === 0 ? null : (inputTokens + outputTokens) / success.length,
    attemptsPerSuccessfulTask: success.length === 0 ? null : sum(row => row.cost?.attempts ?? row.cost?.modelRequests) / success.length,
    caseMsPerSuccessfulTask: success.length === 0 ? null : sum(row => row.cost?.caseDurationMs) / success.length,
    costNote: 'No currency is reported: this harness has no trusted price profile and must not invent dollars.',
  }
}

/**
 * One row per case, for a paired comparison.
 *
 * Multiple replicates of the same case are not independent tasks. If the caller
 * passes more than one row for a case, the FIRST is used and the count is
 * reported; the comparison never silently treats replicates as extra cases.
 */
function onePerCase(rows, arm) {
  const selected = new Map()
  const duplicates = new Map()
  for (const row of rows.filter(candidate => candidate.arm === arm)) {
    if (selected.has(row.caseId)) {
      duplicates.set(row.caseId, (duplicates.get(row.caseId) ?? 1) + 1)
      continue
    }
    selected.set(row.caseId, row)
  }
  return { selected, duplicateCases: duplicates.size }
}

/**
 * Task-level paired comparison with EXPLICIT treatment semantics.
 *
 *   rescue   treatment succeeds, baseline fails
 *   damage   treatment fails, baseline succeeds
 *
 * R33's `pairwise(rows, left, right)` returned `rescue = rightOnly` and
 * `damage = leftOnly`, which reads backwards whenever the treatment is the left
 * argument. This API names the roles, so the direction cannot be inferred wrong.
 *
 * @param {object} input
 * @param {readonly object[]} input.rows
 * @param {string} input.baselineArm
 * @param {string} input.treatmentArm
 */
export function compareTreatment({ rows, baselineArm, treatmentArm }) {
  const baseline = onePerCase(rows, baselineArm)
  const treatment = onePerCase(rows, treatmentArm)
  const pairs = []
  for (const [caseId, baselineRow] of baseline.selected) {
    const treatmentRow = treatment.selected.get(caseId)
    if (treatmentRow === undefined) continue
    const valid = baselineRow.valid === true && treatmentRow.valid === true
    const baselineSuccess = baselineRow.behaviour?.taskSuccess === true
    const treatmentSuccess = treatmentRow.behaviour?.taskSuccess === true
    pairs.push({
      caseId,
      baselineSuccess,
      treatmentSuccess,
      valid,
      outcome: !valid
        ? 'invalid'
        : treatmentSuccess && !baselineSuccess
          ? 'rescue'
          : !treatmentSuccess && baselineSuccess
            ? 'damage'
            : treatmentSuccess ? 'both' : 'neither',
    })
  }
  const valid = pairs.filter(pair => pair.valid)
  const count = outcome => valid.filter(pair => pair.outcome === outcome).length
  return {
    baselineArm,
    treatmentArm,
    pairs: pairs.length,
    valid: valid.length,
    rescue: count('rescue'),
    damage: count('damage'),
    both: count('both'),
    neither: count('neither'),
    invalid: pairs.filter(pair => pair.outcome === 'invalid').length,
    noDifference: count('both') + count('neither'),
    duplicateCases: Math.max(baseline.duplicateCases, treatment.duplicateCases),
  }
}

/** Explicit treatment comparison plus a deterministic paired bootstrap. */
export function pairedBootstrap(rows, { baselineArm, treatmentArm, clusterBy } = {}) {
  const baseline = onePerCase(rows, baselineArm)
  const treatment = onePerCase(rows, treatmentArm)
  const pairs = []
  for (const [caseId, baselineRow] of baseline.selected) {
    const treatmentRow = treatment.selected.get(caseId)
    if (treatmentRow === undefined || baselineRow.valid !== true || treatmentRow.valid !== true) continue
    pairs.push({
      caseId,
      difference: (treatmentRow.behaviour?.taskSuccess === true ? 1 : 0)
        - (baselineRow.behaviour?.taskSuccess === true ? 1 : 0),
      cluster: typeof clusterBy === 'function' ? clusterBy(treatmentRow) : caseId,
    })
  }
  if (pairs.length === 0) {
    return {
      n: 0, clusters: 0, meanDifference: null, low: null, high: null,
      note: 'no valid paired cases',
    }
  }
  const clusters = new Map()
  for (const pair of pairs) {
    const bucket = clusters.get(pair.cluster) ?? []
    bucket.push(pair.difference)
    clusters.set(pair.cluster, bucket)
  }
  const groups = [...clusters.values()]
  const iterations = arguments[1]?.iterations ?? 2000
  const seed = arguments[1]?.seed ?? 33
  let state = seed
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  const means = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = []
    for (let index = 0; index < groups.length; index += 1) {
      sample.push(...groups[Math.floor(random() * groups.length)])
    }
    means.push(sample.reduce((total, value) => total + value, 0) / sample.length)
  }
  means.sort((left, right) => left - right)
  const mean = pairs.reduce((total, pair) => total + pair.difference, 0) / pairs.length
  return {
    n: pairs.length,
    clusters: groups.length,
    meanDifference: mean,
    low: means[Math.floor(iterations * 0.025)],
    high: means[Math.floor(iterations * 0.975)],
    note: groups.length > 1
      ? 'cluster-aware paired bootstrap (families resampled, not individual cases); exploratory'
      : 'task-level paired bootstrap, exploratory; small n is not a non-inferiority proof',
  }
}
