/**
 * Locate a shipped module by basename, wherever it currently lives under
 * `src/`.
 *
 * Several suites pin a property by reading a module's SOURCE rather than its
 * behaviour — "the message must not derive its count from the retry budget",
 * "no module probes the seam". Those assertions are worth keeping, but a
 * hardcoded `join(ROOT, 'src', 'engine.ts')` turns a pure directory move into
 * an ENOENT that looks like a behavioural regression. Resolving by basename
 * keeps the assertion and removes the layout coupling.
 *
 * Uniqueness is enforced: if two modules share a basename the caller has to say
 * which one it means, because silently picking either would make the assertion
 * meaningless.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC_ROOT = join(import.meta.dirname, '..', 'src')

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
}

/** Absolute path of the single `src/**` module named `name`. */
export function srcModulePath(name: string): string {
  const all: string[] = []
  walk(SRC_ROOT, all)
  const hits = all.filter((p) => p.endsWith('\\' + name) || p.endsWith('/' + name))
  if (hits.length !== 1) {
    throw new Error(`srcModulePath(${name}): expected exactly one module under src/, found ${hits.length}`)
  }
  return hits[0]!
}

/** Source text of the single `src/**` module named `name`. */
export function readSrcModule(name: string): string {
  return readFileSync(srcModulePath(name), 'utf8')
}
