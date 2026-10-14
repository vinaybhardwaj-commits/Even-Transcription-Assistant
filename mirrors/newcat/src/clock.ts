/** IST is UTC+05:30 and has no daylight saving. Clinical dates use that offset, not the host zone. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

export function clinicalDateIst(utc: Date): string {
  const shifted = new Date(utc.getTime() + IST_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
