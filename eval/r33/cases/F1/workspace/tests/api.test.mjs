import test from 'node:test'
import assert from 'node:assert/strict'
import { publicApi } from '../src/api.mjs'

test('public API keeps version 1', () => {
  assert.equal(publicApi().version, 1)
})
