import test from 'node:test'
import assert from 'node:assert/strict'
import { importRows } from '../src/importer.mjs'

test('returns a known schema version and preserves rows', () => {
  const result = importRows([{ id: 1 }])
  assert.notEqual(result.schemaVersion, 'unknown')
  assert.equal(result.rows.length, 1)
})
