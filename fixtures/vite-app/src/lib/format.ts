/** More branches than the logic limit allows: the starter rule breaks here, so it starts as a warning. */
export function formatAmount(amount: number, currency = 'EUR', compact = false): string {
  if (Number.isNaN(amount)) return '–'
  if (amount === 0) return '0'
  let sign = ''
  if (amount < 0) sign = '-'
  const abs = Math.abs(amount)
  let text: string
  if (compact && abs >= 1e9) text = `${(abs / 1e9).toFixed(1)}B`
  else if (compact && abs >= 1e6) text = `${(abs / 1e6).toFixed(1)}M`
  else if (compact && abs >= 1e3) text = `${(abs / 1e3).toFixed(1)}k`
  else text = abs.toFixed(2)
  if (currency === 'EUR') return `${sign}${text} €`
  if (currency === 'USD') return `${sign}$${text}`
  return `${sign}${text} ${currency}`
}
