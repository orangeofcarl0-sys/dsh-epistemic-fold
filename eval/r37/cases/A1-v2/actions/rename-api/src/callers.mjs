import { loadConfig } from './config.mjs'

export function runCallers(loader = loadConfig) {
  return loader({ path: 'config.json' })
}
