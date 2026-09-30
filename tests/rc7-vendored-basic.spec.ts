/**
 * RC7-T7: EF's vendored copy of the Basic compaction backend stays honest.
 *
 * ## Why this test exists
 *
 * `src/basic/` is a fork of `@deepseek-ai/dsh-compaction-basic`. A fork rots
 * silently: the upstream package changes, EF's copy does not, and nothing
 * notices until a user's fold behaves differently from what EF's own tests
 * assert. The RC5 preset drift test exists for exactly this reason on the preset
 * side; this is its counterpart for the engine.
 *
 * The test is deliberately NOT "the copy equals upstream". It cannot be: the
 * copy inlines the `frameCheckpoint` seam, which upstream does not have, so a
 * byte comparison would fail by construction. What must hold is narrower and
 * checkable:
 *
 *  1. **The seam is present and is the only intended divergence.** The copy must
 *     expose `frameCheckpoint`, and its default must be the stock framing — the
 *     property that makes an un-overridden deployment byte-identical to Basic.
 *  2. **The upstream algorithms EF depends on are unchanged.** Span selection,
 *     the retention walk, the config defaults, and the checkpoint framing text
 *     are compared against the vendored reference. If DSH changes one of those,
 *     this test fails and the vendoring must be re-done deliberately.
 *  3. **The provenance headers are intact.** Every module names its upstream
 *     file, because that is what makes the copy auditable and MIT-compliant.
 *
 * ## What it does NOT cover
 *
 * It cannot see the INSTALLED DSH, only the vendored checkout this repository
 * pins. A drift between the vendored reference and a user's DSH is a real risk
 * and is recorded as such in docs/31 §13 — the mitigation is that `mode: basic`
 * parity is verified against whatever base class EF actually extends
 * (`tests/rc7-basic-parity.spec.ts`), not against a version string.
 *
 * @module tests/rc7-vendored-basic
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import BasicCompactionEngine from '../src/basic/index.ts'

const ROOT = join(import.meta.dirname, '..')
const COPY_DIR = join(ROOT, 'src', 'basic')
const REF_DIR = join(ROOT, 'vendor', 'deepseek-harness', 'packages', 'compaction', 'compaction-basic', 'src')

/** The five modules the copy carries. */
const MODULES = ['config', 'types', 'summarizer', 'region', 'index'] as const

const readCopy = (m: string) => readFileSync(join(COPY_DIR, `${m}.ts`), 'utf8')
const readRef = (m: string) => readFileSync(join(REF_DIR, `${m}.ts`), 'utf8')

/** Strip the provenance header the vendoring script prepends. */
function stripHeader(text: string): string {
  const end = text.indexOf('*/')
  if (end < 0) throw new Error('module has no leading doc comment')
  return text.slice(end + 2).replace(/^\s*\n/u, '')
}

/** Strip the upstream module doc comment the vendoring script replaces. */
function stripRefDoc(text: string): string {
  if (!text.startsWith('/**')) return text
  return text.slice(text.indexOf('*/') + 2).replace(/^\s*\n/u, '')
}

describe('RC7-T7: the vendored Basic copy', () => {
  it('carries every module, each with a SOURCE provenance header', () => {
    for (const m of MODULES) {
      const path = join(COPY_DIR, `${m}.ts`)
      expect(existsSync(path), `${path} must exist`).toBe(true)
      const text = readCopy(m)
      // The header names the exact upstream file: that is what makes the copy
      // auditable and satisfies the MIT notice obligation.
      expect(text, `${m}.ts must name its upstream source`).toContain(
        `SOURCE: @deepseek-ai/dsh-compaction-basic/src/${m}.ts`,
      )
      expect(text, `${m}.ts must state the upstream release`).toMatch(/dsh-v0\.\d+\.\d+/u)
    }
  })

  it('the seam is present on the base class EF extends', () => {
    // The whole reason the copy exists. If this fails, every tier refuses to
    // mount on a DSH build that ships no seam — which is every released build.
    const proto = BasicCompactionEngine.prototype as unknown as Record<string, unknown>
    expect(typeof proto['frameCheckpoint'], 'frameCheckpoint must be a method').toBe('function')
    // ...and it must be OWNED by this class, not inherited from the host: that is
    // the difference between "EF can override framing" and "EF hopes the host
    // provides a hook".
    expect(Object.prototype.hasOwnProperty.call(proto, 'frameCheckpoint')).toBe(true)
  })

  it('the seam default is the STOCK framing, so an un-overridden fold is unchanged', () => {
    // R3-B's contract: adding the seam must not change any surface. The copy
    // proves it by calling the seam with no override and comparing to frameSummary.
    const engine = Object.create(BasicCompactionEngine.prototype) as {
      frameCheckpoint(summary: unknown[], agent: unknown): unknown[]
    }
    const summary = [{ type: 'text', text: 'BODY' }]
    const framed = engine.frameCheckpoint(summary, {})
    const text = (framed as Array<{ type: string; text: string }>).map(b => b.text).join('')
    expect(text).toContain('<compacted-summary>')
    expect(text).toContain('</compacted-summary>')
    expect(text).toContain('BODY')
    // The preamble is what `system-dedup` exists to remove; its presence here is
    // what makes the default the stock behaviour.
    expect(text).toMatch(/automatically generated checkpoint/u)
  })

  it('every module is a byte-identical copy of the reference', () => {
    // The reference checkout ALREADY carries the seam (R3-B applied it), so the
    // copy is not a divergence from the reference — it IS the reference, plus a
    // provenance header. That makes this comparison exact and total: any upstream
    // change, in any module, fails here.
    //
    // The only permitted difference is the header the vendoring script prepends,
    // and the module doc comment it replaces.
    for (const m of MODULES) {
      const copy = stripHeader(readCopy(m)).replace(/\r\n/gu, '\n').trim()
      const ref = stripRefDoc(readRef(m)).replace(/\r\n/gu, '\n').trim()
      expect(copy, `${m}.ts must be an unmodified copy of the reference`).toBe(ref)
    }
  })

  it('the span-selection algorithm matches the reference exactly', () => {
    // The single most load-bearing upstream function: which span a fold takes.
    // Compared on its normalized body so whitespace/quoting cannot mask a change.
    const normalize = (s: string) => s
      .replace(/\r\n/gu, '\n')
      .replace(/\/\*[\s\S]*?\*\//gu, '')          // block comments
      .replace(/^\s*\/\/.*$/gmu, '')              // line comments
      .split('\n').map(l => l.trim()).filter(l => l !== '').join('\n')

    const extract = (text: string): string => {
      const start = text.indexOf('function selectCompactableRange(')
      expect(start, 'selectCompactableRange must exist').toBeGreaterThan(-1)
      // Up to the next top-level export/function after it.
      const rest = text.slice(start)
      const end = rest.indexOf('\n}\n', rest.indexOf('return { start'))
      return normalize(rest.slice(0, end + 2))
    }

    expect(extract(readCopy('region'))).toBe(extract(readRef('region')))
  })
})
