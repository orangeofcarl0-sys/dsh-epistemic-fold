#!/usr/bin/env node
/**
 * Freeze or verify the R33 dataset.
 *
 *   node eval/r33/freeze.mjs            # validate every case and write manifest.json
 *   node eval/r33/freeze.mjs --verify   # refuse if any case changed since freezing
 *
 * Freezing never runs a model. It only validates gold provenance, action
 * references, leakage, and the hidden checker's result marker, then writes the
 * digest of every case and of the whole dataset.
 *
 * @module eval/r33/freeze
 */

import { freezeDataset, verifyFrozen, MANIFEST_PATH } from './src/dataset.mjs'

const verify = process.argv.includes('--verify')

if (verify) {
  const result = await verifyFrozen()
  if (!result.ok) {
    process.stderr.write(`dataset verification FAILED: ${result.reason}\n`)
    for (const error of result.errors ?? []) process.stderr.write(`  ${error.caseId}: ${error.detail}\n`)
    process.exit(2)
  }
  process.stdout.write(`dataset verified: ${result.manifest.caseCount} cases, digest ${result.datasetDigest}\n`)
} else {
  const result = await freezeDataset()
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
  process.stdout.write(`manifest: ${MANIFEST_PATH}\n`)
}
