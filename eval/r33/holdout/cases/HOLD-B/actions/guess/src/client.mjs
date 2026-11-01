export function createClient() {
  return { ttlMs: 30_000, transport: 'polling' }
}
