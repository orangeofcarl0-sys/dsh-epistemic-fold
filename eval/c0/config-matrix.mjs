#!/usr/bin/env node
/**
 * EF-C0 WP2 — configuration truth matrix.
 *
 * The matrix is DERIVED from the real resolver, not transcribed from a
 * document. `resolveEfConfig` and `describeEffectiveConfig` are imported
 * directly from `src/config/`, so a change to the preset or the resolver
 * changes this artifact the next time it is generated.
 *
 * What this script can prove: what a configuration RESOLVES to.
 * What it cannot prove: what the runtime DOES. The call-count claims below are
 * the declared path, and `tests/convergence-config.spec.ts` certifies them with
 * a scripted adapter.
 *
 * @module eval/c0/config-matrix
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEfConfig } from '../../src/config/policy.ts'
import { TIERS, isTierMode } from '../../src/config/preset.ts'
import { PRESET_OWNED_KEYS } from '../../src/config/ef-keys.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DATA = join(ROOT, 'docs', 'convergence', 'data')
const OUT = join(HERE, 'out')

/** One scenario: a mode plus the explicit keys a deployment might add. */
const SCENARIOS = [
  { id: 'legacy-default', mode: 'legacy' },
  { id: 'legacy-none', mode: 'legacy', semanticMode: 'none' },
  { id: 'legacy-shadow', mode: 'legacy', semanticContinuity: 'shadow' },
  { id: 'legacy-active', mode: 'legacy', semanticContinuity: 'active' },
  { id: 'legacy-none-active', mode: 'legacy', semanticMode: 'none', semanticContinuity: 'active' },

  { id: 'basic-default', mode: 'basic' },
  { id: 'basic-none', mode: 'basic', semanticMode: 'none' },
  { id: 'basic-shadow', mode: 'basic', semanticContinuity: 'shadow' },
  { id: 'basic-active', mode: 'basic', semanticContinuity: 'active' },

  { id: 'economy-default', mode: 'economy' },
  { id: 'economy-none', mode: 'economy', semanticMode: 'none' },
  { id: 'economy-shadow', mode: 'economy', semanticContinuity: 'shadow' },
  { id: 'economy-active', mode: 'economy', semanticContinuity: 'active' },
  { id: 'economy-none-shadow', mode: 'economy', semanticMode: 'none', semanticContinuity: 'shadow' },
  { id: 'economy-hint-override', mode: 'economy', rationaleHintTokens: 1200 },
  { id: 'economy-retain-override', mode: 'economy', retainRatio: 0.3 },

  { id: 'balanced-default', mode: 'balanced' },
  { id: 'balanced-none', mode: 'balanced', semanticMode: 'none' },
  { id: 'balanced-shadow', mode: 'balanced', semanticContinuity: 'shadow' },
  { id: 'balanced-active', mode: 'balanced', semanticContinuity: 'active' },

  { id: 'quality-default', mode: 'quality' },
  { id: 'quality-none', mode: 'quality', semanticMode: 'none' },
  { id: 'quality-shadow', mode: 'quality', semanticContinuity: 'shadow' },
  { id: 'quality-active', mode: 'quality', semanticContinuity: 'active' },
  { id: 'quality-zero-llm', mode: 'quality', semanticMode: 'none', semanticContinuity: 'off' },
]

/** The declared auxiliary-call path for a resolved configuration. */
function auxiliaryCalls(resolved) {
  if (resolved.semanticContinuity === 'active') return 'one-combined-writer-call'
  if (resolved.semanticContinuity === 'shadow') {
    return resolved.semanticMode === 'rationale'
      ? 'one-rationale-call-plus-one-diagnostic-writer'
      : 'no-auxiliary-call'
  }
  return resolved.semanticMode === 'rationale' ? 'one-rationale-call' : 'no-auxiliary-call'
}

/**
 * Engine defaults for the preset-owned keys. Duplicated here deliberately:
 * `describeEffectiveConfig` lives in a module that reaches `src/basic/config.ts`,
 * whose parameter properties Node's strip-only TypeScript loader rejects. The
 * TEST imports the real reporter; this artifact derives the same table from the
 * resolver, and `tests/convergence-config.spec.ts` asserts the two agree.
 */
const ENGINE_DEFAULTS = {
  leafAdmission: 'legacy',
  rootPolicy: 'legacy',
  semanticMode: 'rationale',
  rationaleHintTokens: 800,
  framingMode: 'legacy',
  retainRatio: 0.16,
}

function settingsFor(mode, explicit) {
  const tierValues = isTierMode(mode) ? TIERS[mode].values : {}
  const settings = {}
  for (const key of PRESET_OWNED_KEYS) {
    if (explicit[key] !== undefined) settings[key] = { value: explicit[key], origin: 'explicit' }
    else if (key in tierValues) settings[key] = { value: tierValues[key], origin: 'preset' }
    else settings[key] = { value: ENGINE_DEFAULTS[key], origin: 'engine-default' }
  }
  const overrides = Object.keys(tierValues)
    .filter(key => explicit[key] !== undefined && explicit[key] !== tierValues[key])
    .map(key => ({ key, preset: tierValues[key], explicit: explicit[key] }))
  return { settings, overrides }
}

const rows = SCENARIOS.map(scenario => {
  const { id, mode, ...explicit } = scenario
  const config = { mode, ...explicit }
  let resolved = null
  let error = null
  try {
    resolved = resolveEfConfig(config)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  if (error !== null) {
    return {
      id,
      requestedMode: mode,
      explicit: Object.keys(explicit).length === 0 ? null : explicit,
      valid: false,
      invalidReason: error,
    }
  }
  const { settings, overrides } = settingsFor(mode, explicit)
  return {
    id,
    requestedMode: mode,
    explicit: Object.keys(explicit).length === 0 ? null : explicit,
    valid: true,
    resolvedMode: mode,
    settings,
    overrides,
    effective: {
      semanticMode: resolved.semanticMode,
      semanticContinuity: resolved.semanticContinuity,
      semanticWriterEnabled: resolved.semanticContinuity !== 'off',
      journalEnabled: resolved.semanticContinuity !== 'off',
      rationaleEnabled: resolved.semanticMode === 'rationale',
      rationaleHintTokens: resolved.rationaleHintTokens,
      retainRatio: resolved.retainRatio,
      leafAdmission: resolved.leafAdmission,
      rootPolicy: resolved.rootPolicy.mode,
      framingMode: resolved.framingMode,
      workingSetTokens: resolved.semanticWorkingSetTokens,
      checkpointTokens: resolved.semanticCheckpointTokens,
    },
    declaredAuxiliaryCalls: auxiliaryCalls(resolved),
    // Host facts, not config facts. Recorded as such so the matrix does not
    // claim a projection is mounted merely because a mode was requested.
    hostDependent: {
      stateProjectionMounted: 'host-dependent',
      recallToolsMounted: mode === 'basic' ? false : 'host-dependent (requires ctx.tools)',
      efSurfaceMounted: mode !== 'basic',
    },
    runtimeSwitch: {
      modeSwitchAllowed: mode !== 'basic',
      continuitySwitchAllowed: false,
      framingSwitchAllowed: false,
    },
    tierEvidence: TIERS[mode]?.evidence ?? null,
  }
})

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP2',
  source: 'src/config/policy.ts#resolveEfConfig + src/config/effective-config.ts',
  tiers: Object.fromEntries(Object.entries(TIERS).map(([name, tier]) => [name, {
    values: tier.values,
    evidence: tier.evidence,
    steadinessMechanism: tier.steadinessMechanism,
  }])),
  defaults: {
    semanticMode: 'rationale',
    semanticContinuity: 'off',
    rationaleHintTokens: 800,
    retainRatio: 0.16,
    leafAdmission: 'legacy',
    rootPolicy: 'legacy',
    framingMode: 'legacy',
  },
  rows,
  summary: {
    scenarios: rows.length,
    valid: rows.filter(row => row.valid).length,
    invalid: rows.filter(row => !row.valid).length,
    // The historical documentation says economy/balanced are semantic none.
    // The resolver says otherwise. This is the fact the matrix exists to pin.
    tiersWithRationale: Object.entries(TIERS)
      .filter(([, tier]) => tier.values.semanticMode === 'rationale')
      .map(([name]) => name),
    tiersWithSemanticNone: Object.entries(TIERS)
      .filter(([, tier]) => tier.values.semanticMode === 'none')
      .map(([name]) => name),
  },
}

mkdirSync(DATA, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(DATA, 'effective-config-matrix.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(join(OUT, 'config-matrix.json'), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: report.generatedAt,
  scenarios: report.summary.scenarios,
  valid: report.summary.valid,
  invalid: report.summary.invalid,
  tiersWithRationale: report.summary.tiersWithRationale,
  tiersWithSemanticNone: report.summary.tiersWithSemanticNone,
}, null, 2)}\n`, 'utf8')

process.stdout.write(
  `scenarios ${report.summary.scenarios}; valid ${report.summary.valid}; `
  + `invalid ${report.summary.invalid}; rationale tiers ${report.summary.tiersWithRationale.join(',') || 'none'}\n`,
)
