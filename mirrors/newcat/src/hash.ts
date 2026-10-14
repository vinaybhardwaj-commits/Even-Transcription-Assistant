import { createHash } from 'node:crypto'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const child = record[key]
      if (child !== undefined) out[key] = sortValue(child)
    }
    return out
  }
  return value
}

/** Hash of the audit projection. Source time is not part of the key, so a re-date is the same version. */
export function contentHash(body: string, structured: unknown): string {
  return sha256(
    stableStringify({
      body: normalizeBody(body),
      structured: structured ?? {},
    }),
  )
}
