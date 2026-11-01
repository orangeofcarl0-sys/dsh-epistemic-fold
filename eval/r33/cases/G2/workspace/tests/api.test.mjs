import test from 'node:test'
import assert from 'node:assert/strict'
import { publicApi } from '../src/api.mjs'

test('v2 is present', () => {
  assert.equal(publicApi().v2, 2)
})
