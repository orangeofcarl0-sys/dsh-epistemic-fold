import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRow } from '../src/validate.mjs'

test('applies the basic row rules', () => {
  assert.equal(validateRow({ name: 'a', amount: 1, currency: 'USD' }).ok, false)
  assert.equal(validateRow({ id: 1, amount: 1, currency: 'USD' }).ok, false)
  assert.equal(validateRow({ id: 1, name: 'a', amount: 1, currency: 'USD' }).row.status, 'new')
})
