#!/usr/bin/env node
/**
 * The framing seam, as data: the exact edits EF's vendored Basic copy carries.
 *
 * ## Why this module exists
 *
 * The seam was defined twice — once here (`scripts/apply-framing-seam.mjs`,
 * which patches a vendored DSH checkout) and once inside
 * `scripts/vendor-basic.mjs` (which bakes the same edits into `src/basic/`) —
 * and a THIRD time implicitly, in `tests/rc7-vendored-basic.spec.ts`, which
 * compared the two and therefore assumed a pre-patched checkout.
 *
 * That third copy was never written down, and it broke CI for a month.
 *
 * ## The failure this explains
 *
 * `src/basic/*.ts` carries the seam. The drift test compares it against
 * `vendor/deepseek-harness/packages/compaction/compaction-basic/src/*.ts` —
 * which upstream ships WITHOUT the seam. So the comparison passes only when the
 * checkout has been patched first:
 *
 *   locally  `apply-framing-seam.mjs` had been run, leaving the vendor tree
 *            dirty, so the comparison passed — a FALSE GREEN
 *   CI       a clean checkout at the pinned commit, never patched, so the
 *            comparison failed — the real answer, for every run since R3-B
 *
 * Measured before this extraction: 40 consecutive CI runs, 0 successes.
 *
 * ## What this changes
 *
 * The edits live here as plain data. `vendor-basic.mjs` applies them when
 * producing the copy; the drift test applies them to the reference before
 * comparing. Neither depends on the checkout having been patched, so the same
 * verdict holds on any machine.
 *
 * @module scripts/framing-seam
 */

/**
 * One exact text edit, with the anchor that proves the source has not drifted.
 *
 * `marker` is what the edit ADDS: if the marker is already present and the
 * anchor is gone, the edit has been applied and is skipped, which is what makes
 * application idempotent.
 *
 * @typedef {object} SeamEdit
 * @property {string} module  the module the edit belongs to
 * @property {string} marker  text proving the edit already landed
 * @property {string} find    the exact upstream text to replace
 * @property {string} replace what it becomes
 */

/** @type {readonly SeamEdit[]} */
export const SEAM_EDITS = [
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
      + '   * Wrap a summary into the durable checkpoint message content. Defaults to\n'
      + '   * {@link frameSummary}; the hook exists so a backend may replace the\n'
      + '   * PER-CHECKPOINT framing without touching the transaction, the shrink check,\n'
      + '   * or the surface replacement rules.\n'
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
  {
    // The override point itself: the dependency bag gains a pass-through, and
    // the class gains the method it forwards to.
    module: 'index',
    marker: 'protected frameCheckpoint(',
    find: '      }, () => false),\n'
      + '    }\n'
      + '  }\n'
      + '}\n',
    replace: '      }, () => false),\n'
      + '      frameCheckpoint: (summary, agent) => this.frameCheckpoint(summary, agent),\n'
      + '    }\n'
      + '  }\n'
      + '\n'
      + '  /**\n'
      + '   * Wrap one summary into the durable checkpoint message content.\n'
      + '   *\n'
      + '   * The default is Basic\'s own framing, so a deployment that overrides nothing\n'
      + '   * produces byte-identical surfaces to before this hook existed. A subclass\n'
      + '   * may replace the PER-CHECKPOINT framing — the preamble text and wrapper\n'
      + '   * tags repeated once per fold — while inheriting the transaction, the shrink\n'
      + '   * check, the surface replacement rules, and the lock discipline untouched.\n'
      + '   *\n'
      + '   * This is a pure extensibility seam: it adds a way to change the framing and\n'
      + '   * changes no behavior by itself.\n'
      + '   *\n'
      + '   * @param summary - the safe text-only summary blocks to frame.\n'
      + '   * @param agent - the agent whose fold produced them.\n'
      + '   * @returns content for the synthesized replacement user message.\n'
      + '   */\n'
      + '  protected frameCheckpoint(\n'
      + '    summary: readonly ContentBlock[],\n'
      + '    agent: Agent,\n'
      + '  ): ContentBlock[] {\n'
      + '    void agent\n'
      + '    return frameSummary(summary)\n'
      + '  }\n'
      + '}\n',
  },
]

/** The upstream files the copy carries, in dependency order. */
export const SEAM_MODULES = ['config', 'types', 'summarizer', 'region', 'index']

/**
 * Apply every seam edit for one module, verifying each anchor is present.
 *
 * Idempotent: an edit whose marker is present and whose anchor is gone is
 * already applied and is skipped.
 *
 * @param {string} text the module source, already stripped of its doc comment.
 * @param {string} module the module name.
 * @returns {string} the patched source.
 * @throws when an anchor is missing — that means the upstream source drifted, and
 *   silently continuing would produce a copy that differs for a reason nobody
 *   recorded.
 */
export function applySeam(text, module) {
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
