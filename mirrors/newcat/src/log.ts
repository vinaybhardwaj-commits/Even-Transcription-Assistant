import { sha256 } from './hash.js'

const ALLOWED = new Set([
  'status',
  'capability',
  'job_id',
  'trace_id',
  'http_status',
  'error_type',
  'credential_source',
  'auth_mode',
  'region',
  'model_id',
  'note_id_hash',
  'duration_ms',
  'path',
  'method',
  'role',
  'agent_id',
  'swept',
  'downgrade',
])

/** Note identifiers are hashed before they are written. Bodies, refs, and secrets are dropped. */
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields),
  })
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

export function noteIdHash(id: string): string {
  return sha256(id).slice(0, 16)
}

export function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'note_id' || key === 'note_version_id' || key === 'source_uid') {
      if (typeof value === 'string' && value.length > 0) out.note_id_hash = noteIdHash(value)
      continue
    }
    if (!ALLOWED.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    }
  }
  return out
}
