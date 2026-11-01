export function importRows(rows, options = {}) {
  return { schemaVersion: options.schemaVersion ?? 'schema-v2', rows: rows.map(row => ({ ...row })) }
}
