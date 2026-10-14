import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { isOpaqueId } from '../../../audience/serialize.js'
import { ConsultAuditInput, RoleSchema } from '../input.js'

/**
 * Reads the S6 JSONL (one consult per line, shape in S6-DATA-REQUEST) and maps each line to the agent input.
 * A rejected line is counted by a fixed reason code and skipped. No reason, log line or count ever carries text,
 * an id or a zod message from the line.
 */

export const REJECT_REASONS = ['empty_line', 'bad_json', 'bad_shape', 'bad_id', 'bad_time', 'duplicate_encounter_id'] as const
export type RejectReason = (typeof REJECT_REASONS)[number]

// A turn may end this long after the window end (clock skew between the cutter and the transcript) and still be accepted.
export const WINDOW_SLACK_SECONDS = 5

export const SOURCES = ['cutter', 'caa'] as const
export type ConsultSource = (typeof SOURCES)[number]

const Time = z.union([z.string(), z.number().finite()])

// Not strict on purpose: the real file may carry extra fields (names, urls). Only the fields named here are copied.
const LineTurn = z.object({
  turn_id: z.string(),
  role: RoleSchema,
  t0: z.number().finite(),
  t1: z.number().finite(),
  text_en: z.string(),
  text_native: z.string().nullable().optional(),
  lang: z.string().optional(),
})

const Line = z.object({
  encounter_id: z.string(),
  doctor_uid: z.string().nullable(),
  room: z.string(),
  window: z.object({ t0: Time, t1: Time, complete: z.boolean() }),
  turns: z.array(LineTurn),
  rx: z
    .object({
      presc_uid: z.string().nullable().optional(),
      requires_surgery: z.boolean().nullable(),
      procedure_text: z.string().nullable(),
      match_confidence: z.enum(['exact', 'window']),
    })
    .nullable(),
  source: z.enum(SOURCES),
})

export type MatchConfidence = 'exact' | 'window' | 'none'

export interface LoadedConsult {
  /** 1-based line number in the file. */
  line: number
  input: ConsultAuditInput
  source: ConsultSource
  match_confidence: MatchConfidence
  window_complete: boolean
}

export type ParseResult = { ok: true; consult: Omit<LoadedConsult, 'line'> } | { ok: false; reason: RejectReason }

/** Wall-clock seconds from an ISO string or a number of epoch seconds or milliseconds. Null when unusable. */
export function toEpochSeconds(value: string | number): number | null {
  const n = typeof value === 'number' ? value : Date.parse(value) / 1000
  if (!Number.isFinite(n)) return null
  const seconds = typeof value === 'number' && n >= 1e11 ? n / 1000 : n
  return seconds >= 1e9 ? seconds : null
}

const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString()

/**
 * Turn times are seconds from window start. A time >= 1e9 can only be wall-clock (epoch seconds, or ms from 1e11) and is
 * made relative to the window start; anything smaller is already relative.
 */
function relativeTime(value: number, startSeconds: number): number {
  if (value < 1e9) return value
  return (value >= 1e11 ? value / 1000 : value) - startSeconds
}

export function parseConsultLine(raw: string): ParseResult {
  if (raw.trim() === '') return { ok: false, reason: 'empty_line' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
  const line = Line.safeParse(json)
  if (!line.success) return { ok: false, reason: 'bad_shape' }
  const l = line.data
  if (l.encounter_id.length === 0 || !isOpaqueId(l.encounter_id)) return { ok: false, reason: 'bad_id' }
  if (l.doctor_uid !== null && !isOpaqueId(l.doctor_uid)) return { ok: false, reason: 'bad_id' }
  const start = toEpochSeconds(l.window.t0)
  const end = toEpochSeconds(l.window.t1)
  if (start === null || end === null || end < start) return { ok: false, reason: 'bad_time' }

  const candidate = {
    encounter_id: l.encounter_id,
    room: l.room,
    specialty: null,
    doctor_uid: l.doctor_uid,
    presc_uid: l.rx?.presc_uid ?? null,
    presc_match: l.rx ? l.rx.match_confidence : 'none',
    window: { start: isoOf(start), end: isoOf(end), complete: l.window.complete },
    turns: l.turns.map((t) => ({
      id: t.turn_id,
      role: t.role,
      t0: relativeTime(t.t0, start),
      t1: relativeTime(t.t1, start),
      text_en: t.text_en,
      text_native: t.text_native ?? null,
      lang: t.lang ?? 'und',
    })),
    rx: l.rx ? { requires_surgery: l.rx.requires_surgery, procedure_text: l.rx.procedure_text } : null,
    clips: [],
  }
  // Offsets in the wrong unit (e.g. ms from window start) or from another clip land far past the window end.
  if (candidate.turns.some((t) => t.t1 > end - start + WINDOW_SLACK_SECONDS)) return { ok: false, reason: 'bad_time' }
  const parsed = ConsultAuditInput.safeParse(candidate)
  if (!parsed.success) {
    const timeIssue = parsed.error.issues.some((i) => i.path[0] === 'turns' && (i.path[2] === 't0' || i.path[2] === 't1'))
    return { ok: false, reason: timeIssue ? 'bad_time' : 'bad_shape' }
  }
  return {
    ok: true,
    consult: { input: parsed.data, source: l.source, match_confidence: l.rx ? l.rx.match_confidence : 'none', window_complete: l.window.complete },
  }
}

export interface LoadResult {
  /** Non-blank and blank lines read. */
  lines: number
  consults: LoadedConsult[]
  rejects: Record<RejectReason, number>
}

export function parseConsultLines(text: string): LoadResult {
  const rejects = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<RejectReason, number>
  const consults: LoadedConsult[] = []
  const seen = new Set<string>()
  const rows = text.split('\n')
  if (rows[rows.length - 1] === '') rows.pop() // the final newline is not a line
  rows.forEach((row, i) => {
    const result = parseConsultLine(row.replace(/\r$/, ''))
    if (!result.ok) {
      rejects[result.reason] += 1
      return
    }
    if (seen.has(result.consult.input.encounter_id)) {
      rejects.duplicate_encounter_id += 1
      return
    }
    seen.add(result.consult.input.encounter_id)
    consults.push({ line: i + 1, ...result.consult })
  })
  return { lines: rows.length, consults, rejects }
}

export function loadConsults(path: string): LoadResult {
  return parseConsultLines(readFileSync(path, 'utf8'))
}
