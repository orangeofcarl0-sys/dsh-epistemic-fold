export function createClient() {
  return { ttlMs: 45_000, transport: 'polling' }
}
