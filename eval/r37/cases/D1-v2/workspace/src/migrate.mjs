export function migrate(rows) {
  return rows.map(row => ({ value: row.value, migrated: true }))
}
