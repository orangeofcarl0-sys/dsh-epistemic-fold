/**
 * EF-R3 — effective-config identity for a live cell.
 *
 * An arm name is not a treatment. The R2 E1 label said `rationaleHintTokens: 800`
 * in the manifest, but the host never forwarded that key, so every E1 cell ran
 * the economy preset's 400. This module resolves BOTH the configuration the host
 * actually passed and the configuration the manifest declared, hashes each one,
 * and records the difference. Nothing here changes a configuration.
 *
 * @module eval/r3/config-resolve
 */

import { createHash } from 'node:crypto'
import { resolveEfConfig } from '../../lib/config/policy.js'

/** The keys a campaign manifest may declare and the host is expected to honour. */
export const DECLARED_KEYS = [
  'leafAdmission',
  'rootPolicy',
  'framingMode',
  'semanticContinuity',
  'rationaleHintTokens',
  'thresholdRatio',
  'retainRatio',
  'headroomTokens',
]

/** The R2 host values that were hard-coded rather than read from the manifest. */
const R2_HOST_DEFAULTS = {
  thresholdRatio: 0.5,
  retainRatio: 0.04,
  headroomTokens: 512,
  maxTokens: 1024,
}

/**
 * The configuration the R2 host ACTUALLY passed to the plugin.
 *
 * `eval/e2e/src/host.mjs` forwarded only leafAdmission/rootPolicy/framingMode.
 * `rationaleHintTokens` was absent, so resolveEfConfig filled it from the
 * economy preset (400). This is the treatment the archived cells ran.
 */
export function r2EffectiveOptions({ arm, semanticMode, manifestConfig }) {
  const base = {
    thresholdRatio: R2_HOST_DEFAULTS.thresholdRatio,
    retainRatio: R2_HOST_DEFAULTS.retainRatio,
    headroomTokens: R2_HOST_DEFAULTS.headroomTokens,
    maxTokens: R2_HOST_DEFAULTS.maxTokens,
  }
  if (arm === 'B0') {
    return { backend: 'dsh-basic', ...base }
  }
  return {
    backend: 'ef',
    mode: 'economy',
    semanticMode,
    leafAdmission: manifestConfig.leafAdmission,
    rootPolicy: manifestConfig.rootPolicy,
    framingMode: manifestConfig.framingMode,
    semanticContinuity: manifestConfig.semanticContinuity,
    ...base,
  }
}

/**
 * The configuration a FIXED host forwards from the manifest.
 *
 * This is the contract the R3 config preflight enforces for future campaigns:
 * every key the manifest declares reaches `resolveEfConfig`. It is deliberately
 * distinct from {@link r2EffectiveOptions}, which reproduces the historical
 * host that ignored `rationaleHintTokens`.
 */
export function forwardedOptions({ arm, semanticMode, manifestConfig }) {
  if (arm === 'B0') {
    return {
      backend: 'dsh-basic',
      thresholdRatio: manifestConfig.thresholdRatio,
      retainRatio: manifestConfig.retainRatio,
      headroomTokens: manifestConfig.headroomTokens,
      maxTokens: R2_HOST_DEFAULTS.maxTokens,
    }
  }
  const options = {
    backend: 'ef',
    mode: 'economy',
    semanticMode,
    leafAdmission: manifestConfig.leafAdmission,
    rootPolicy: manifestConfig.rootPolicy,
    framingMode: manifestConfig.framingMode,
    semanticContinuity: manifestConfig.semanticContinuity,
    thresholdRatio: manifestConfig.thresholdRatio,
    retainRatio: manifestConfig.retainRatio,
    headroomTokens: manifestConfig.headroomTokens,
    maxTokens: R2_HOST_DEFAULTS.maxTokens,
  }
  if (manifestConfig.rationaleHintTokens !== undefined) {
    options.rationaleHintTokens = manifestConfig.rationaleHintTokens
  }
  if (manifestConfig.minReclaimTokens !== undefined) {
    options.minReclaimTokens = manifestConfig.minReclaimTokens
  }
  if (manifestConfig.minReclaimRatio !== undefined) {
    options.minReclaimRatio = manifestConfig.minReclaimRatio
  }
  return options
}

/**
 * The configuration the manifest DECLARED.
 *
 * Only keys the manifest actually carries are added. For R2 this adds
 * `rationaleHintTokens: 800`, which the host ignored.
 */
export function declaredOptions({ arm, semanticMode, manifestConfig }) {
  const base = {
    thresholdRatio: manifestConfig.thresholdRatio,
    retainRatio: manifestConfig.retainRatio,
    headroomTokens: manifestConfig.headroomTokens,
    maxTokens: R2_HOST_DEFAULTS.maxTokens,
  }
  if (arm === 'B0') {
    return { backend: 'dsh-basic', ...base }
  }
  const options = {
    backend: 'ef',
    mode: 'economy',
    semanticMode,
    leafAdmission: manifestConfig.leafAdmission,
    rootPolicy: manifestConfig.rootPolicy,
    framingMode: manifestConfig.framingMode,
    semanticContinuity: manifestConfig.semanticContinuity,
    ...base,
  }
  if (manifestConfig.rationaleHintTokens !== undefined) {
    options.rationaleHintTokens = manifestConfig.rationaleHintTokens
  }
  return options
}

/** Stable JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** A compact, reader-facing view of the resolved configuration. */
function summaryOf(config) {
  return {
    backend: config.backend,
    mode: config.mode ?? null,
    semanticMode: config.semanticMode ?? null,
    semanticContinuity: config.semanticContinuity ?? null,
    leafAdmission: config.leafAdmission ?? null,
    rootPolicy: typeof config.rootPolicy === 'object' && config.rootPolicy !== null
      ? config.rootPolicy.mode
      : config.rootPolicy ?? null,
    framingMode: config.framingMode ?? null,
    rationaleHintTokens: config.rationaleHintTokens ?? null,
    thresholdRatio: config.thresholdRatio ?? null,
    retainRatio: config.retainRatio ?? null,
    headroomTokens: config.headroomTokens ?? null,
    maxTokens: config.maxTokens ?? null,
    minReclaimTokens: config.minReclaimTokens ?? null,
    minReclaimRatio: config.minReclaimRatio ?? null,
  }
}

/**
 * Resolve a cell's effective and declared treatment.
 *
 * The returned `configMismatch` is the measurement-validity finding: a declared
 * key that the host did not honour. It does not change what ran.
 */
export function resolveTreatment({ arm, manifestConfig }) {
  const semanticMode = arm === 'E1' ? 'rationale' : arm === 'E0' ? 'none' : 'n/a'
  const effectiveOptions = r2EffectiveOptions({ arm, semanticMode, manifestConfig })
  const declared = declaredOptions({ arm, semanticMode, manifestConfig })
  const effective = arm === 'B0'
    ? { ...effectiveOptions }
    : resolveEfConfig(effectiveOptions)
  const intended = arm === 'B0'
    ? { ...declared }
    : resolveEfConfig(declared)

  const configMismatch = []
  const inertKeys = []
  if (arm !== 'B0') {
    for (const key of DECLARED_KEYS) {
      if (manifestConfig[key] === undefined) continue
      // E0 has no rationale call, so its hint budget cannot affect a request.
      // Recording a mismatch there would inflate the finding without changing
      // the treatment; record the key as inert instead.
      if (key === 'rationaleHintTokens' && semanticMode !== 'rationale') {
        inertKeys.push(key)
        continue
      }
      const actual = key === 'rootPolicy'
        ? (typeof effective.rootPolicy === 'object' && effective.rootPolicy !== null
          ? effective.rootPolicy.mode
          : effective.rootPolicy)
        : effective[key]
      const declaredValue = key === 'rootPolicy'
        ? (typeof intended.rootPolicy === 'object' && intended.rootPolicy !== null
          ? intended.rootPolicy.mode
          : intended.rootPolicy)
        : intended[key]
      if (actual !== declaredValue) {
        configMismatch.push({ key, declared: declaredValue, effective: actual })
      }
    }
  }

  const effectiveDigest = digestOf(effective)
  return {
    arm,
    declaredConfig: manifestConfig,
    effectiveConfig: effective,
    intendedConfig: intended,
    effectiveConfigSummary: summaryOf(effective),
    declaredConfigSummary: summaryOf(intended),
    configDigest: effectiveDigest,
    intendedConfigDigest: digestOf(intended),
    treatmentId: `${arm}:${effectiveDigest.slice(0, 12)}`,
    configMismatch,
    inertKeys,
  }
}
