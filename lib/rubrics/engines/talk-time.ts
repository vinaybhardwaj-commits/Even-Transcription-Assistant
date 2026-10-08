/**
 * Engine talk_time — S7-0. PURE: one unit's turns -> doctor vs other talk share, turns, interruptions, overlap, longest monologue, silence share.
 * Definitions: rubrics/talk_time/rubric.json. A turn's class: doctor = role clinician; other = attributed to any other diarized speaker; unattributed = no room_turn_speaker row.
 */
import type { Turn } from "../readers/turns";
import type { EngineResult } from "./types";

export const MONOLOGUE_GAP_MS = 2000;
type Iv = [number, number];
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Total length of the union of intervals. */
export function unionMs(ivs: Iv[]): number {
  const s = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, curA = 0, curB = -Infinity;
  for (const [a, b] of s) {
    if (a > curB) { total += Math.max(0, curB - curA); curA = a; curB = b; } else if (b > curB) curB = b;
  }
  return total + Math.max(0, curB - curA);
}

/** Time covered by two or more DISTINCT speakers at once. */
export function overlapMs(turns: Array<{ speaker: number; s: number; e: number }>): number {
  const ev: Array<[number, number, number]> = [];
  for (const t of turns) { ev.push([t.s, 1, t.speaker]); ev.push([t.e, -1, t.speaker]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Map<number, number>();
  let last = 0, total = 0;
  for (const [t, d, sp] of ev) {
    if (active.size >= 2) total += t - last;
    last = t;
    const n = (active.get(sp) ?? 0) + d;
    if (n <= 0) active.delete(sp); else active.set(sp, n);
  }
  return total;
}

export function evaluateTalkTime(turnsIn: Turn[], span: { start_ms: number; end_ms: number }): EngineResult {
  const spanMs = span.end_ms - span.start_ms;
  if (!(spanMs > 0)) return { status: "failed", findings: [], reason: "bad_span" };
  if (turnsIn.length === 0) return { status: "skipped", findings: [], reason: "no_turns" };
  if (!turnsIn.some((t) => t.speaker_idx !== null)) return { status: "skipped", findings: [], reason: "no_diarization" };
  // clip to the span, drop what falls outside
  const turns = turnsIn
    .map((t) => ({ ...t, start_ms: Math.max(t.start_ms, span.start_ms), end_ms: Math.min(t.end_ms, span.end_ms) }))
    .filter((t) => t.end_ms > t.start_ms);
  if (turns.length === 0) return { status: "skipped", findings: [], reason: "no_turns" };
  const cls = (t: Turn): "doctor" | "other" | "unattributed" => (t.speaker_idx === null ? "unattributed" : t.role === "clinician" ? "doctor" : "other");
  const by: Record<"doctor" | "other" | "unattributed", Iv[]> = { doctor: [], other: [], unattributed: [] };
  const count = { doctor: 0, other: 0, unattributed: 0 };
  for (const t of turns) { by[cls(t)].push([t.start_ms, t.end_ms]); count[cls(t)] += 1; }
  const doctor = unionMs(by.doctor), other = unionMs(by.other), unatt = unionMs(by.unattributed);
  const att = turns.filter((t) => t.speaker_idx !== null).map((t) => ({ speaker: t.speaker_idx as number, s: t.start_ms, e: t.end_ms })).sort((a, b) => a.s - b.s || a.e - b.e);
  // an interruption: starts inside a turn of a DIFFERENT speaker and ends after it
  let interruptions = 0;
  for (const b of att) for (const a of att) if (a !== b && a.speaker !== b.speaker && a.s < b.s && b.s < a.e && b.e > a.e) { interruptions += 1; break; }
  // longest monologue: consecutive attributed turns of one speaker, gaps under MONOLOGUE_GAP_MS
  let longest = 0, runStart = 0, runEnd = 0, runSp: number | null = null;
  for (const t of att) {
    if (runSp === t.speaker && t.s - runEnd < MONOLOGUE_GAP_MS) runEnd = Math.max(runEnd, t.e);
    else { runSp = t.speaker; runStart = t.s; runEnd = t.e; }
    longest = Math.max(longest, runEnd - runStart);
  }
  const all = unionMs(turns.map((t) => [t.start_ms, t.end_ms] as Iv));
  const share = doctor + other > 0 && doctor > 0 && other > 0 ? doctor / (doctor + other) : null;
  const findings: string[] = [];
  if (doctor === 0) findings.push("no_doctor_identified");
  if (share !== null && share > 0.8) findings.push("doctor_dominant");
  if (share !== null && share < 0.2) findings.push("doctor_quiet");
  return {
    status: "ok",
    score: {
      span_ms: spanMs, doctor_talk_ms: doctor, other_talk_ms: other, unattributed_talk_ms: unatt, doctor_share: share === null ? null : r3(share),
      doctor_turns: count.doctor, other_turns: count.other, unattributed_turns: count.unattributed, interruptions, overlap_ms: overlapMs(att), longest_monologue_ms: longest,
      silence_share: r3(Math.max(0, 1 - all / spanMs)), speakers: new Set(att.map((t) => t.speaker)).size,
    },
    findings,
  };
}
