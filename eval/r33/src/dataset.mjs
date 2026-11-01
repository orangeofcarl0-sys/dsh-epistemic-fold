/**
 * Load the frozen R33 cases from disk into one validated, digestible shape.
 *
 * A case is a directory, not a single JSON blob:
 *
 *   cases/<id>/case.json        metadata, transcript, gold, actions, decisions
 *   cases/<id>/workspace/**     the EXACT initial files the follow-up agent sees
 *   cases/<id>/actions/<name>/** files one scripted action applies
 *   cases/<id>/check.mjs        the hidden checker (never copied into workspace)
 *
 * The digest covers all four, so a change to a comment in a workspace file or a
 * hidden assertion changes the dataset identity. `freeze.mjs` writes the
 * manifest; the runner refuses a manifest whose digest no longer matches.
 *
 * @module eval/r33/src/dataset
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestOf, canonicalJson } from './canonical.mjs'
import { validateCase, CASE_SCHEMA_VERSION } from './schema.mjs'

export const CASES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases')
export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json')
export const DATASET_ID = 'r33-semantic-continuity-v1'

const SKIP = new Set(['.git', 'node_modules', '__pycache__'])

function posix(value) {
  return value.split(sep).join('/')
}

/** Read a directory tree into `{ relativePosixPath: content }`. */
export async function readTree(root) {
  const files = {}
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        files[posix(relative(root, absolute))] = await readFile(absolute, 'utf8')
      }
    }
  }
  await walk(root)
  return files
}

/** List case ids that have a `case.json`, in sorted order. */
export async function listCaseIds() {
  const entries = await readdir(CASES_ROOT, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/** Assemble one case directory into the shape `validateCase` expects. */
export async function loadCase(id) {
  const root = join(CASES_ROOT, id)
  const metadata = JSON.parse(await readFile(join(root, 'case.json'), 'utf8'))
  const workspace = { files: await readTree(join(root, 'workspace')) }
  const actions = {}
  const actionMeta = metadata.actionMeta ?? {}
  const actionIds = await readdir(join(root, 'actions'), { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
    .catch(() => [])
  for (const actionId of actionIds) {
    actions[actionId] = {
      ...(actionMeta[actionId] ?? {}),
      files: await readTree(join(root, 'actions', actionId)),
    }
  }
  const checkerSource = await readFile(join(root, 'check.mjs'), 'utf8')
  const assembled = {
    ...metadata,
    workspace,
    actions,
    checker: { ...(metadata.checker ?? {}), source: checkerSource },
  }
  const digest = digestOf({
    metadata,
    workspace,
    actions,
    checkerSource,
  })
  return { ...assembled, digest, directory: root }
}

/**
 * Load and validate every case.
 *
 * @returns {Promise<{cases:object[], errors:object[], datasetDigest:string}>}
 */
export async function loadDataset() {
  const ids = await listCaseIds()
  const cases = []
  const errors = []
  for (const id of ids) {
    try {
      const assembled = await loadCase(id)
      const verdict = validateCase(assembled)
      if (!verdict.ok) {
        errors.push({ caseId: id, code: verdict.code, detail: verdict.detail })
        continue
      }
      cases.push(verdict.case)
    } catch (error) {
      errors.push({ caseId: id, code: 'case-load', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const datasetDigest = digestOf({
    schemaVersion: CASE_SCHEMA_VERSION,
    datasetId: DATASET_ID,
    cases: cases.map(entry => ({ id: entry.id, digest: entry.digest })),
  })
  return { cases, errors, datasetDigest }
}

/** Write the manifest after a successful validation. */
export async function freezeDataset(now = new Date()) {
  const { cases, errors, datasetDigest } = await loadDataset()
  if (errors.length > 0) return { ok: false, errors }
  const counts = {}
  for (const entry of cases) counts[entry.riskClass] = (counts[entry.riskClass] ?? 0) + 1
  const manifest = {
    schemaVersion: CASE_SCHEMA_VERSION,
    datasetId: DATASET_ID,
    frozenAt: now.toISOString(),
    caseCount: cases.length,
    counts,
    datasetDigest,
    cases: cases
      .map(entry => ({ id: entry.id, riskClass: entry.riskClass, digest: entry.digest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { ok: true, manifest }
}

/** Verify a dataset against a previously frozen manifest. */
export async function verifyFrozen(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const { cases, errors, datasetDigest } = await loadDataset()
  if (errors.length > 0) return { ok: false, reason: 'schema errors', errors }
  const byId = new Map(cases.map(entry => [entry.id, entry]))
  for (const frozen of manifest.cases) {
    const current = byId.get(frozen.id)
    if (current === undefined) return { ok: false, reason: `case ${frozen.id} is missing` }
    if (current.digest !== frozen.digest) {
      return { ok: false, reason: `case ${frozen.id} changed since it was frozen` }
    }
  }
  if (cases.length !== manifest.caseCount) return { ok: false, reason: 'case count changed' }
  if (datasetDigest !== manifest.datasetDigest) return { ok: false, reason: 'dataset digest changed' }
  return { ok: true, manifest, datasetDigest, canonical: canonicalJson(manifest) }
}
