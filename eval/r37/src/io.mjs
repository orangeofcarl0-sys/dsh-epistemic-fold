/**
 * Small, deterministic file and digest helpers shared by the R37 evidence
 * reconstruction, baseline manifest, protocol ablation, and forensics.
 *
 * Everything here is read-only except the explicit `writeJson` call. No helper
 * reaches a provider, mutates a run archive, or rewrites an R36 artifact.
 *
 * @module eval/r37/src/io
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

export function posix(value) {
  return String(value).split(sep).join('/')
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(path) {
  return sha256(await readFile(path))
}

/** Stable JSON so a digest does not depend on property insertion order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function digestOf(value) {
  return sha256(canonicalJson(value))
}

export async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__'])

/** Sorted relative POSIX paths for every regular file under `root`. */
export async function walkFiles(root) {
  const files = []
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
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(posix(relative(root, absolute)))
    }
  }
  await walk(root)
  return files.sort()
}

/** `{ relativePath: sha256 }` for a tree, plus a single tree digest. */
export async function treeManifest(root) {
  const files = await walkFiles(root)
  const entries = {}
  for (const file of files) entries[file] = await sha256File(join(root, file))
  return { root, files: entries, fileCount: files.length, digest: digestOf(entries) }
}

/** A digest of a subset of paths, recording missing files explicitly. */
export async function fileManifest(root, paths) {
  const entries = {}
  for (const path of paths) {
    const absolute = join(root, path)
    entries[path] = await exists(absolute)
      ? { present: true, sha256: await sha256File(absolute), bytes: (await readFile(absolute)).length }
      : { present: false, sha256: null, bytes: null }
  }
  return entries
}
