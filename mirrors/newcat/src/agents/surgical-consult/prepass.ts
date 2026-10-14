import type { ConsultAuditInput, Role } from './input.js'
import { PREPASS_VERSION } from './versions.js'

export const MERGE_GAP_SECONDS = 2
export const MAX_GAP_SECONDS = 120

export interface PrepassTurn {
  id: string
  merged_ids: string[]
  role: Role
  t0: number
  t1: number
  text_en: string
  text_native: string | null
  lang: string
}

export type IncompleteReason = 'window_incomplete' | 'no_doctor_turn' | 'no_patient_turn' | 'gap_over_120s'

export interface PrepassResult {
  version: typeof PREPASS_VERSION
  turns: PrepassTurn[]
  body: string
  complete: boolean
  incomplete_reasons: IncompleteReason[]
}

// Turn t0/t1 are read as seconds from window start (spec 2.1 leaves the base unstated).
export function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g
// JS \s does not match U+0085 (NEL), so it is added explicitly (I1 refute R1).
const WS = /[\s\u0085]+/g

// Gaps are compared rounded to milliseconds so float noise (3.3 - 1.3 = 1.9999999999999996) cannot flip a boundary.
function gapSeconds(prevT1: number, nextT0: number): number {
  return Math.round((nextT0 - prevT1) * 1000) / 1000
}

// Completeness (spec 3.1) is deliberately narrower than "no gap inside the window": only gaps between consecutive
// kept turns count. Leading silence (window.start to the first turn) and trailing silence (last turn to window.end)
// are NOT checked, because the cutter's window edges are approximate (I1c ruling N7).
export function prepass(input: Pick<ConsultAuditInput, 'window' | 'turns'>): PrepassResult {
  const merged: PrepassTurn[] = []
  for (const turn of input.turns) {
    // Zero-width characters count as empty; all whitespace (newlines included) collapses so a turn is one line.
    if (turn.text_en.replace(ZERO_WIDTH, '').replace(WS, ' ').trim() === '') continue
    const text = turn.text_en.replace(WS, ' ').trim()
    const native = turn.text_native?.replace(WS, ' ').trim() || null
    const prev = merged[merged.length - 1]
    if (prev && prev.role === turn.role && gapSeconds(prev.t1, turn.t0) < MERGE_GAP_SECONDS) {
      prev.merged_ids.push(turn.id)
      prev.t1 = Math.max(prev.t1, turn.t1)
      prev.text_en = `${prev.text_en} ${text}`
      // Null if any part is null, so native stays aligned with text_en.
      prev.text_native = prev.text_native !== null && native !== null ? `${prev.text_native} ${native}` : null
      if (prev.lang !== turn.lang) prev.lang = 'mixed'
      continue
    }
    merged.push({
      id: turn.id,
      merged_ids: [turn.id],
      role: turn.role,
      t0: turn.t0,
      t1: turn.t1,
      text_en: text,
      text_native: native,
      lang: turn.lang,
    })
  }

  const body = merged.map((t) => `[T${t.id} ${t.role.toUpperCase()} ${mmss(t.t0)}] ${t.text_en}`).join('\n')

  const reasons: IncompleteReason[] = []
  if (!input.window.complete) reasons.push('window_incomplete')
  if (!merged.some((t) => t.role === 'doctor')) reasons.push('no_doctor_turn')
  if (!merged.some((t) => t.role === 'patient')) reasons.push('no_patient_turn')
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1]
    const next = merged[i]
    if (prev && next && gapSeconds(prev.t1, next.t0) > MAX_GAP_SECONDS) {
      reasons.push('gap_over_120s')
      break
    }
  }

  return { version: PREPASS_VERSION, turns: merged, body, complete: reasons.length === 0, incomplete_reasons: reasons }
}
