import test from 'node:test'
import assert from 'node:assert/strict'
import { timeoutFor } from '../src/config.mjs'

test('experiment timeout stays 60', () => {
  assert.equal(timeoutFor('experiment'), 60)
})
