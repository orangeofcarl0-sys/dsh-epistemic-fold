import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate } from '../src/migrate.mjs'

test('preserves the row id', () => {
  assert.equal(migrate([{ id: 1, value: 'a' }])[0].id, 1)
})
