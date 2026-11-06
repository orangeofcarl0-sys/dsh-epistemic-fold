import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultRegion } from '../src/client.mjs'

test('region is a configured production region', () => {
  const region = defaultRegion()
  assert.equal(typeof region, 'string')
  assert.notEqual(region, 'us-east-1', 'the stale default must not be shipped')
  assert.match(region, /^[a-z]{2}-[a-z]+-\d$/)
})
