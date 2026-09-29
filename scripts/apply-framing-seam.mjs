#!/usr/bin/env node
/**
 * Apply the DSH framing seam (R3-B) to a vendored DSH checkout.
 *
 * WHY THIS IS A SCRIPT AND NOT ONLY A PATCH
 *
 * The seam touches two files the upstream repo ignores: the compiled
 * `lib/types/*.d.ts` faces. `git diff` therefore cannot carry them, and a
 * `.patch` alone would apply "successfully" while leaving the EF plugin
 * unable to typecheck against `frameCheckpoint`. This script patches the
 * source AND the declaration faces, and verifies each edit landed.
 *
 * WHAT THE SEAM IS
 *
 * `frameSummary()` wraps every checkpoint body in a fixed preamble plus
 * `<compacted-summary>` tags. That framing is the largest single component of
 * a leaf checkpoint's cost and it repeats once per fold. The R2 framing
 * analysis measured that no EF-side dieting can remove it, because EF does not
 * own it — so DSH must expose a seam.
 *
 * The seam is PURE: it adds an overridable `frameCheckpoint` whose default is
 * the existing `frameSummary`, so a deployment that overrides nothing produces
 * byte-identical surfaces. `tests/r3c-framing-seam.spec.ts` enforces that.
 *
 * WHY NOT COPY `compactSurfaceRegion` INTO EF INSTEAD
 *
 * Because that would re-assume the compaction lock, surface stability,
 * tool-pair safety, summary recovery, crash consistency, commit ordering, and
 * flush discipline — all of which Basic already owns and gets right (R3 §21,
 * an absolute prohibition).
 *
 * USAGE
 *
 *   node scripts/apply-framing-seam.mjs [path-to-deepseek-harness]
 *
 * Idempotent: re-running reports "already applied" rather than double-patching.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'vendor/deepseek-harness')
const pkg = join(root, 'packages', 'compaction', 'compaction-basic')

/** One exact replacement, with the anchor that proves it has not drifted. */
const EDITS = [
  {
    file: join(pkg, 'src', 'region.ts'),
    marker: 'readonly frameCheckpoint?:',
    find: "import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'",
    replace: "import type { Message, UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm'",
  },
  {
    file: join(pkg, 'src', 'region.ts'),
    marker: 'readonly frameCheckpoint?:',
    find: `  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean
}`,
    replace: `  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean
  /**
   * Wrap a summary into the durable checkpoint message content. Defaults to
   * {@link frameSummary}; the hook exists so a backend may replace the
   * PER-CHECKPOINT framing without touching the transaction, the shrink check,
   * or the surface replacement rules.
   */
  readonly frameCheckpoint?: (summary: readonly ContentBlock[], agent: Agent) => ContentBlock[]
}`,
  },
  {
    file: join(pkg, 'src', 'region.ts'),
    marker: '(dependencies.frameCheckpoint ?? frameSummary)',
    find: '    content: frameSummary(summaryResult.summary),',
    replace: '    content: (dependencies.frameCheckpoint ?? frameSummary)(summaryResult.summary, agent),',
  },
  {
    file: join(pkg, 'src', 'index.ts'),
    marker: 'protected frameCheckpoint(',
    find: "import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'",
    replace: "import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'",
  },
  {
    file: join(pkg, 'src', 'index.ts'),
    marker: 'protected frameCheckpoint(',
    find: "import { summarizeWithLlm } from './summarizer.ts'",
    replace: "import { frameSummary, summarizeWithLlm } from './summarizer.ts'",
  },
  {
    file: join(pkg, 'src', 'index.ts'),
    marker: 'protected frameCheckpoint(',
    find: `      }, () => false),
    }
  }
}`,
    replace: `      }, () => false),
      frameCheckpoint: (summary, agent) => this.frameCheckpoint(summary, agent),
    }
  }

  /**
   * Wrap one summary into the durable checkpoint message content.
   *
   * The default is Basic's own framing, so a deployment that overrides nothing
   * produces byte-identical surfaces to before this hook existed. A subclass
   * may replace the PER-CHECKPOINT framing — the preamble text and wrapper
   * tags repeated once per fold — while inheriting the transaction, the shrink
   * check, the surface replacement rules, and the lock discipline untouched.
   *
   * This is a pure extensibility seam: it adds a way to change the framing and
   * changes no behavior by itself.
   *
   * @param summary - the safe text-only summary blocks to frame.
   * @param agent - the agent whose fold produced them.
   * @returns content for the synthesized replacement user message.
   */
  protected frameCheckpoint(
    summary: readonly ContentBlock[],
    agent: Agent,
  ): ContentBlock[] {
    void agent
    return frameSummary(summary)
  }
}`,
  },
  // --- Declaration faces (upstream-gitignored; the diff cannot carry them).
  {
    file: join(pkg, 'lib', 'types', 'region.d.ts'),
    marker: 'readonly frameCheckpoint?:',
    find: `    recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean;
}`,
    replace: `    recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean;
    /**
     * Wrap a summary into the durable checkpoint message content. Defaults to
     * \`frameSummary\`; the hook exists so a backend may replace the
     * per-checkpoint framing without touching the transaction.
     */
    readonly frameCheckpoint?: (summary: readonly ContentBlock[], agent: Agent) => ContentBlock[];
}`,
  },
  {
    file: join(pkg, 'lib', 'types', 'region.d.ts'),
    marker: 'readonly frameCheckpoint?:',
    find: 'interface RegionDependencies {',
    replace: "import type { ContentBlock } from '@deepseek-ai/dsh-llm';\ninterface RegionDependencies {",
  },
  {
    file: join(pkg, 'lib', 'types', 'index.d.ts'),
    marker: 'protected frameCheckpoint(',
    find: "import type { CommandId } from '@deepseek-ai/dsh-commands/brand';",
    replace: "import type { CommandId } from '@deepseek-ai/dsh-commands/brand';\nimport type { ContentBlock } from '@deepseek-ai/dsh-llm';",
  },
  {
    file: join(pkg, 'lib', 'types', 'index.d.ts'),
    marker: 'protected frameCheckpoint(',
    find: `    /** Bind the effective token meter and dynamically dispatched summarizer hook. */
    private regionDependencies;`,
    replace: `    /**
     * Wrap one summary into the durable checkpoint message content.
     *
     * The default is Basic's own framing, so overriding nothing produces
     * byte-identical surfaces. A subclass may replace the per-checkpoint
     * framing while inheriting the transaction, shrink check, and surface
     * replacement rules untouched.
     * @param summary - the safe text-only summary blocks to frame.
     * @param agent - the agent whose fold produced them.
     * @returns content for the synthesized replacement user message.
     */
    protected frameCheckpoint(summary: readonly ContentBlock[], agent: Agent): ContentBlock[];
    /** Bind the effective token meter and dynamically dispatched summarizer hook. */
    private regionDependencies;`,
  },
]

let applied = 0
let already = 0
let missing = 0

for (const edit of EDITS) {
  if (!existsSync(edit.file)) {
    console.error(`MISSING FILE ${edit.file}`)
    missing += 1
    continue
  }
  const text = readFileSync(edit.file, 'utf8')
  if (text.includes(edit.marker)) {
    already += 1
    continue
  }
  if (!text.includes(edit.find)) {
    console.error(`ANCHOR NOT FOUND in ${edit.file}:\n  ${edit.find.slice(0, 80)}...`)
    missing += 1
    continue
  }
  writeFileSync(edit.file, text.replace(edit.find, edit.replace), 'utf8')
  applied += 1
}

console.log(`framing seam: ${applied} applied, ${already} already present, ${missing} failed`)
if (missing > 0) {
  console.error('the vendored DSH does not match the expected baseline; seam NOT fully applied')
  process.exit(1)
}
