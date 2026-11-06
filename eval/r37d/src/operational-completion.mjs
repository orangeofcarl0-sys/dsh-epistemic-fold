/**
 * R37-D: layered operational completion.
 *
 * The legacy scorer answers one question: did the artifact pass the checks and
 * did the agent avoid a historical violation? It does not require the final
 * test to pass, the verification to be fresh, or the run to terminate through
 * `finish`. Those are different properties and they are measured separately
 * here.
 *
 * Nothing in this module rewrites `contractSuccess`. It reads the same report
 * row and returns a new object with an explicit `schemaVersion` and
 * `scorerVersion`.
 *
 *   artifactCorrectness      functional + historical checks + required files
 *   verificationCompleteness the tests ran, the last result is known and
 *                            belongs to the current source, and the
 *                            verification artifact is honest
 *   termination              how the run ended
 *   operationalCompletion    all three, with the termination contract applied
 *
 * Verification completeness is not "the tests passed". A diagnostic task can
 * correctly conclude that the tests fail and report `not-verified`; that is a
 * complete verification of the current state. `freshPassingVerification` is
 * reported separately because it is the finish guard's criterion, not the
 * task's verification criterion.
 *
 * A case's termination contract is explicit. `finish-required` is only used
 * when the benchmark or runtime actually requires the finish tool. The legacy
 * cases do not: their task text requires tests and, for D1/D2, a verification
 * artifact, but not a specific finish call. They use `finish-optional`, where
 * a step-limit after complete work is an inefficient termination, not an
 * incomplete one. `efficientTermination` reports that difference separately.
 *
 * @module eval/r37d/src/operational-completion
 */

export const OPERATIONAL_SCHEMA_VERSION = 1
export const OPERATIONAL_SCORER_VERSION = 'r37d-operational-1'

/** Cases whose task text requires `verification.json`. */
const VERIFICATION_ARTIFACT_CASES = new Set(['D1', 'D1-v2', 'D2'])

/**
 * The operational contract for a case.
 *
 * The case JSON has `requiresTests`, but no artifact or termination field. The
 * contract is therefore declared here, next to the task text it encodes, so a
 * new case cannot silently inherit the wrong completion rule.
 *
 * @param {object} caseData
 * @returns {object}
 */
export function operationalContract(caseData) {
  const id = String(caseData?.id ?? '')
  const requiresArtifact = VERIFICATION_ARTIFACT_CASES.has(id)
  return {
    caseId: id,
    requiresTests: caseData?.requiresTests === true,
    requiredArtifacts: requiresArtifact ? ['verification.json'] : [],
    verificationArtifact: requiresArtifact
      ? {
          path: 'verification.json',
          claimField: 'claim',
          testsRunField: 'testsRun',
          testsPassedField: 'testsPassed',
          claims: ['verified', 'not-verified'],
        }
      : null,
    terminationContract: 'finish-optional',
    note: requiresArtifact
      ? 'the task text requires a verification artifact and the visible tests'
      : 'the task text requires the visible tests; it does not require the finish tool',
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failedCheckNames(checker, behaviour) {
  if (Array.isArray(checker?.checks)) {
    return checker.checks.filter(check => check?.pass !== true).map(check => String(check.name ?? 'unknown'))
  }
  return Array.isArray(behaviour?.failedChecks) ? behaviour.failedChecks.map(String) : []
}

function partitionChecks(names) {
  const historical = []
  const functional = []
  for (const name of names) {
    if (name.startsWith('constraint.') || name.startsWith('state.')) historical.push(name)
    else functional.push(name)
  }
  return { historical, functional }
}

/**
 * Validate the declared verification artifact.
 *
 * This checks shape and self-consistency, not truth. Truth comes from the
 * harness's `run_tests` records, never from the agent's file.
 *
 * @param {object|undefined} artifact
 * @param {object|null} contract
 * @param {number} testsExecuted
 * @returns {{present:boolean, schemaValid:boolean|null, claim:string|null,
 *   claimSupported:boolean|null, selfReportConsistent:boolean|null, problems:string[]}}
 */
export function assessVerificationArtifact(artifact, contract, testsExecuted) {
  if (contract?.verificationArtifact === null || contract?.verificationArtifact === undefined) {
    return {
      present: null,
      schemaValid: null,
      claim: null,
      claimSupported: null,
      selfReportConsistent: null,
      problems: [],
    }
  }
  const problems = []
  if (!isObject(artifact)) {
    return {
      present: false,
      schemaValid: false,
      claim: null,
      claimSupported: false,
      selfReportConsistent: null,
      problems: ['verification.json is missing or not an object'],
    }
  }
  const spec = contract.verificationArtifact
  const claim = typeof artifact[spec.claimField] === 'string' ? artifact[spec.claimField] : null
  const testsRun = Number.isInteger(artifact[spec.testsRunField]) ? artifact[spec.testsRunField] : null
  const testsPassed = Number.isInteger(artifact[spec.testsPassedField]) ? artifact[spec.testsPassedField] : null
  if (claim === null || !spec.claims.includes(claim)) {
    problems.push(`claim must be one of ${spec.claims.join(', ')}`)
  }
  if (testsRun === null || testsRun < 0) problems.push('testsRun must be a non-negative integer')
  if (testsPassed === null || testsPassed < 0) problems.push('testsPassed must be a non-negative integer')
  if (testsRun !== null && testsPassed !== null && testsPassed > testsRun) {
    problems.push('testsPassed cannot exceed testsRun')
  }
  const selfReportConsistent = testsRun === null || testsPassed === null
    ? null
    : testsRun >= 1 && testsRun <= Math.max(testsExecuted, 0) && testsPassed <= testsRun
  return {
    present: true,
    schemaValid: problems.length === 0,
    claim,
    // A conservative `not-verified` claim is never an overclaim. A `verified`
    // claim is supported only by a fresh passing test; that is checked by the
    // caller, which has the freshness evidence.
    claimSupported: claim === null ? false : claim === 'not-verified' ? true : null,
    selfReportConsistent,
    problems,
  }
}

/**
 * Classify one report row.
 *
 * @param {object} input
 * @param {object} input.caseData - frozen case, for `requiresTests` and `id`.
 * @param {object} input.behaviour - `row.behaviour`.
 * @param {object} [input.detail] - `row.behaviourDetail`.
 * @param {object} [input.checker] - `row.checker`.
 * @param {object} [input.run] - the runner result (exitCode/signal/timedOut).
 * @param {object} [input.verification] - parsed `verification.json`.
 * @param {object} [input.contract] - override for tests that need one.
 * @returns {object}
 */
export function classifyOperationalCompletion(input) {
  const { caseData, behaviour = {}, detail = {}, checker = {}, run = null, verification } = input
  const contract = input.contract ?? operationalContract(caseData)
  const names = failedCheckNames(checker, behaviour)
  const partition = partitionChecks(names)
  const executed = checker?.status === 'executed'
  const agentError = checker?.agentError ?? behaviour.agentError ?? null

  const functionalChecksPassed = executed
    && agentError === null
    && Array.isArray(checker?.checks)
    && checker.checks.length > 0
    && partition.functional.length === 0
  const historicalChecksPassed = partition.historical.length === 0
    && behaviour.constraintViolation !== true
    && behaviour.obsoleteRevival !== true
    && behaviour.rejectedRetrial !== true

  const artifact = assessVerificationArtifact(verification, contract, detail.testsExecuted ?? 0)
  const requiredArtifactsPresent = contract.requiredArtifacts.length === 0
    ? null
    : artifact.present === true
  const artifactSchemaValid = contract.requiredArtifacts.length === 0 ? null : artifact.schemaValid
  const artifactCorrectness = functionalChecksPassed
    && historicalChecksPassed
    && (requiredArtifactsPresent === null || requiredArtifactsPresent === true)
    && (artifactSchemaValid === null || artifactSchemaValid === true)

  const testsRequired = contract.requiresTests
  const testsExecuted = Number.isInteger(detail.testsExecuted) ? detail.testsExecuted : 0
  const testRuns = Array.isArray(detail.testRuns)
    ? detail.testRuns
    : Array.isArray(detail.verificationFreshness?.testRuns)
      ? detail.verificationFreshness.testRuns
      : []
  const lastTest = testRuns.length === 0 ? null : testRuns[testRuns.length - 1]
  const lastTestPassed = lastTest === null ? null : lastTest.passed === true
  const currentDigest = detail.verificationFreshness?.currentDigest ?? null
  // Freshness is a property of the LAST test run, not of the last passing run.
  // A failed test on unchanged source is a fresh observation of the failure.
  const lastTestFresh = lastTest === null
    ? false
    : lastTest.digest !== undefined && currentDigest !== null
      ? lastTest.digest === currentDigest
      : detail.verificationFreshness?.verifiedCurrentCode === true
  const freshPassingVerification = lastTestPassed === true && lastTestFresh === true
  const verificationEvidencePresent = contract.verificationArtifact === null
    ? null
    : artifact.present === true
  const verificationClaimSupported = contract.verificationArtifact === null
    ? null
    : artifact.claim === 'verified'
      ? freshPassingVerification
      : artifact.claimSupported
  const verificationCompleteness = !testsRequired
    ? true
    : testsExecuted > 0
      && lastTest !== null
      && lastTestFresh === true
      && (verificationEvidencePresent === null || verificationEvidencePresent === true)
      && (verificationClaimSupported === null || verificationClaimSupported === true)

  const finishRequested = (detail.finishGuard?.finishRequests ?? behaviour.finishGuard?.finishRequests ?? 0) > 0
  const finishAccepted = detail.finished === true
  const stepLimitTermination = detail.harness?.stepLimitTermination === true
  const providerFailure = detail.harness?.providerFailure ?? null
  const aborted = run?.timedOut === true || (run?.signal !== null && run?.signal !== undefined)
  const terminationReason = finishAccepted
    ? 'finish'
    : providerFailure !== null
      ? 'provider-failure'
      : aborted
        ? 'aborted'
        : stepLimitTermination
          ? 'step-limit'
          : 'unknown'
  const acceptableTermination = contract.terminationContract === 'finish-required'
    ? finishAccepted
    : finishAccepted || (stepLimitTermination && providerFailure === null && !aborted)
  const efficientTermination = finishAccepted

  const operationalCompletion = artifactCorrectness && verificationCompleteness && acceptableTermination
  const firstFailingLayer = !artifactCorrectness
    ? 'artifact'
    : !verificationCompleteness
      ? 'verification'
      : !acceptableTermination
        ? 'termination'
        : null

  return {
    schemaVersion: OPERATIONAL_SCHEMA_VERSION,
    scorerVersion: OPERATIONAL_SCORER_VERSION,
    caseId: contract.caseId,
    contract,
    artifact: {
      functionalChecksPassed,
      historicalChecksPassed,
      requiredArtifactsPresent,
      artifactSchemaValid,
      failedFunctionalChecks: partition.functional,
      failedHistoricalChecks: partition.historical,
      artifactCorrectness,
    },
    verification: {
      testsRequired,
      testsExecuted,
      lastTestPassed,
      lastTestFresh,
      freshPassingVerification,
      verificationEvidencePresent,
      verificationClaimSupported,
      selfReportConsistent: artifact.selfReportConsistent,
      claim: artifact.claim,
      problems: artifact.problems,
      verificationCompleteness,
    },
    termination: {
      finishRequested,
      finishAccepted,
      stepLimitTermination,
      providerFailure,
      aborted,
      terminationReason,
      contract: contract.terminationContract,
      acceptableTermination,
      efficientTermination,
    },
    operationalCompletion,
    operationalCompletionStrictFinish: operationalCompletion && finishAccepted,
    firstFailingLayer,
    legacy: {
      taskSuccess: behaviour.taskSuccess === true,
      contractSuccess: behaviour.contractSuccess === true,
      processCompliance: behaviour.processCompliance === true,
      finalVerificationStatus: behaviour.finalVerificationStatus ?? null,
    },
  }
}
