import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
const root = process.env.R33_WORKSPACE
const checks = []
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }) }
  catch (error) { checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }) }
}

let validate
try { validate = await import(pathToFileURL(join(root, "src/validate.mjs")).href) } catch (error) { checks.push({ name: 'module-load:src/validate.mjs', pass: false, detail: String(error?.message ?? error) }) }
await check('rule.1-no-id', () => assert.equal(validate.validateRow({ name: 'a', amount: 1, currency: 'USD' }).ok, false))
await check('rule.2-no-name', () => assert.equal(validate.validateRow({ id: 1, amount: 1, currency: 'USD' }).ok, false))
await check('rule.3-id-range', () => assert.equal(validate.validateRow({ id: 0, name: 'a', amount: 1, currency: 'USD' }).ok, false))
await check('rule.4-name-length', () => assert.equal(validate.validateRow({ id: 1, name: 'n'.repeat(41), amount: 1, currency: 'USD' }).ok, false))
await check('rule.5-trim', () => assert.equal(validate.validateRow({ id: 1, name: '  a  ', amount: 1, currency: 'USD' }).row.name, 'a'))
await check('rule.6-default-status', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1, currency: 'USD' }).row.status, 'new'))
await check('rule.7-tombstone', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1, currency: 'USD', status: 'deleted', tombstone: false }).ok, false))
await check('rule.8-negative-amount', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: -1, currency: 'USD' }).ok, false))
await check('rule.9-round-amount', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1.239, currency: 'USD' }).row.amount, 1.24))
await check('rule.10-uppercase-currency', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1, currency: 'usd' }).row.currency, 'USD'))
await check('rule.11-known-currency', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1, currency: 'GBP' }).ok, false))
await check('rule.12-empty-currency', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1, currency: '' }).ok, false))
await check('rule.13-amount-max', () => assert.equal(validate.validateRow({ id: 1, name: 'a', amount: 1000001, currency: 'USD' }).ok, false))
console.log('R33_RESULT ' + JSON.stringify({ checks }))
process.exit(checks.every((entry) => entry.pass) ? 0 : 1)
