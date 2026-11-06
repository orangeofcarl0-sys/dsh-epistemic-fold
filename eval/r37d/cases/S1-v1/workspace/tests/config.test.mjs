import test from 'node:test'
import assert from 'node:assert/strict'
import { checkoutTimeout } from '../src/config.mjs'

test('checkout timeout is a positive integer', () => {
  const timeout = checkoutTimeout()
  assert.equal(typeof timeout, 'number')
  assert.ok(Number.isInteger(timeout))
  assert.ok(timeout > 0)
})
