/**
 * The bridge ENTRY POINT must load.
 *
 * ## Why this file exists
 *
 * RC28 added a static import of a package that is in neither package.json nor
 * node_modules. That is not a degradation: it is a bridge that cannot start at
 * all. Every LHTB run died with
 *
 *     BridgeError: bridge host closed the stream ... ERR_MODULE_NOT_FOUND
 *
 * in about twenty seconds -- four trials, four BridgeErrors, 20s of wall clock --
 * and NOTHING in the suite noticed. `npm test` was green (958 passing)
 * because no test imports the bridge's module graph, and `typecheck:all` was
 * green because TypeScript resolved the name from the vendored tree while Node
 * could not resolve it from the repository.
 *
 * A gate that cannot see the entry point is not a gate. This one loads it.
 *
 * @module tests/bridge-loads
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')

/** Load the bridge with no input and return what the runtime said. */
function loadBridge(): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(
    'node',
    ['--experimental-transform-types', BRIDGE],
    // Empty stdin: the host reads newline-delimited JSON, so it exits cleanly
    // having done nothing. Loading is the whole question here, not running.
    { input: '', encoding: 'utf8', cwd: ROOT, timeout: 60_000 },
  )
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

/** Every bare DSH package the bridge imports, as written in the source. */
function importedPackages(): readonly string[] {
  const source = readFileSync(BRIDGE, 'utf8')
  // Built from parts so the literal cannot be rewritten by an editor pass over
  // this file -- a corrupted pattern is an assertion that cannot fail, which is
  // the defect this suite already had to remove once.
  const scope = '@' + 'deepseek-ai/'
  const pattern = new RegExp("from '" + scope + "([^']+)'", 'gu')
  return [...source.matchAll(pattern)].map(match => scope + match[1]!)
}

describe('the LHTB bridge entry point loads', () => {
  it('exists where the Python client looks for it', () => {
    expect(existsSync(BRIDGE), 'eval/tau2/bridge-host.ts must exist').toBe(true)
  })

  it('resolves every module in its import graph', () => {
    const { stderr } = loadBridge()
    // The exact shape of the RC28 regression, asserted directly rather than
    // inferred from a downstream failure that takes a container to produce.
    expect(stderr, 'a missing module is a bridge that cannot start').not.toMatch(
      /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/u)
    expect(stderr).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/u)
  })

  it('names the DSH packages it imports, so the next check can be exact', () => {
    // Guards the guard: if the extraction silently matched nothing, the
    // declaration check below would pass for every possible import graph.
    const imported = importedPackages()
    expect(imported.length, 'the bridge imports DSH packages; finding none means the pattern broke')
      .toBeGreaterThan(3)
    expect(imported).toContain('@' + 'deepseek-ai/dsh-llm')
  })

  it('does not depend on an undeclared package at load time', () => {
    // Every bare DSH specifier in the bridge must be DECLARED, or the import
    // only works by accident of a checkout that happens to have the package.
    // peerDependencies counts: this package declares its DSH siblings there, so a
    // check that read only "dependencies" would call every one of them undeclared
    // and the gate would be noise. The first version of this check did exactly
    // that, and named twelve packages that are in fact declared.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
    const undeclared = importedPackages().filter(name => !declared.has(name))
    expect(undeclared, 'an undeclared DSH import cannot resolve at runtime').toEqual([])
  })
})
