export function watchChanges({ fs, dir, onEvent }) {
  const watcher = fs.watch(dir, event => onEvent(event))
  return { close: () => watcher.close?.() }
}
