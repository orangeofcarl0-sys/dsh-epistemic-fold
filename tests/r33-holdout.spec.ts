/**
 * The separately frozen holdout must be a valid, sensitive instrument.
 *
 * It is NOT part of the v2 development digest. It was authored after the v2
 * instrument was frozen, so it cannot be used to tune the development cases;
 * its only purpose is a future blind run. These tests prove it is frozen and
 * that its hidden checkers distinguish the correct action from the wrong one.
 *
 * @module tests/r33-holdout
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { makeTemp } from '../eval/tmp.ts'
import {
  HOLDOUT_ID,
  loadDataset,
  loadHoldoutDataset,
  verifyFrozen,
  verifyHoldout,
} from '../eval/r33/src/dataset.mjs'
import { applyAction, materialize, runChecker } from '../eval/r33/src/workspace.mjs'

describe('R34 frozen holdout', () => {
  it('is frozen under its own id and does not disturb the v2 digest', async () => {
    const frozen = await verifyHoldout()
    expect(frozen.ok, frozen.reason).toBe(true)
    expect(frozen.manifest.datasetId).toBe(HOLDOUT_ID)
    expect(frozen.manifest.caseCount).toBe(2)
    const holdout = await loadHoldoutDataset()
    expect(holdout.errors).toEqual([])
    expect(holdout.cases.map(entry => entry.id).sort()).toEqual(['HOLD-A', 'HOLD-B'])
    expect(holdout.datasetDigest).toBe(frozen.datasetDigest)

    const development = await verifyFrozen()
    expect(development.ok, development.reason).toBe(true)
    expect(development.manifest.datasetId).toBe('r33-semantic-continuity-v2')
    const dev = await loadDataset()
    expect(dev.cases.map(entry => entry.id)).not.toContain('HOLD-A')
  })

  it('binds every gold quote and keeps the holdout free of workspace leaks', async () => {
    const { cases } = await loadHoldoutDataset()
    for (const entry of cases) {
      const transcript = entry.transcript.map((message: { text: string }) => message.text).join('\n')
      const workspace = Object.values(entry.workspace.files).join('\n')
      for (const fact of entry.gold) {
        expect(transcript.includes(fact.quote), `${entry.id} ${fact.factId} quote`).toBe(true)
        for (const ref of fact.sourceRefs) {
          expect(entry.transcript[ref].text.includes(fact.quote), `${entry.id} ref ${ref}`).toBe(true)
        }
        expect(workspace.includes(fact.quote), `${entry.id} leaks quote`).toBe(false)
        expect(workspace.includes(fact.visibleNeedle), `${entry.id} leaks needle`).toBe(false)
      }
      expect(entry.requiresTests).toBe(true)
    }
  })

  it('passes the correct action and fails the wrong one', async () => {
    const { cases } = await loadHoldoutDataset()
    const byId = new Map(cases.map(entry => [entry.id, entry]))
    const correct = new Map([
      ['HOLD-A', 'keep-string'],
      ['HOLD-B', 'use-artifact'],
    ])
    const wrong = new Map([
      ['HOLD-A', 'remove-string'],
      ['HOLD-B', 'guess'],
    ])
    for (const [id, correctAction] of correct) {
      const caseData = byId.get(id)!
      const goodRoot = join(await makeTemp('ef-holdout-good-'), 'workspace')
      await materialize(caseData.workspace.files, goodRoot)
      await applyAction(caseData.actions[correctAction], goodRoot)
      const good = await runChecker(caseData, goodRoot)
      expect(good.status, `${id} correct checker status`).toBe('executed')
      expect(good.checks.every((check: { pass: boolean }) => check.pass), `${id} correct action`).toBe(true)

      const badRoot = join(await makeTemp('ef-holdout-bad-'), 'workspace')
      await materialize(caseData.workspace.files, badRoot)
      await applyAction(caseData.actions[wrong.get(id)!], badRoot)
      const bad = await runChecker(caseData, badRoot)
      expect(bad.status, `${id} wrong checker status`).toBe('executed')
      expect(bad.checks.some((check: { pass: boolean }) => !check.pass), `${id} wrong action`).toBe(true)
    }
  })
})
