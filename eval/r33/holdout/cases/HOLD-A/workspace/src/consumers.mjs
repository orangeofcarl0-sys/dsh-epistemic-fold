import { readSettings } from './settings.mjs'

export function runConsumers() {
  return readSettings('config').name
}
