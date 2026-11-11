#!/usr/bin/env node
/**
 * EF-R4 WP2 contract — the evidence-graph decisions are a table, not prose.
 *
 *   node eval/r4/contracts/evidence-graph-contract.mjs
 *
 * The fixtures prove the six outcomes the R4 report uses: visible, marker-only,
 * equivalent-inferred, invisible-after-fold, no-following-request and
 * localization failure.
 *
 * @module eval/r4/contracts/evidence-graph-contract
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  evidenceKeyOf,
  markerOnly,
  mislocalizedOf,
  quoteCandidates,
  visibilityOf,
} from '../evidence-graph.mjs'

const OUT = new URL('../out/', import.meta.url)

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  process.stdout.write(`  ok ${name}\n`)
}

const marker = '[EF1 L cp:11111111-1111-4111-8111-111111111111]'
const rationale = `${marker}

Rationale
- Historical baseline: failed=3
- The config revision on 2026-10-14 is concurrency=6.`

check('an exact recall key includes checkpoint, offset and first message id', () => {
  const key = evidenceKeyOf('context_recall', {
    checkpointId: 'cp-1',
    depth: 'exact',
    page: { offset: 2, messages: [{ id: 'm-1' }, { id: 'm-2' }] },
  })
  assert.equal(key, 'cp:cp-1#exact:2#m-1:2')
})

check('a search key uses the query from the call args when the result omits it', () => {
  const key = evidenceKeyOf('context_search', { hits: [] }, { query: 'failed=3' })
  assert.equal(key, 'search:failed=3#no-hit')
})

check('a marker-only checkpoint is recognized', () => {
  assert.equal(markerOnly(marker), true)
  assert.equal(markerOnly(rationale), false)
  assert.equal(markerOnly('plain text'), false)
})

check('visible evidence is verified, not inferred', () => {
  assert.equal(visibilityOf({
    folded: true,
    delivered: true,
    visible: true,
    checkpointText: rationale,
    equivalent: false,
  }), 'visible')
})

check('a marker-only replacement is marker-only', () => {
  assert.equal(visibilityOf({
    folded: true,
    delivered: true,
    visible: false,
    checkpointText: marker,
    equivalent: false,
  }), 'marker-only')
})

check('an exact quote in the checkpoint is equivalent-inferred', () => {
  assert.equal(visibilityOf({
    folded: true,
    delivered: true,
    visible: false,
    checkpointText: rationale,
    equivalent: true,
  }), 'equivalent-inferred')
})

check('a shadowed payload with an unrelated checkpoint is invisible-after-fold', () => {
  assert.equal(visibilityOf({
    folded: true,
    delivered: true,
    visible: false,
    checkpointText: rationale,
    equivalent: false,
  }), 'invisible-after-fold')
})

check('no following request is not a negative visibility result', () => {
  assert.equal(visibilityOf({
    folded: true,
    delivered: false,
    visible: false,
    checkpointText: null,
    equivalent: false,
  }), 'no-following-request')
})

check('an unshadowed absent payload is absent', () => {
  assert.equal(visibilityOf({
    folded: false,
    delivered: true,
    visible: false,
    checkpointText: null,
    equivalent: false,
  }), 'absent')
})

check('localization failure covers parse errors, unavailable archives and empty pages', () => {
  assert.equal(mislocalizedOf('context_recall', null, 'bad json'), true)
  assert.equal(mislocalizedOf('context_recall', { unavailable: 'bundle not found' }, null), true)
  assert.equal(mislocalizedOf('context_recall', { depth: 'exact', page: { messages: [] } }, null), true)
  assert.equal(mislocalizedOf('context_search', { outcome: 'no-archive' }, null), true)
  assert.equal(mislocalizedOf('context_recall', { depth: 'exact', page: { messages: [{ id: 'm' }] } }, null), false)
})

check('quote candidates are bounded and require a distinctive token', () => {
  const candidates = quoteCandidates('', {
    page: {
      messages: [{
        id: 'm',
        content: [{
          type: 'text',
          text: 'Historical baseline: failed=3\nshort\n2026-10-14 concurrency=6\n',
        }],
      }],
    },
  })
  assert.ok(candidates.includes('Historical baseline: failed=3'))
  assert.ok(candidates.includes('2026-10-14 concurrency=6'))
  assert.ok(!candidates.includes('short'))
})

process.stdout.write(`evidence-graph-contract: ${checks}/${checks} pass\n`)
mkdirSync(OUT, { recursive: true })
writeFileSync(new URL('evidence-graph-contract.json', OUT), `${JSON.stringify({
  schemaVersion: 1,
  work: 'EF-R4 WP2 evidence graph contract',
  generatedAt: new Date().toISOString(),
  checks,
  passed: checks,
  failures: 0,
}, null, 2)}\n`)
