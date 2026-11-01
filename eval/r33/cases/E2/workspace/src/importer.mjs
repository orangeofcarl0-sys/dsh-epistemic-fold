export function importRows(rows, options = {}) {
  return { schemaVersion: options.schemaVersion ?? 'unknown', rows: rows.map(row => ({ ...row })) }
}
