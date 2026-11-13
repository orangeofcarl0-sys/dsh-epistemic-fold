#!/usr/bin/env node
/**
 * EF-R3 WP6 — bind each tier's evidence claim to the config it measured.
 *
 * RC1.3 measured the explicit zero-LLM economy profile. The shipped economy
 * tier is rationale-bearing. This artifact records the claim, the measured
 * profile, the current effective config, and whether the claim applies to the
 * current config. It does not change any tier value.
 *
 *   node eval/r3/preset-evidence.mjs
 *
 * @module eval/r3/preset-evidence
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIERS, TIER_MODE_NAMES } from '../../lib/config/preset.js'
import { resolveEfConfig } from '../../lib/config/policy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')

const tiers = TIER_MODE_NAMES.map(name => {
  const tier = TIERS[name]
  const effective = resolveEfConfig({ mode: name })
  const current = {
    semanticMode: effective.semanticMode,
    framingMode: effective.framingMode,
    rationaleHintTokens: effective.rationaleHintTokens,
    retainRatio: effective.retainRatio,
    leafAdmission: effective.leafAdmission,
    rootPolicy: effective.rootPolicy.mode,
  }
  const profile = tier.evidenceProfile ?? null
  const profileNamesZero = profile !== null && /semanticMode:\s*none/u.test(profile)
  const currentIsZero = current.semanticMode === 'none'
  const claimAppliesToCurrent = tier.evidence === 'measured'
    && (profile === null ? true : profileNamesZero === currentIsZero)
  return {
    name,
    values: tier.values,
    summary: tier.summary,
    evidence: tier.evidence,
    evidenceProfile: profile,
    evidenceDetail: tier.evidenceDetail,
    current,
    claimAppliesToCurrent,
    finding: tier.evidence === 'measured' && !claimAppliesToCurrent
      ? 'the measured profile differs from the current effective config'
      : tier.evidence === 'hypothesis' ? 'no measurement of the current effective config' : 'measured and applicable',
  }
})

const output = {
  schemaVersion: 1,
  work: 'EF-R3 WP6',
  generatedAt: new Date().toISOString(),
  tiers,
  counts: {
    measured: tiers.filter(tier => tier.evidence === 'measured').length,
    hypothesis: tiers.filter(tier => tier.evidence === 'hypothesis').length,
    measuredButNotApplicable: tiers.filter(tier => tier.evidence === 'measured' && !tier.claimAppliesToCurrent).length,
  },
  note: 'RC1.3 measured semanticMode: none. The current economy tier is rationale-bearing, so it is a hypothesis. No tier value changed.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'preset-evidence.json')
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`preset evidence: ${output.counts.measured} measured, ${output.counts.hypothesis} hypothesis, ${output.counts.measuredButNotApplicable} measured-but-not-applicable\n`)
for (const tier of tiers) {
  process.stdout.write(`  ${tier.name}: ${tier.evidence}; profile ${tier.evidenceProfile ?? '—'}; current semanticMode ${tier.current.semanticMode}; ${tier.finding}\n`)
}
process.stdout.write(`wrote ${path}\n`)
