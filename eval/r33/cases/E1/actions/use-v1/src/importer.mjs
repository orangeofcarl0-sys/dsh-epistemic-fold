export function importRows(rows, options = {}) {
  return { schemaVersion: options.schemaVersion ?? 'schema-v1', rows: rows.map(row => ({ ...row })) }
}
