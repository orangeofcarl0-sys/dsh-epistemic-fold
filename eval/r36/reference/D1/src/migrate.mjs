export function migrate(rows) {
  return rows.map(row => ({ id: row.id, value: row.value, migrated: true }))
}
