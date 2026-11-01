/**
 * R31-D1: process-level restart on the real DSH JSONL host.
 *
 * Each `it` spawns TWO Node processes. Process A mounts the real runtime +
 * JSONL backend, creates a stored session, performs a real Basic compaction
 * through the EF engine, activates a semantic packet, flushes through
 * `session/flush`, closes the handle, and exits. Process B is a separate OS
 * process: it opens the same artifact, reconstructs the Session from the
 * stored events, re-proves the journal, folds again, and calls the real
 * `context_recall` tool.
 *
 * The second test injects a receipt-write failure in process A, so the session
 * commits while the journal's decision is missing. Process B must recover that
 * commit from the log — not from the journal's claim.
 *
 * @module tests/semantic-process-restart
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTemp } from '../eval/tmp.ts'

const ROOT = join(import.meta.dirname, '..')
const HOST = join(ROOT, 'eval', 'r31', 'lifecycle-host.mjs')

interface WriteOutcome {
  readonly sessionSeq: number
  readonly body: string
  readonly diagnostics: { readonly health: string; readonly committed: number }
  readonly journal: {
    readonly packets: readonly { readonly checkpointId: string; readonly status: string }[]
    readonly receipts: readonly {
      readonly outcome: string
      readonly replacementSeq?: number
      readonly commitOrder?: number
    }[]
  }
}

interface ReadOutcome {
  readonly replayedEvents: number
  readonly reconcile: {
    readonly scanned: number
    readonly activated: number
    readonly unrepairable: number
    readonly health: string
  }
  readonly diagnosticsBefore: { readonly health: string }
  readonly diagnosticsAfter: { readonly health: string }
  readonly body: string
  readonly surfaceNodes: readonly number[]
  readonly journal: WriteOutcome['journal']
  readonly recall: {
    readonly isError?: boolean
    readonly content?: readonly { readonly type: string; readonly text?: string }[]
  }
}

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await makeTemp('ef-r31-process-')
  roots.push(root)
  return root
}

function run(mode: 'write' | 'read', root: string, id: string, env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [HOST, mode, root, id], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 90_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `lifecycle-host ${mode} failed (exit ${String(result.status)}):\n`
      + `${result.stdout}\n${result.stderr}`,
    )
  }
}

async function outcome<T>(root: string, mode: 'write' | 'read'): Promise<T> {
  return JSON.parse(await readFile(join(root, `outcome-${mode}.json`), 'utf8')) as T
}

beforeAll(() => {
  // The child processes load `lib/`, the same artifact a DSH install loads.
  // Do NOT rebuild here: another suite (rc3 packaging) reads `lib/` in
  // parallel, and a build deletes/recreates the directory. Running the
  // read-only preflight verifies the artifact is present and current; the
  // repository's own contract is `npm run build` before the full suite.
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'preflight-lib.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  })
}, 120_000)

afterAll(async () => {
  void roots
})

describe('R31-D1: real JSONL process restart', () => {
  it('writes, flushes, exits, reopens, replays, folds again, and recalls exactly', async () => {
    const root = await tempRoot()
    const id = 'r31-process-clean'
    run('write', root, id)
    const first = await outcome<WriteOutcome>(root, 'write')
    expect(first.diagnostics.health).toBe('ready')
    expect(first.journal.receipts.map(receipt => receipt.outcome)).toEqual(['committed'])
    expect(first.journal.receipts[0]?.replacementSeq).toBe(first.sessionSeq - 2)

    run('read', root, id)
    const second = await outcome<ReadOutcome>(root, 'read')
    // The stored log replayed through JSONL; the session was not recreated
    // from an in-memory fixture.
    expect(second.replayedEvents).toBe(first.sessionSeq)
    expect(second.reconcile.scanned).toBe(1)
    expect(second.reconcile.health).toBe('ready')
    expect(second.diagnosticsBefore.health).toBe('ready')
    expect(second.diagnosticsAfter.health).toBe('ready')

    // The first fold's committed state is carried into the second fold after a
    // process restart, and the first checkpoint's proof is still valid.
    expect(second.body).toContain('The timeout is 30 seconds.')
    expect(second.body).toContain('State from earlier folds')
    expect(second.journal.receipts.filter(receipt => receipt.outcome === 'committed')).toHaveLength(2)
    expect(second.journal.receipts.map(receipt => receipt.commitOrder).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([15, 26])

    // Exact recall through the real ToolRuntime after the restart.
    const text = (second.recall.content ?? []).map(block => block.text ?? '').join('\n')
    expect(second.recall.isError).toBe(false)
    expect(text).toContain('Task phase 1')
  }, 120_000)

  it('recovers a committed session whose receipt was never written', async () => {
    const root = await tempRoot()
    const id = 'r31-process-crash'
    run('write', root, id, { EF_NO_RECEIPT: '1' })

    // The crash face is real on disk: the session committed, the packet is
    // prepared, and no decision exists.
    const files = await readdir(join(root, 'semantic', id))
    expect(files.filter(file => file.endsWith('.receipt.json'))).toHaveLength(0)
    const first = await outcome<WriteOutcome>(root, 'write')
    expect(first.journal.packets).toHaveLength(1)
    expect(first.journal.receipts).toHaveLength(0)

    run('read', root, id)
    const second = await outcome<ReadOutcome>(root, 'read')
    // Recovered from the LOG's proof, not from a journal claim: this is the
    // `session committed / receipt missing` case, which must activate.
    expect(second.reconcile.activated).toBe(1)
    expect(second.reconcile.health).toBe('ready')
    expect(second.diagnosticsBefore.health).toBe('ready')
    expect(second.journal.receipts.filter(receipt => receipt.outcome === 'committed')).toHaveLength(2)
    expect(second.replayedEvents).toBe(first.sessionSeq)
    expect(second.body).toContain('The timeout is 30 seconds.')
  }, 120_000)
})
