#!/usr/bin/env node
/**
 * Re-vendor EF's copy of the Basic compaction backend (RC7).
 *
 * ## Why this script exists
 *
 * `src/basic/` is a copy of `@deepseek-ai/dsh-compaction-basic`. EF extends it
 * instead of the host package for two reasons that are both load-bearing:
 *
 *  1. **The framing seam.** Every EF tier sets `framingMode: system-dedup`,
 *     which needs a `frameCheckpoint` hook. No released DSH ships one — measured
 *     against the installed `0.2.0-rc.2`, `typeof
 *     BasicCompactionEngine.prototype.frameCheckpoint === 'undefined'` — so
 *     before RC7 every tier refused to mount on a real install. Owning the base
 *     class makes the seam a line in EF's own source.
 *
 *  2. **`mode: basic`.** EF must be able to stand aside and produce a
 *     byte-identical native Basic checkpoint. A SUBCLASS of the host engine
 *     cannot: virtual dispatch re-enters EF's overrides
 *     (`compactRegion -> summarize -> frameCheckpoint -> compactRegion`), which
 *     was measured. With EF's own copy, the pass-through branches reach code
 *     that is not EF's.
 *
 * ## What it does
 *
 * Copies the five source files from a DSH checkout, inlines the framing seam
 * into the copy, and prepends a `SOURCE:` provenance header naming the upstream
 * file. The seam edits are the same ones `scripts/apply-framing-seam.mjs`
 * applies to a vendored checkout — that script is retained as the record of
 * what the seam is; this script bakes its result into EF's copy.
 *
 * ## Usage
 *
 *   node scripts/vendor-basic.mjs [--dsh <path-to-deepseek-harness>]
 *
 * The path defaults to `vendor/deepseek-harness`. Re-run after upgrading the
 * vendored checkout, then run `tests/rc7-vendored-basic.spec.ts` — it fails when
 * the copy and the reference disagree.
 *
 * @module scripts/vendor-basic
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'basic')

/** The upstream files the copy carries, in dependency order. */
const MODULES = ['config', 'types', 'summarizer', 'region', 'index']

/** The upstream release this copy tracks. */
const UPSTREAM_VERSION = 'dsh-v0.1.7-rc.2'

/** One exact text edit, with the anchor that proves the source has not drifted. */
const SEAM_EDITS = [
  {
    module: 'region',
    marker: 'readonly frameCheckpoint?:',
    find: "import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'",
    replace: "import type { Message, UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm'",
  },
  {
    module: 'region',
    marker: 'readonly frameCheckpoint?:',
    find: '  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean\n}',
    replace: '  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean\n'
      + '  /**\n'
      + '   * Wrap a summary into the durable checkpoint message content.\n'
      + '   *\n'
      + '   * The SEAM (R3-B): the default is the stock framing, so a deployment that\n'
      + '   * overrides nothing produces byte-identical surfaces. EF overrides it to move\n'
      + '   * the per-checkpoint preamble into one stable system-prompt section.\n'
      + '   */\n'
      + '  readonly frameCheckpoint?: (summary: readonly ContentBlock[], agent: Agent) => ContentBlock[]\n'
      + '}',
  },
  {
    module: 'region',
    marker: '(dependencies.frameCheckpoint ?? frameSummary)',
    find: '    content: frameSummary(summaryResult.summary),',
    replace: '    content: (dependencies.frameCheckpoint ?? frameSummary)(summaryResult.summary, agent),',
  },
  {
    module: 'index',
    marker: 'protected frameCheckpoint(',
    find: "import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'",
    replace: "import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'",
  },
  {
    module: 'index',
    marker: 'protected frameCheckpoint(',
    find: "import { summarizeWithLlm } from './summarizer.ts'",
    replace: "import { frameSummary, summarizeWithLlm } from './summarizer.ts'",
  },
]

/** The provenance header every copied module carries. */
function header(module) {
  return `/**
 * SOURCE: @deepseek-ai/dsh-compaction-basic/src/${module}.ts
 * Vendored from DeepSeek Harness ${UPSTREAM_VERSION} (MIT), with the
 * \`frameCheckpoint\` seam inlined. See THIRD_PARTY_NOTICES.md.
 *
 * Do not edit to change behaviour: this file exists so EF owns the base class
 * it extends, so a tier can mount on a DSH build that ships no seam, and so
 * \`mode: basic\` can reproduce native Basic byte-for-byte. Regenerate with
 * \`node scripts/vendor-basic.mjs\`; tests/rc7-vendored-basic.spec.ts fails when
 * this copy and the reference disagree.
 */
`
}

/** Strip the upstream module doc comment; the provenance header replaces it. */
function stripLeadingDocComment(text, module) {
  if (!text.startsWith('/**')) throw new Error(`${module}.ts: does not start with a doc comment`)
  return text.slice(text.indexOf('*/') + 2).replace(/^\s*\n/u, '')
}

/** Apply every seam edit for one module, verifying each anchor is present. */
function applySeam(text, module) {
  let out = text
  for (const edit of SEAM_EDITS) {
    if (edit.module !== module) continue
    if (out.includes(edit.marker) && !out.includes(edit.find)) continue // already applied
    if (!out.includes(edit.find)) {
      throw new Error(
        `${module}.ts: seam anchor not found — the upstream source has drifted.\n`
        + `  expected: ${JSON.stringify(edit.find.slice(0, 80))}`,
      )
    }
    out = out.replace(edit.find, edit.replace)
  }
  return out
}

const argv = process.argv.slice(2)
const dshRoot = resolve(
  argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : join(ROOT, 'vendor', 'deepseek-harness'),
)
const SRC = join(dshRoot, 'packages', 'compaction', 'compaction-basic', 'src')

mkdirSync(OUT, { recursive: true })
for (const module of MODULES) {
  const source = readFileSync(join(SRC, `${module}.ts`), 'utf8')
  const body = applySeam(stripLeadingDocComment(source, module), module)
  writeFileSync(join(OUT, `${module}.ts`), `${header(module)}\n${body}`, 'utf8')
  console.log(`vendored src/basic/${module}.ts`)
}
console.log(`\nfrom ${SRC}`)
console.log('now run: npx vitest run tests/rc7-vendored-basic.spec.ts')
