/**
 * RC2 §2: the real tasks the mode comparison runs.
 *
 * Each task is a small but GENUINE piece of work with three properties that make
 * it a measurement rather than a demonstration:
 *
 *  1. **It has an artifact.** The outcome is a file on disk, so TaskQuality is
 *     checked by reading the filesystem, not by judging the model's prose.
 *  2. **It is long enough to fold.** The session must cross the fold threshold
 *     several times, or the comparison says nothing about a mode's fold policy.
 *  3. **It establishes facts the task later depends on.** A constraint, a
 *     revised spec, an interface — declared early, used late. That is what makes
 *     EpistemicSteady measurable: by the time the task needs them, the facts are
 *     inside checkpoints, and only what the mode PRESERVED can still be used.
 *
 * ## The supersession shape
 *
 * Every task revises one of its own facts mid-task. That is deliberate: RC1.3.1
 * built the temporal retrieval guard, and this is where its value shows up in a
 * real task rather than a probe. A mode that loses the revision produces an
 * artifact built to the OLD spec, which the quality checks catch.
 *
 * @module eval/real-task/tasks
 */

import { assertsValueAsCurrent } from './metrics.ts'
import type { SteadinessProbe } from './metrics.ts'

/** One checkable property of a finished task's artifact. */
export interface QualityCheck {
  readonly id: string
  readonly detail: string
  readonly passed: (state: {
    readonly read: (path: string) => Promise<string | undefined>
    readonly files: readonly string[]
    readonly answer: string
  }) => Promise<boolean> | boolean
}

/** One real task. */
export interface RealTask {
  readonly id: string
  readonly kind: 'coding' | 'research' | 'tool-heavy'
  /** What the user wants, in the user's words. Sent as the opening message. */
  readonly brief: string
  /**
   * The facts the task establishes, in order, as separate user turns.
   *
   * Sent as SEPARATE MESSAGES because that is what a real session looks like —
   * a person adds context over time, and a later message can revise an earlier
   * one. Batching them into one message would test summarization of a single
   * blob instead of a session's grip on a conversation.
   */
  readonly context: readonly string[]
  /** The work, sent after the context has been folded away. */
  readonly work: readonly string[]
  readonly quality: readonly QualityCheck[]
  readonly steadiness: readonly SteadinessProbe[]
}

/** Read a JSON config file and check a property of it. */
async function jsonOf(
  read: (path: string) => Promise<string | undefined>,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const raw = await read(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Task 1 — a coding task with a revised spec.
 *
 * The revision is the whole point: `maxItems` starts at 10 and is corrected to
 * 25. An artifact built to 10 fails the quality check, and the steadiness probe
 * asks directly whether the CURRENT value is the one in use.
 */
export const CODING_TASK: RealTask = {
  id: 'coding-paginate',
  kind: 'coding',
  brief:
    'We need a small Node module for paginating a list. I will give you the requirements as we go.',
  context: [
    'Requirement: the module must expose a `paginate(items, page, pageSize)` function returning '
    + '`{ items, page, pageSize, totalPages }`.',
    'Constraint: the module must never mutate the input array. It must be usable on a frozen array.',
    'Interface: the file must be written to `src/paginate.js` and export `paginate` as a NAMED export.',
    'Requirement: `pageSize` defaults to 10 when omitted.',
    // THE REVISION. A later turn changes an earlier value.
    'CORRECTION to the default: `pageSize` must default to 25, not 10. Please use 25 from now on.',
  ],
  work: [
    'Now write `src/paginate.js` implementing the requirements. Use the CORRECTED default.',
    'Write a small test script at `test.js` that imports your module, paginates an array of 60 items '
    + 'with no pageSize argument, and prints `JSON.stringify` of the result. Run it with run_node and '
    + 'make sure it works before you finish.',
    'Report the final contents of src/paginate.js and the output of your test.',
  ],
  quality: [
    {
      id: 'module-exists',
      detail: 'src/paginate.js was written',
      passed: ({ files }) => files.includes('src/paginate.js'),
    },
    {
      id: 'named-export',
      detail: 'exposes `paginate` as a named export (ESM or CommonJS)',
      passed: async ({ read }) => {
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        // BOTH module systems count. The first version of this check accepted
        // only ESM syntax, and a run that used `module.exports = { paginate }` —
        // a perfectly good named export — was scored as a failure. A quality
        // check that rejects correct work manufactures a mode difference.
        const esm = /export\s+(async\s+)?function\s+paginate|export\s*\{[^}]*paginate/u.test(source)
        const cjs = /module\.exports\s*=\s*\{[^}]*paginate|exports\.paginate\s*=/u.test(source)
        return esm || cjs
      },
    },
    {
      id: 'test-exists',
      detail: 'a test script was written',
      passed: ({ files }) => files.includes('test.js'),
    },
    {
      id: 'no-mutation',
      detail: 'does not mutate its input (no in-place sort/splice/reverse on the argument)',
      passed: async ({ read }) => {
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        // A cheap structural check: an in-place mutation of the parameter.
        return !/\b(items|list|array)\s*\.\s*(sort|splice|reverse|push|pop|shift|unshift)\s*\(/u.test(source)
      },
    },
  ],
  steadiness: [
    {
      id: 'constraint-retained',
      question: 'the no-mutation constraint declared early is still respected',
      holds: async ({ read }) => {
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        return !/\b(items|list|array)\s*\.\s*(sort|splice|reverse|push|pop|shift|unshift)\s*\(/u.test(source)
      },
    },
    {
      id: 'revision-honoured',
      question: 'the CORRECTED default (25) is the one implemented',
      holds: async ({ read }) => {
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        // The revised value must appear, and the superseded one must not be the
        // default. A file that still defaults to 10 was built to the old spec.
        return /\b25\b/u.test(source) && !/pageSize\s*=\s*10\b/u.test(source)
      },
    },
    {
      id: 'no-resurrection',
      question: 'the superseded default (10) did not come back as current',
      holds: async ({ answer, read }) => {
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        // Checked in BOTH the artifact and the prose: a model that wrote 25 but
        // REPORTED 10 has not retained the revision either. The prose check is
        // clause-based, so a correct answer that NAMES the superseded value
        // ("25, superseding the earlier 10") is not punished for naming it.
        const artifactClean = !/pageSize\s*=\s*10\b/u.test(source)
        const proseClean = !assertsValueAsCurrent(answer, /\b10\b/u, /default|pageSize|batch/iu)
        return artifactClean && proseClean
      },
    },
    {
      id: 'interface-honoured',
      question: 'the declared file path and named export are the ones used',
      holds: async ({ files, read }) => {
        if (!files.includes('src/paginate.js')) return false
        const source = await read('src/paginate.js')
        if (source === undefined) return false
        // Either module system, for the same reason the quality check accepts
        // both: the interface was "a named export at this path", not "ESM".
        return /export/u.test(source) || /module\.exports/u.test(source)
      },
    },
  ],
}

/**
 * Task 2 — an engineering task whose early facts are numeric and specific.
 *
 * The numbers are chosen so a summary that drops them cannot be guessed at:
 * nobody infers a 3-attempt cap or a 1500 ms timeout. The revision changes the
 * timeout, so the artifact records which version the session kept.
 */
export const RESEARCH_TASK: RealTask = {
  id: 'research-retry-policy',
  kind: 'research',
  brief:
    'We are specifying a retry policy for our ingestion client. I will describe the constraints, '
    + 'then ask you to produce the config.',
  context: [
    'Constraint: at most 3 attempts per request, including the first. Never more.',
    'Constraint: the backoff must be exponential with a 100 ms base and full jitter.',
    'Constraint: the per-attempt timeout is 1500 ms.',
    'Constraint: a 429 response must be retried regardless of the attempt count remaining.',
    // THE REVISION.
    'CORRECTION: the per-attempt timeout is 3000 ms, not 1500 ms. Please use 3000.',
    'Decision: the policy ships as JSON at `config/retry.json`.',
  ],
  work: [
    'Write `config/retry.json` encoding the policy exactly as specified. Use the CORRECTED timeout.',
    'Write `check.js` that reads `config/retry.json`, verifies every constraint, and prints '
    + '`OK` or `MISMATCH: <what>` for each. Run it with run_node.',
    'Report the final JSON and your checker output.',
  ],
  quality: [
    {
      id: 'config-exists',
      detail: 'config/retry.json was written',
      passed: ({ files }) => files.includes('config/retry.json'),
    },
    {
      id: 'config-valid-json',
      detail: 'the config parses as JSON',
      passed: async ({ read }) => (await jsonOf(read, 'config/retry.json')) !== undefined,
    },
    {
      id: 'checker-exists',
      detail: 'a checker script was written',
      passed: ({ files }) => files.includes('check.js'),
    },
    {
      id: 'max-attempts',
      detail: 'records the 3-attempt cap',
      passed: async ({ read }) => {
        const config = await jsonOf(read, 'config/retry.json')
        return config !== undefined && JSON.stringify(config).includes('3')
      },
    },
  ],
  steadiness: [
    {
      id: 'constraint-retained',
      question: 'the 3-attempt cap survived the fold',
      holds: async ({ read }) => {
        const config = await jsonOf(read, 'config/retry.json')
        return config !== undefined && /\b3\b/u.test(JSON.stringify(config))
      },
    },
    {
      id: 'revision-honoured',
      question: 'the CORRECTED timeout (3000) is the one shipped',
      holds: async ({ read }) => {
        const config = await jsonOf(read, 'config/retry.json')
        return config !== undefined && /3000/u.test(JSON.stringify(config))
      },
    },
    {
      id: 'no-resurrection',
      question: 'the superseded timeout (1500) did not come back as current',
      holds: async ({ read, answer }) => {
        const config = await jsonOf(read, 'config/retry.json')
        if (config === undefined) return false
        const artifactClean = !/1500/u.test(JSON.stringify(config))
        // Clause-based, so naming the superseded timeout while explaining the
        // correction is not itself a resurrection.
        const proseClean = !assertsValueAsCurrent(answer, /\b1500\b/u, /timeout|ms\b/iu)
        return artifactClean && proseClean
      },
    },
    {
      id: 'interface-honoured',
      question: 'the policy shipped at the declared path',
      holds: ({ files }) => files.includes('config/retry.json'),
    },
  ],
}

/**
 * Task 3 — a tool-heavy task that forces many real tool calls.
 *
 * Each file is written from a fact stated once, early. The session must keep
 * all of them to produce a consistent set, and the manifest is checked against
 * the individual files, so an inconsistency is visible in the artifact.
 */
export const TOOL_HEAVY_TASK: RealTask = {
  id: 'tool-heavy-manifest',
  kind: 'tool-heavy',
  brief:
    'We are building a small data pipeline. I will state the field definitions, then you will '
    + 'generate the files.',
  context: [
    'Field `id` is an integer, required, and must be unique.',
    'Field `name` is a string, required, maximum length 64.',
    'Field `score` is a number between 0 and 100 inclusive.',
    'Field `tag` is a string, optional, and defaults to the literal string "none".',
    // THE REVISION.
    'CORRECTION: `score` is between 0 and 10 inclusive, not 0 and 100. Please use 10.',
    'Decision: the schema ships as `schema.json` and a sample row as `sample.json`.',
  ],
  work: [
    'Write `schema.json` describing all four fields exactly as specified, using the CORRECTED score range.',
    'Write `sample.json` with one valid row that satisfies every constraint.',
    'Write `validate.js` that reads both files, checks the sample against the schema, and prints '
    + '`VALID` or the specific violation. Run it with run_node.',
    'List the files you created and report the validator output.',
  ],
  quality: [
    {
      id: 'schema-exists',
      detail: 'schema.json was written',
      passed: ({ files }) => files.includes('schema.json'),
    },
    {
      id: 'sample-exists',
      detail: 'sample.json was written',
      passed: ({ files }) => files.includes('sample.json'),
    },
    {
      id: 'validator-exists',
      detail: 'validate.js was written',
      passed: ({ files }) => files.includes('validate.js'),
    },
    {
      id: 'all-fields-present',
      detail: 'all four fields appear in the schema',
      passed: async ({ read }) => {
        const raw = await read('schema.json')
        if (raw === undefined) return false
        return ['id', 'name', 'score', 'tag'].every(field => raw.includes(field))
      },
    },
  ],
  steadiness: [
    {
      id: 'constraint-retained',
      question: 'the field set declared at the start is the one described',
      holds: async ({ read }) => {
        const raw = await read('schema.json')
        if (raw === undefined) return false
        return ['id', 'name', 'score', 'tag'].every(field => raw.includes(field))
      },
    },
    {
      id: 'revision-honoured',
      question: 'the CORRECTED score range (max 10) is the one used',
      holds: async ({ read }) => {
        const raw = await read('schema.json')
        return raw !== undefined && /\b10\b/u.test(raw)
      },
    },
    {
      id: 'no-resurrection',
      question: 'the superseded score range (100) did not come back',
      holds: async ({ read }) => {
        const raw = await read('schema.json')
        return raw !== undefined && !/\b100\b/u.test(raw)
      },
    },
    {
      id: 'interface-honoured',
      question: 'the declared artifact paths are the ones used',
      holds: ({ files }) => files.includes('schema.json') && files.includes('sample.json'),
    },
  ],
}

/** Every task, in the order a run should execute them. */
export const REAL_TASKS: readonly RealTask[] = [CODING_TASK, RESEARCH_TASK, TOOL_HEAVY_TASK]
