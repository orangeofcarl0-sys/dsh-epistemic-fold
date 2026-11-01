/**
 * R33 scoring: extraction, current state, delivery, and behaviour.
 *
 * Every number carries its denominator. A rate over zero accepted proposals is
 * `null`, not `0`, because "the writer proposed nothing normative" and "the
 * writer proposed nothing false" are different observations.
 *
 * The extraction metrics are GOLD-RELATIVE on purpose. The dataset's gold is
 * the closed world for this instrument: an accepted normative claim that
 * matches no gold fact is counted as unsupported. That is a benchmark
 * definition, not a claim about the world, and it is reported as such.
 *
 * @module eval/r33/src/grade
 */

const NORMATIVE = new Set(['constraint', 'objective', 'obligation'])
const WEIGHT = { high: 3, medium: 2, low: 1 }

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
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
 * Compute extraction, state, and direct-visibility metrics for one fold.
 *
 * @param {object} caseData - frozen case.
 * @param {object} input
 * @param {readonly object[]|undefined} input.accepted - accepted deltas.
 * @param {readonly object[]|undefined} input.refused - refused proposals.
 * @param {object|undefined} input.writer - writer observation (or undefined for B0/B1).
 * @param {string} input.checkpoint - visible checkpoint body.
 * @param {readonly string[]} input.anchorValues - values of the replayed state.
 * @returns {object} metrics with denominators.
 */
export function extractionMetrics(caseData, input) {
  const { accepted, refused, writer, checkpoint, anchorValues } = input
  if (accepted === undefined || caseData.historyIndependent === true) {
    return {
      applicable: false,
      reason: accepted === undefined
        ? 'this arm commits no semantic deltas'
        : 'history-independent control: there is no memory extraction to score',
      writer: writer ?? null,
      criticalRecall: null,
      groundedPrecision: null,
      falseNormativeRate: null,
      currentStateAccuracy: null,
      directVisibility: null,
      counts: { gold: caseData.gold.length, matched: 0, accepted: 0, refused: 0 },
    }
  }
  const goldByStatement = new Map(caseData.gold.map(fact =>
    [`${factKey(fact.kind, fact.subjectKey, fact.scope)}#${fact.statement}`, fact]))
  const goldByCoordinate = new Map()
  for (const fact of caseData.gold) {
    const key = factKey(fact.kind, fact.subjectKey, fact.scope)
    const bucket = goldByCoordinate.get(key) ?? []
    bucket.push(fact)
    goldByCoordinate.set(key, bucket)
  }
  const used = new Set()
  const matched = []
  const unmatched = []
  for (const delta of accepted) {
    const coordinate = factKey(delta.kind, delta.subjectKey, delta.scope)
    const exact = goldByStatement.get(`${coordinate}#${delta.statement}`)
    const fact = exact !== undefined && !used.has(exact.factId)
      ? exact
      : (goldByCoordinate.get(coordinate) ?? []).find(candidate => !used.has(candidate.factId))
    if (fact === undefined) {
      unmatched.push(delta)
    } else {
      matched.push({ delta, fact })
      used.add(fact.factId)
    }
  }
  const matchedFacts = new Set(matched.map(entry => entry.fact.factId))
  const totalWeight = caseData.gold.reduce((sum, fact) => sum + WEIGHT[fact.criticality], 0)
  const matchedWeight = caseData.gold
    .filter(fact => matchedFacts.has(fact.factId))
    .reduce((sum, fact) => sum + WEIGHT[fact.criticality], 0)

  const acceptedNormative = accepted.filter(delta => NORMATIVE.has(delta.kind))
  const falseNormative = acceptedNormative.filter(delta => {
    const coordinate = factKey(delta.kind, delta.subjectKey, delta.scope)
    return !goldByCoordinate.has(coordinate)
  })
  const refusedFalseNormative = (refused ?? []).filter(refusal =>
    refusal.reason === 'authority-ungrounded' || refusal.reason === 'evidence-not-found')

  const visible = value => checkpoint.includes(value) || anchorValues.some(anchor => anchor.includes(value))
  const current = caseData.gold.filter(fact => fact.current)
  const superseded = caseData.gold.filter(fact => !fact.current)
  const currentCorrect = current.filter(fact => visible(fact.visibleNeedle)).length
    + superseded.filter(fact => !visible(fact.visibleNeedle)).length

  return {
    applicable: true,
    writer: writer ?? null,
    criticalRecall: rate(matchedWeight, totalWeight),
    groundedPrecision: rate(matched.length, accepted.length),
    falseNormativeRate: rate(falseNormative.length, acceptedNormative.length),
    falseNormative: falseNormative.length,
    acceptedNormative: acceptedNormative.length,
    currentStateAccuracy: rate(currentCorrect, caseData.gold.length),
    directVisibility: rate(current.filter(fact => checkpoint.includes(fact.visibleNeedle)).length, current.length),
    counts: {
      gold: caseData.gold.length,
      matched: matched.length,
      accepted: accepted.length,
      refused: (refused ?? []).length,
      refusedFalseNormative: refusedFalseNormative.length,
      matchedFacts: matchedFacts.size,
    },
  }
}

/**
 * Turn a checker result and the selected action into behaviour metrics.
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
  return {
    checkerStatus: checker.status,
    selectedAction: decision.action,
    matchedProbe: decision.matchedProbe,
    decisionBasis: decision.basis,
    taskSuccess: checker.status === 'executed' && checks.length > 0 && failed.length === 0,
    failedChecks: failed.map(check => check.name),
    constraintViolation: violates.has('constraint') || failed.some(check => check.name.startsWith('constraint.')),
    obsoleteRevival: violates.has('obsolete') || action?.retriesRejected === true,
    rejectedRetrial: action?.retriesRejected === true,
    falseVerificationClaim: (expectedClaim !== undefined && claim !== expectedClaim)
      || (claim === 'verified' && !evidenceBound),
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
  const mean = selector => {
    const values = valid.map(selector).filter(value => typeof value === 'number')
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  return {
    arm,
    cases: armRows.length,
    valid: valid.length,
    invalid: invalid.length,
    success: success.length,
    damage: damaged.length,
    taskSuccessRate: rate(success.length, valid.length),
    meanCriticalRecall: mean(row => row.extraction?.criticalRecall),
    meanGroundedPrecision: mean(row => row.extraction?.groundedPrecision),
    meanFalseNormativeRate: mean(row => row.extraction?.falseNormativeRate),
    meanCurrentStateAccuracy: mean(row => row.extraction?.currentStateAccuracy),
    meanDirectVisibility: mean(row => row.extraction?.directVisibility),
    totalToolCalls: valid.reduce((sum, row) => sum + (row.behaviour.toolCalls ?? 0), 0),
    totalTestsExecuted: valid.reduce((sum, row) => sum + (row.behaviour.testsExecuted ?? 0), 0),
    totalModelRequests: valid.reduce((sum, row) => sum + (row.cost?.modelRequests ?? 0), 0),
    totalInputTokens: valid.reduce((sum, row) => sum + (row.cost?.inputTokens ?? 0), 0),
    totalOutputTokens: valid.reduce((sum, row) => sum + (row.cost?.outputTokens ?? 0), 0),
    totalWallClockMs: valid.reduce((sum, row) => sum + (row.cost?.wallClockMs ?? 0), 0),
    costPerSuccessfulTask: success.length === 0
      ? null
      : valid.reduce((sum, row) => sum + (row.cost?.wallClockMs ?? 0), 0) / success.length,
  }
}

/**
 * Task-level paired comparison of two arms.
 *
 * Multiple observations of the same case (for example, retries) must be folded
 * into one row per case before this is called; the caller is responsible for
 * not treating repeated runs as independent tasks.
 */
export function pairwise(rows, leftArm, rightArm) {
  const left = new Map(rows.filter(row => row.arm === leftArm).map(row => [row.caseId, row]))
  const right = new Map(rows.filter(row => row.arm === rightArm).map(row => [row.caseId, row]))
  const pairs = []
  for (const [caseId, leftRow] of left) {
    const rightRow = right.get(caseId)
    if (rightRow === undefined) continue
    const bothValid = leftRow.valid && rightRow.valid
    const leftSuccess = leftRow.behaviour.taskSuccess
    const rightSuccess = rightRow.behaviour.taskSuccess
    pairs.push({
      caseId,
      leftSuccess,
      rightSuccess,
      valid: bothValid,
      outcome: !bothValid
        ? 'invalid'
        : leftSuccess && !rightSuccess
          ? 'left-only'
          : !leftSuccess && rightSuccess
            ? 'right-only'
            : leftSuccess ? 'both' : 'neither',
    })
  }
  const valid = pairs.filter(pair => pair.valid)
  const leftOnly = valid.filter(pair => pair.outcome === 'left-only').length
  const rightOnly = valid.filter(pair => pair.outcome === 'right-only').length
  return {
    left: leftArm,
    right: rightArm,
    pairs: pairs.length,
    valid: valid.length,
    leftOnly,
    rightOnly,
    both: valid.filter(pair => pair.outcome === 'both').length,
    neither: valid.filter(pair => pair.outcome === 'neither').length,
    invalid: pairs.filter(pair => pair.outcome === 'invalid').length,
    // The explicit names the brief asks for, from the LEFT arm's perspective.
    rescue: rightOnly,
    damage: leftOnly,
    noDifference: valid.filter(pair => pair.outcome === 'both' || pair.outcome === 'neither').length,
  }
}

/** Task-level bootstrap interval for a paired proportion; exploratory only. */
export function pairedBootstrap(rows, leftArm, rightArm, options = {}) {
  const pairs = []
  const left = new Map(rows.filter(row => row.arm === leftArm).map(row => [row.caseId, row]))
  const right = new Map(rows.filter(row => row.arm === rightArm).map(row => [row.caseId, row]))
  for (const [caseId, leftRow] of left) {
    const rightRow = right.get(caseId)
    if (rightRow === undefined || !leftRow.valid || !rightRow.valid) continue
    pairs.push((leftRow.behaviour.taskSuccess ? 1 : 0) - (rightRow.behaviour.taskSuccess ? 1 : 0))
  }
  if (pairs.length === 0) return { n: 0, meanDifference: null, low: null, high: null }
  const iterations = options.iterations ?? 2000
  const seed = options.seed ?? 33
  let state = seed
  const random = () => {
    // Deterministic LCG so the report is reproducible.
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  const means = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0
    for (let index = 0; index < pairs.length; index += 1) {
      sum += pairs[Math.floor(random() * pairs.length)]
    }
    means.push(sum / pairs.length)
  }
  means.sort((a, b) => a - b)
  const mean = pairs.reduce((sum, value) => sum + value, 0) / pairs.length
  return {
    n: pairs.length,
    meanDifference: mean,
    low: means[Math.floor(iterations * 0.025)],
    high: means[Math.floor(iterations * 0.975)],
    note: 'task-level bootstrap, exploratory; small n is not a non-inferiority proof',
  }
}
