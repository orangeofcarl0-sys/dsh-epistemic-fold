import { loadConfig } from './config.mjs'

export function runCallers(loader = loadConfig) {
  return loader('config.json')
}
