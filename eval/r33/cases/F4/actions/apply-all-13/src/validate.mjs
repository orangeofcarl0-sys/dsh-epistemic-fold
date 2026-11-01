export function validateRow(input) {
  const errors = []
  const row = { ...input }
  if (row.id === undefined || row.id === null) errors.push('id')
  if (row.name === undefined || row.name === null) errors.push('name')
  if (typeof row.id === 'number' && row.id < 1) errors.push('id-range')
  if (typeof row.name === 'string' && row.name.length > 40) errors.push('name-length')
  if (typeof row.name === 'string') row.name = row.name.trim()
  if (row.status === undefined) row.status = 'new'
  if (row.status === 'deleted' && row.tombstone !== true) errors.push('tombstone')
  if (typeof row.amount === 'number' && row.amount < 0) errors.push('amount-negative')
  if (typeof row.amount === 'number') row.amount = Math.round(row.amount * 100) / 100
  if (typeof row.currency === 'string') row.currency = row.currency.toUpperCase()
  if (row.currency !== undefined && !['USD', 'EUR'].includes(row.currency)) errors.push('currency')
  if (row.currency === '') errors.push('currency-empty')
  if (typeof row.amount === 'number' && row.amount > 1000000) errors.push('amount-max')
  return { ok: errors.length === 0, errors, row }
}
