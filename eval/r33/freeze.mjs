#!/usr/bin/env node
/**
 * Freeze or verify a frozen dataset.
 *
 *   node eval/r33/freeze.mjs              # freeze/verify the v2 development set
 *   node eval/r33/freeze.mjs --verify
 *   node eval/r33/freeze.mjs --holdout    # freeze the separate holdout
 *   node eval/r33/freeze.mjs --holdout --verify
 *
 * Freezing never runs a model. It only validates gold provenance, action
 * references, leakage, and the hidden checker's declared checks, then writes
 * the digest of every case and of the whole dataset.
 *
 * @module eval/r33/freeze
 */

import {
  freezeDataset,
  freezeHoldout,
  verifyFrozen,
  verifyHoldout,
  MANIFEST_PATH,
  HOLDOUT_MANIFEST_PATH,
} from './src/dataset.mjs'

const verifyFlag = process.argv.includes('--verify')
const holdout = process.argv.includes('--holdout')
const manifestPath = holdout ? HOLDOUT_MANIFEST_PATH : MANIFEST_PATH

if (verifyFlag) {
  const result = holdout ? await verifyHoldout() : await verifyFrozen()
  if (!result.ok) {
    process.stderr.write(`dataset verification FAILED: ${result.reason}\n`)
    for (const error of result.errors ?? []) process.stderr.write(`  ${error.caseId}: ${error.detail}\n`)
    process.exit(2)
  }
  process.stdout.write(`dataset verified: ${result.manifest.caseCount} cases, digest ${result.datasetDigest}\n`)
} else {
  const result = holdout ? await freezeHoldout() : await freezeDataset()
  if (!result.ok) {
    process.stderr.write('dataset freeze FAILED:\n')
    for (const error of result.errors) process.stderr.write(`  ${error.caseId}: ${error.detail}\n`)
    process.exit(2)
  }
  const { manifest } = result
  process.stdout.write(`dataset frozen: ${manifest.caseCount} cases, digest ${manifest.datasetDigest}\n`)
  for (const [riskClass, count] of Object.entries(manifest.counts).sort()) {
    process.stdout.write(`  ${riskClass}: ${count}\n`)
  }
  process.stdout.write(`manifest: ${manifestPath}\n`)
}
