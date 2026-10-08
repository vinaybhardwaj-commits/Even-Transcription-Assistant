/**
 * Reader consult_text — S7-1 (it was a stub in S7-0). The words of one consult, as timestamped speaker lines, for an LLM rubric.
 *
 * SOURCE. The consult's span (readConsultSpan, which already refuses a held-out room-day before anything else is looked up) -> the turns of every overlapping bench window WITH their text
 * (readWindowTurns includeText: `payload.text`, in the language ASR produced) -> the turns whose midpoint falls inside the span, in time order. Speaker: `doctor` = an enrolled clinician matched
 * (role clinician), `other` = any other diarized speaker, `unknown` = a turn nobody was attributed. t_ms is milliseconds from the consult's open.
 * BENCH TEXT. Meet teleconsults are not room tape and have no consult window here: a key the database does not know is looked up in the lab store, rubric/bench/<rubric_id>/text/<key>.json
 * { lines: [{ t_s, speaker, text }] } (uploaded by GATING; transcript text lives ONLY there and in R2 evidence, never in a table). No room-day exists for them, so the blind-day guard cannot apply (and need not).
 * A text longer than MAX_CONSULT_CHARS is cut and says so (truncated).
 */
import { labStore } from "@/lib/sarvam-lab";
import { readConsultSpan } from "./consult-span";
import { readWindowTurns, type Turn } from "./turns";
import { refuse, type ReadResult } from "./common";

export const MAX_CONSULT_CHARS = 60_000;
export type ConsultLine = { t_ms: number; speaker: "doctor" | "other" | "unknown"; speaker_idx: number | null; text: string };
export type ConsultText = {
  consult_key: string; source: "database" | "bench_text"; span_ms: number; lines: ConsultLine[]; chars: number; truncated: boolean;
  /** an excerpt (a few turns around the topic), not a whole consult: the prompt says so */
  partial?: boolean;
  /** the turns (times relative to the consult's open) for the talk-time features */
  turns: Turn[];
};

const KEY = /^[A-Za-z0-9_.:@-]{1,120}$/;

function finish(key: string, source: ConsultText["source"], span_ms: number, lines: ConsultLine[], turns: Turn[]): ReadResult<ConsultText> {
  let chars = 0;
  const kept: ConsultLine[] = [];
  let truncated = false;
  for (const l of lines) {
    if (chars + l.text.length > MAX_CONSULT_CHARS) { truncated = true; break; }
    chars += l.text.length;
    kept.push(l);
  }
  if (kept.length === 0) return refuse("no_data", "the consult has no transcript text");
  return { ok: true, data: { consult_key: key, source, span_ms, lines: kept, chars, truncated, turns } };
}

export async function readConsultText(consultKey: string, opts: { rubricId?: string } = {}): Promise<ReadResult<ConsultText>> {
  if (!KEY.test(consultKey)) return refuse("bad_unit_key");
  const span = await readConsultSpan(consultKey);
  if (span.ok) {
    const { t_open_ms: open, t_close_ms: close } = span.data;
    const lines: ConsultLine[] = [];
    const turns: Turn[] = [];
    for (const w of span.data.windows) {
      const got = await readWindowTurns(w.window_id, { includeText: true });
      if (!got.ok) continue; // a window the readers refuse (a held-out room-day, no cues) contributes nothing
      for (const t of got.data.turns) {
        const mid = (t.start_ms + t.end_ms) / 2;
        if (mid < open || mid > close || !t.text || !t.text.trim()) continue;
        const speaker = t.speaker_idx === null ? "unknown" : t.role === "clinician" ? "doctor" : "other";
        lines.push({ t_ms: Math.max(0, t.start_ms - open), speaker, speaker_idx: t.speaker_idx, text: t.text.trim() });
        turns.push({ ...t, start_ms: Math.max(0, t.start_ms - open), end_ms: Math.max(1, t.end_ms - open), text: undefined });
      }
    }
    lines.sort((a, b) => a.t_ms - b.t_ms);
    return finish(consultKey, "database", close - open, lines, turns);
  }
  if (span.reason !== "not_found" || !opts.rubricId || !/^[a-z][a-z0-9_]{1,63}$/.test(opts.rubricId)) return span; // blind / open / bad key: the refusal stands
  return readBenchText(consultKey, opts.rubricId);
}

/** Text of a bench unit from the lab store only (rubric/bench/<rubric_id>/text/<key>.json). Never touches the database: excerpts have no consult and no room-day. */
export async function readBenchText(consultKey: string, rubricId: string): Promise<ReadResult<ConsultText>> {
  if (!KEY.test(consultKey) || !/^[a-z][a-z0-9_]{1,63}$/.test(rubricId)) return refuse("bad_unit_key");
  const store = labStore();
  if (!store) return refuse("not_found", "no such consult, and no bench text store");
  const obj = await store.get(`rubric/bench/${rubricId}/text/${consultKey}.json`);
  if (!obj) return refuse("not_found", "no such consult or bench text");
  let doc: { lines?: Array<{ t_s?: unknown; speaker?: unknown; text?: unknown }> };
  try {
    doc = JSON.parse(obj.body);
  } catch {
    return refuse("no_data", "the bench text is not JSON");
  }
  const raw = (doc.lines ?? []).filter((l) => typeof l.text === "string" && (l.text as string).trim() && typeof l.t_s === "number");
  const lines: ConsultLine[] = raw.map((l) => ({ t_ms: Math.round((l.t_s as number) * 1000), speaker: (l.speaker === "doctor" ? "doctor" : l.speaker === "other" || l.speaker === "patient" ? "other" : "unknown") as ConsultLine["speaker"], speaker_idx: null, text: (l.text as string).trim() })).sort((a, b) => a.t_ms - b.t_ms);
  const turns: Turn[] = lines.map((l, i) => ({ source_ref: `b${i}`, start_ms: l.t_ms, end_ms: Math.max(l.t_ms + 500, Math.min(l.t_ms + 15_000, lines[i + 1]?.t_ms ?? l.t_ms + 15_000)), speaker_idx: l.speaker === "unknown" ? null : l.speaker === "doctor" ? 0 : 1, role: l.speaker === "doctor" ? "clinician" : null, overlap_ms: null }));
  const span_ms = Math.max(1, (turns.at(-1)?.end_ms ?? 1));
  return finish(consultKey, "bench_text", span_ms, lines, turns);
}
