#!/usr/bin/env node
/**
 * EF-R3 WP7 — freeze the product-representative lane DESIGN, not a run.
 *
 * The R2 live lane is a 16k stress lane: retain 0.04, legacy framing, hint 400
 * effective. It is not the shipped economy/balanced/quality preset. A product
 * decision needs a lane that runs the effective preset, at a product-sized
 * window, with new or audited task instances.
 *
 * This script records that design and the exact config diff. It creates no
 * runnable task set, makes no live call, and leaves executionAuthorized false.
 *
 *   node eval/r3/freeze-product-lane.mjs
 *
 * @module eval/r3/freeze-product-lane
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEfConfig } from '../../lib/config/policy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const E2E_OUT = join(ROOT, 'eval', 'e2e', 'out')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function summary(config) {
  return {
    mode: config.mode ?? null,
    semanticMode: config.semanticMode ?? null,
    leafAdmission: config.leafAdmission ?? null,
    rootPolicy: typeof config.rootPolicy === 'object' && config.rootPolicy !== null
      ? config.rootPolicy.mode
      : config.rootPolicy ?? null,
    framingMode: config.framingMode ?? null,
    rationaleHintTokens: config.rationaleHintTokens ?? null,
    thresholdRatio: config.thresholdRatio ?? null,
    retainRatio: config.retainRatio ?? null,
    headroomTokens: config.headroomTokens ?? null,
    minReclaimTokens: config.minReclaimTokens ?? null,
    minReclaimRatio: config.minReclaimRatio ?? null,
  }
}

const stressManifestPath = join(E2E_OUT, 'manifest-e2e-r2-confirm-1.json')
const stressManifest = existsSync(stressManifestPath) ? readJson(stressManifestPath) : null
const preflightPath = join(OUT, 'config-preflight.json')
const preflight = existsSync(preflightPath) ? readJson(preflightPath) : null

const productTiers = {
  economy: summary(resolveEfConfig({ mode: 'economy' })),
  balanced: summary(resolveEfConfig({ mode: 'balanced' })),
  quality: summary(resolveEfConfig({ mode: 'quality' })),
}
const minimal = summary(resolveEfConfig({ mode: 'economy', semanticMode: 'none' }))

const design = {
  schemaVersion: 1,
  work: 'EF-R3 WP7',
  generatedAt: new Date().toISOString(),
  lane: 'product-representative',
  status: 'design-only',
  executionAuthorized: false,
  authorizationState: 'not-requested',
  question: 'Under the shipped preset and a product-sized context window, does E1 beat native Basic on quality, cost and reliability?',
  arms: {
    B0: {
      backend: 'dsh-basic',
      treatment: 'native DSH Basic',
      config: {
        source: 'native Basic defaults',
        overrides: { thresholdRatio: 0.5, maxTokens: 1_024 },
      },
      note: 'No EF config. Do not apply the EF stress retainRatio to the product Basic arm without declaring it.',
    },
    E0: {
      backend: 'ef',
      treatment: 'EF minimal, no rationale',
      config: minimal,
      note: 'Not a shipped tier. It isolates the EF transaction/framing from the rationale face.',
    },
    E1: {
      backend: 'ef',
      treatment: 'shipped economy preset',
      config: productTiers.economy,
      note: 'This is the product-relevant rung. It is NOT the R2 E1 stress treatment.',
    },
  },
  availableTiers: productTiers,
  proposedContextWindow: 32_768,
  targetContextWindow: 131_072,
  windowNote: 'The adapter default is 131,072. A 32k first product pilot is proposed so the existing long-log tasks can still trigger folds; 128k is the eventual target and needs longer task instances. Neither is authorized.',
  taskSet: {
    reuseR2Templates: true,
    newInstances: false,
    status: 'requires-offline-exposure-audit',
    note: 'The R2 tasks were designed for a 16k stress window. Before a product-lane run, measure their seed tokens against the proposed window and either audit them in or generate new instances. This round does not generate tasks.',
  },
  designShape: {
    templates: 6,
    instancesPerTemplate: 2,
    arms: 3,
    replicates: 2,
    cells: 72,
    note: 'A design count only. No task instance is frozen and no cell is runnable.',
  },
  configDiff: {
    stress: {
      contextWindow: stressManifest?.config?.operationalBudgetTokens ?? null,
      retainRatio: stressManifest?.config?.retainRatio ?? null,
      framingMode: stressManifest?.config?.framingMode ?? null,
      rationaleHintTokensDeclared: stressManifest?.config?.rationaleHintTokens ?? null,
      rationaleHintTokensEffective: preflight?.arms?.find(entry => entry.arm === 'E1')?.effective?.rationaleHintTokens ?? null,
      semanticContinuity: stressManifest?.config?.semanticContinuity ?? null,
    },
    economy: productTiers.economy,
    balanced: productTiers.balanced,
    quality: productTiers.quality,
    note: 'The stress lane is not a product preset. The economy rung differs in framing, retention and the effective hint budget.',
  },
  envelope: {
    cells: 72,
    httpAttempts: 2_000,
    inputTokens: 20_000_000,
    outputTokens: 1_500_000,
    wallClockMs: 6 * 60 * 60 * 1000,
    paidConcurrency: 2,
    monetaryUsd: null,
    monetaryNote: 'No verifiable per-token price is recorded.',
  },
  prerequisites: [
    'A new explicit authorization bound to a frozen product-lane manifest.',
    'A representative transport health probe pass.',
    'A config preflight that compares every declared key with the effective config.',
    'An offline task-exposure audit at the proposed window, or new task instances.',
    'A route/model freeze; a different provider or model is a new campaign.',
  ],
  derivedFrom: {
    stressManifest: stressManifestPath === null || !existsSync(stressManifestPath)
      ? null
      : { path: 'eval/e2e/out/manifest-e2e-r2-confirm-1.json', sha256: sha256(stressManifestPath) },
    configPreflight: existsSync(preflightPath)
      ? { path: 'eval/r3/out/config-preflight.json', sha256: sha256(preflightPath) }
      : null,
  },
  note: 'Design only. The R3 product decision is no candidate; this lane is the evidence that would be needed before a candidate claim.',
}

mkdirSync(OUT, { recursive: true })
const path = join(OUT, 'product-lane-design-r3.json')
writeFileSync(path, `${JSON.stringify(design, null, 2)}\n`, 'utf8')
process.stdout.write(`product-lane design: 72 cells (design only), proposed window ${design.proposedContextWindow}, target ${design.targetContextWindow}\n`)
process.stdout.write(`  economy: retain ${productTiers.economy.retainRatio}, framing ${productTiers.economy.framingMode}, hint ${productTiers.economy.rationaleHintTokens}\n`)
process.stdout.write(`  balanced: retain ${productTiers.balanced.retainRatio}, hint ${productTiers.balanced.rationaleHintTokens}; quality: hint ${productTiers.quality.rationaleHintTokens}\n`)
process.stdout.write(`  executionAuthorized=${design.executionAuthorized}; tasks ${design.taskSet.status}\n`)
process.stdout.write(`wrote ${path}\n`)
