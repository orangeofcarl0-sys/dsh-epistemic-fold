/**
 * A README that names files which do not exist is worse than no README.
 *
 * The repository already asserts this for `docs/` -- rc3-plugin-packaging fails when a numbered
 * document is missing from the index, "or a reader following the map will not find it" -- and the
 * same failure is available one directory down, where a table of files is the map.
 *
 * The check is deliberately about NAMES and LINKS rather than prose: those are the parts a reader
 * acts on, and the parts that go stale when a file is renamed.
 *
 * @module tests/memory-readme
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MEM = join(ROOT, 'eval', 'memory')
const README = join(MEM, 'README.md')

describe('the memory module README', () => {
  const text = readFileSync(README, 'utf8')

  it('links only to files that exist', () => {
    const links = [...text.matchAll(/\]\(([^)]+)\)/gu)].map(m => m[1])
    expect(links.length, 'the README should point somewhere').toBeGreaterThan(0)
    for (const l of links) {
      expect(existsSync(resolve(dirname(README), l)), l + ' must resolve').toBe(true)
    }
  })

  it('names only files that exist', () => {
    const named = [...text.matchAll(/`([a-z_]+\.(?:py|json|sh))`/gu)].map(m => m[1])
    expect(named.length).toBeGreaterThan(0)
    for (const n of new Set(named)) {
      expect(existsSync(join(MEM, n)), n + ' is named but absent').toBe(true)
    }
  })

  it('says the pipeline is not yet run, because it has not been', () => {
    // The provider answered HTTP 429 for the whole session this was written in. A README that
    // implied results would be the most expensive kind of stale.
    expect(text).toMatch(/not yet run/u)
    expect(text).toContain('429')
  })

  it('states the control is regenerable memory rather than an uncompressed context', () => {
    // The one idea a reader has to take away, because getting it wrong inflates retention.
    expect(text).toContain('regenerable memory')
    expect(text).toContain('load penalty is silently credited')
  })
})
