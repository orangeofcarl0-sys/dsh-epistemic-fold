import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultRegion } from '../src/client.mjs'

test('region is a configured string', () => {
  assert.equal(typeof defaultRegion(), 'string')
})
