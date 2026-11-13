/**
 * R1 report: READ-ONLY verification, with an explicit generation entry point.
 *
 * ## What changed in EF-C1, and why
 *
 * Through EF-C0 this file was a generator that ran inside the default suite and
 * ended by writing `docs/12_R1_EVALUATION_REPORT.md` and `docs/MANIFEST.json`.
 * Measured on a clean checkout, `npx vitest run tests/r1-report.spec.ts`
 * rewrote both tracked files. A test that mutates the record it is meant to
 * verify cannot certify anything.
 *
 * The measurement moved to `eval/r1-report/report.ts`. This file now:
 *
 *   default       measure, assert the invariants, compare with the committed
 *                 report, write NOTHING.
 *   generate      `EF_R1_REPORT_MODE=generate EF_R1_REPORT_OUT=<dir>` writes the
 *                 candidate report to `<dir>`.
 *   write         `EF_R1_REPORT_MODE=write` promotes the report in place. It is
 *                 the explicit promote operation and is never used by the
 *                 default suite or by EF-C1.
 *
 * ## Why a drift is allowed to exist, and why it cannot be silent
 *
 * The committed report is historical. Regenerating it with today's code does
 * not reproduce it: the attribution model gained a `checkpoint-root` bucket
 * after the report was written. Hand-editing the numbers to match would be
 * falsifying the record, and rewriting the file would destroy it.
 *
 * So the rule is: the committed bytes are frozen, and any difference between
 * them and the current generator must be DECLARED in
 * `docs/convergence/data/report-baselines.json` with its cause and the observed
 * digest. A code change that moves the numbers again fails this test until the
 * declaration is updated — the drift can never be silent.
 *
 * @module tests/r1-report
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertR1Invariants, measureR1Matrix, renderR1Report } from '../eval/r1-report/report.ts'

const ROOT = join(import.meta.dirname, '..')
const REPORT = join(ROOT, 'docs', '12_R1_EVALUATION_REPORT.md')
const BASELINES = join(ROOT, 'docs', 'convergence', 'data', 'report-baselines.json')

const MODE = process.env['EF_R1_REPORT_MODE'] ?? 'verify'
const OUT = process.env['EF_R1_REPORT_OUT']
const RESULT = process.env['EF_R1_REPORT_RESULT']

interface ReportBaseline {
  readonly id: string
  readonly path: string
  readonly frozenSha256: string
  readonly status: 'current' | 'stale' | 'superseded'
  readonly observedSha256: string
  readonly cause: string
}

interface BaselineRegistry {
  readonly reports: readonly ReportBaseline[]
}

const normalize = (text: string): string => text.replace(/\r\n/gu, '\n')
const sha256 = (text: string): string => createHash('sha256').update(normalize(text)).digest('hex')

describe('R1 report', () => {
  it('measures the matrix, satisfies the invariants, and never writes the repository in verify mode', async () => {
    const rows = await measureR1Matrix()
    assertR1Invariants(rows)
    const rendered = renderR1Report(rows)
    expect(rendered).toContain('R1 Evaluation Report')

    if (MODE === 'generate' || MODE === 'write') {
      const directory = OUT ?? join(ROOT, 'eval', 'r1-report', 'out')
      const target = MODE === 'write' ? REPORT : join(directory, '12_R1_EVALUATION_REPORT.md')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rendered, 'utf8')
      if (RESULT !== undefined) {
        writeFileSync(RESULT, `${JSON.stringify({
          status: 'generated', mode: MODE, target, sha256: sha256(rendered),
        }, null, 2)}\n`, 'utf8')
      }
      return
    }

    const committed = readFileSync(REPORT, 'utf8')
    const status = normalize(committed) === rendered ? 'current' : 'stale'
    const generatedSha256 = sha256(rendered)
    if (RESULT !== undefined) {
      writeFileSync(RESULT, `${JSON.stringify({
        status, committedSha256: sha256(committed), generatedSha256,
      }, null, 2)}\n`, 'utf8')
    }

    const registry = JSON.parse(readFileSync(BASELINES, 'utf8')) as BaselineRegistry
    const entry = registry.reports.find(row => row.id === 'r1-report')
    expect(entry, 'the R1 report must be declared in report-baselines.json').toBeDefined()

    // 1. The committed report is frozen: an edit that is not a promotion shows
    //    up here, whatever the current generator says.
    expect(sha256(committed), 'the committed R1 report changed without a baseline update').toBe(entry!.frozenSha256)

    // 2. The generator's current output is either the committed bytes, or a
    //    declared drift with a cause and a pinned digest.
    if (status === 'current') {
      expect(entry!.status, 'the report reproduces; the registry must say current').toBe('current')
    } else {
      expect(entry!.status, 'the report does not reproduce; the drift must be declared').toBe('stale')
      expect(entry!.observedSha256, 'the declared drift digest must match the generator').toBe(generatedSha256)
      expect(entry!.cause.length, 'a declared drift needs a cause').toBeGreaterThan(0)
    }
  }, 600_000)
})
