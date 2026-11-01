export function migrate(rows) {
  return rows.map(row => ({ ...row, migrated: true }))
}
