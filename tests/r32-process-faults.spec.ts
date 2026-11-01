/**
 * R32-D1: real-process fault matrix on the DSH JSONL host.
 *
 * Each case runs the same two-process lifecycle as R31 and changes ONE durable
 * artifact between the processes. The second process must detect the
 * contradiction, refuse to write new semantic state, and still fold history with
 * an explicit degradation notice. No case is simulated with an in-memory
 * `Session.create()`.
 *
 * @module tests/r32-process-faults
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTemp } from '../eval/tmp.ts'

const ROOT = join(import.meta.dirname, '..')
const HOST = join(ROOT, 'eval', 'r31', 'lifecycle-host.mjs')

interface JournalView {
  readonly state: string
  readonly packets: readonly { readonly packetId: string; readonly checkpointId: string }[]
  readonly receipts: readonly {
    readonly packetId: string
    readonly outcome: string
    readonly replacementSeq?: number
    readonly commitOrder?: number
  }[]
  readonly legacy: number
  readonly orphans: readonly { readonly packetId: string; readonly file: string }[]
  readonly rejectedReceipts: readonly string[]
  readonly invalid: readonly { readonly file: string; readonly code?: string; readonly detail: string }[]
}

interface ReadOutcome {
  readonly replayedEvents: number
  readonly reconcile: { readonly health: string; readonly activated: number }
  readonly diagnosticsBefore: {
    readonly health: string
    readonly detail?: string
    readonly blockedNotice: boolean
  }
  readonly diagnosticsAfter: { readonly health: string }
  readonly body: string
  readonly journal: JournalView
  readonly storedHeader: {
    readonly isSeeded: boolean
    readonly parentSession?: string
    readonly inheritedEventCount: number
  }
}

interface WriteOutcome {
  readonly sessionSeq: number
  readonly journal: JournalView
}

interface ForkOutcome {
  readonly parent: string
  readonly child: string
  readonly boundary: number
  readonly inheritedEventCount: number
}

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await makeTemp('ef-r32-process-')
  roots.push(root)
  return root
}

function run(
  mode: 'write' | 'read' | 'fork',
  root: string,
  id: string,
  extra: readonly string[] = [],
  env: Record<string, string> = {},
): void {
  const result = spawnSync(process.execPath, [HOST, mode, root, id, ...extra], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 90_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `lifecycle-host ${mode} failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    )
  }
}

async function outcome<T>(root: string, mode: 'write' | 'read' | 'fork'): Promise<T> {
  return JSON.parse(await readFile(join(root, `outcome-${mode}.json`), 'utf8')) as T
}

async function journalFiles(root: string, id: string): Promise<string[]> {
  return (await readdir(join(root, 'semantic', id)).catch(() => [])).filter(file =>
    file.endsWith('.json'))
}

async function findStoredLog(root: string, id: string): Promise<string> {
  const sessions = join(root, 'sessions')
  const files = await readdir(sessions, { recursive: true, withFileTypes: true })
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.includes('session.')) continue
    const path = join(entry.parentPath, entry.name)
    if (previousSegment(path) === id) return path
  }
  throw new Error(`no stored log for ${id}`)
}

function previousSegment(path: string): string {
  const parts = path.replace(/\\/gu, '/').split('/')
  return parts[parts.length - 2] ?? ''
}

beforeAll(() => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'preflight-lib.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  })
}, 120_000)

afterAll(() => {
  void roots
})

describe('R32-D1: real-process corruption matrix', () => {
  it('refuses to activate a packet modified after its receipt', async () => {
    const root = await tempRoot()
    const id = 'r32-process-modified'
    run('write', root, id)
    const first = await outcome<WriteOutcome>(root, 'write')
    const packetFile = (await journalFiles(root, id)).find(file => !file.endsWith('.receipt.json'))
    if (packetFile === undefined) throw new Error('write produced no packet file')
    const path = join(root, 'semantic', id, packetFile)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { packet: Record<string, unknown> }
    await writeFile(path, JSON.stringify({
      ...parsed,
      packet: { ...parsed.packet, ops: [{ op: 'retire', anchorId: 'injected' }] },
    }, null, 2), 'utf8')

    run('read', root, id)
    const second = await outcome<ReadOutcome>(root, 'read')
    expect(first.journal.receipts).toHaveLength(1)
    expect(second.diagnosticsBefore.health).toBe('partial')
    expect(second.diagnosticsBefore.blockedNotice).toBe(true)
    expect(second.body).toContain('SEMANTIC STATE INCOMPLETE')
    expect(second.journal.invalid.some(issue => issue.code === 'ops-digest')).toBe(true)
    expect(second.journal.rejectedReceipts).toHaveLength(1)
    // The packet file remains, but it has NO accepted receipt: recovery must
    // not re-issue a decision for the modified operations, and the blocked fold
    // staged no new packet.
    expect(second.journal.packets).toHaveLength(1)
    expect(second.journal.receipts).toHaveLength(0)
    expect(second.reconcile.activated).toBe(0)
  }, 120_000)

  it('reports an orphan receipt instead of counting it as committed', async () => {
    const root = await tempRoot()
    const id = 'r32-process-orphan'
    run('write', root, id)
    const first = await outcome<WriteOutcome>(root, 'write')
    const packetId = first.journal.packets[0]?.packetId
    if (packetId === undefined) throw new Error('write produced no packet')
    await rm(join(root, 'semantic', id, `${packetId}.json`))

    run('read', root, id)
    const second = await outcome<ReadOutcome>(root, 'read')
    expect(second.journal.orphans).toHaveLength(1)
    expect(second.journal.orphans[0]?.packetId).toBe(packetId)
    expect(second.journal.packets).toHaveLength(0)
    expect(second.journal.invalid.some(issue => issue.code === 'orphan-receipt')).toBe(true)
    expect(second.diagnosticsBefore.health).toBe('partial')
    expect(second.diagnosticsBefore.blockedNotice).toBe(true)
  }, 120_000)

  it('reports a receipt whose proof no longer names the committed compaction', async () => {
    const root = await tempRoot()
    const id = 'r32-process-proof'
    run('write', root, id)
    const first = await outcome<WriteOutcome>(root, 'write')
    const receiptFile = (await journalFiles(root, id)).find(file => file.endsWith('.receipt.json'))
    if (receiptFile === undefined) throw new Error('write produced no receipt file')
    const path = join(root, 'semantic', id, receiptFile)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      receipt: { proof?: Record<string, unknown> }
    }
    if (parsed.receipt.proof === undefined) throw new Error('receipt carries no proof')
    await writeFile(path, JSON.stringify({
      ...parsed,
      receipt: {
        ...parsed.receipt,
        proof: { ...parsed.receipt.proof, compactionId: 'a-different-compaction' },
      },
    }, null, 2), 'utf8')

    run('read', root, id)
    const second = await outcome<ReadOutcome>(root, 'read')
    expect(first.journal.receipts).toHaveLength(1)
    expect(second.diagnosticsBefore.health).toBe('partial')
    expect(second.diagnosticsBefore.blockedNotice).toBe(true)
    expect(second.reconcile.activated).toBe(0)
    expect(second.body).toContain('SEMANTIC STATE INCOMPLETE')
  }, 120_000)

  it('refuses to re-grant a journal written against a newer log than the restored backup', async () => {
    const root = await tempRoot()
    const id = 'r32-process-older-log'
    run('write', root, id)
    const logPath = await findStoredLog(root, id)
    const backup = `${logPath}.backup`
    await copyFile(logPath, backup)

    // A second process commits a second fold and its receipt.
    run('read', root, id)
    const newer = await outcome<ReadOutcome>(root, 'read')
    expect(newer.journal.receipts.filter(receipt => receipt.outcome === 'committed')).toHaveLength(2)

    // Restore the OLDER log while keeping the newer journal: the journal now
    // describes a future this log never contained.
    await copyFile(backup, logPath)
    run('read', root, id)
    const restored = await outcome<ReadOutcome>(root, 'read')
    expect(restored.diagnosticsBefore.health).toBe('partial')
    expect(restored.diagnosticsBefore.blockedNotice).toBe(true)
    expect(restored.body).toContain('SEMANTIC STATE INCOMPLETE')
    // Neither committed receipt was re-granted onto the older history.
    expect(restored.reconcile.activated).toBe(0)
  }, 180_000)

  it('resumes a partial fork inheritance across a real process boundary', async () => {
    const root = await tempRoot()
    const parentId = 'r32-process-parent'
    const childId = 'r32-process-child'
    run('write', root, parentId)
    run('read', root, parentId)
    const parent = await outcome<ReadOutcome>(root, 'read')
    expect(parent.journal.receipts.filter(receipt => receipt.outcome === 'committed')).toHaveLength(2)

    run('fork', root, parentId, [childId])
    const forks = await outcome<ForkOutcome>(root, 'fork')
    expect(forks.inheritedEventCount).toBeGreaterThan(0)

    // The first child process inherits both parent commits and folds once.
    run('read', root, childId)
    const firstChild = await outcome<ReadOutcome>(root, 'read')
    expect(firstChild.storedHeader.isSeeded).toBe(true)
    expect(firstChild.storedHeader.parentSession).toBe(parentId)
    const inheritedBefore = firstChild.journal.receipts.filter(receipt =>
      (receipt.commitOrder ?? Infinity) < forks.inheritedEventCount)
    expect(inheritedBefore.length).toBeGreaterThan(0)

    // Simulate a crash that lost ONE inherited packet and receipt.
    const lost = inheritedBefore[0]!
    await rm(join(root, 'semantic', childId, `${lost.packetId}.json`))
    await rm(join(root, 'semantic', childId, `${lost.packetId}.receipt.json`))

    run('read', root, childId)
    const repaired = await outcome<ReadOutcome>(root, 'read')
    expect(repaired.diagnosticsBefore.health).toBe('ready')
    const restored = repaired.journal.receipts.find(receipt => receipt.packetId === lost.packetId)
    expect(restored?.outcome).toBe('committed')
    // The repaired row is unique, not duplicated by the second pass.
    expect(repaired.journal.receipts.filter(receipt => receipt.packetId === lost.packetId))
      .toHaveLength(1)
  }, 240_000)
})
