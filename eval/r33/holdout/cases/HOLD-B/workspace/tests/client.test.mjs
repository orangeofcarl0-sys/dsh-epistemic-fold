import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '../src/client.mjs'

test('the client has a usable shape', () => {
  const client = createClient()
  assert.equal(typeof client.ttlMs, 'number')
  assert.ok(client.ttlMs > 0, 'ttlMs must be a positive value')
  assert.equal(typeof client.transport, 'string')
  assert.ok(client.transport.length > 0, 'transport must be named')
})
