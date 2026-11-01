export function timeoutFor(branch) {
  return branch === 'release' ? 30 : 60
}
