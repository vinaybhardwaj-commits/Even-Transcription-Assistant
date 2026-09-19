/**
 * lib/jev/bench-reader.ts — Slice J4: where the bench's inputs come from. Two readers behind one
 * interface, so a fixture and the database feed the same arithmetic.
 *
 * READ-ONLY. Every statement below is a SELECT; a test asserts it against the tag it is given.
 * TAGGED TEMPLATES, like every other reader in this codebase (no `sql.unsafe`, no interactive
 * transaction, no parameterised string). Timestamps leave the database as ISO strings through
 * `to_char(... AT TIME ZONE 'UTC', ...)`, so no driver decides what a Date is.
 *
 * NEVER SELECTED, ON PURPOSE: `visit.ambiguity`. It is `ambiguityOf(reasons)` — the arm's reasons
 * deduplicated, reordered and comma-joined — and the bench reads the firing rules from
 * `DraftVisit.reasons` in the arm's own output instead. Also never selected: any transcript or note text, any payload of a
 * kind the arms do not need, any name. The cue `payload` IS read (arm A needs `individual_uid`
 * to run) and stays in memory; no report field carries it.
 *
 * INFERRED columns (no bench run has met a live `jev_window_signal` — 0106 is unapplied at head
 * 105): jev_window_signal's columns come from db/migrations/0106_jev_window_signal.sql, and
 * jev_role_signal's from 0107. The others (cue, visit, bench_session, room_day, room_turn_speaker,
 * llm_traces) were read from information_schema on 19 Sep 2026. A missing table is an ABSENT ARM
 * with a named reason, never a thrown error and never a zero.
 */
import type { FuseCue } from "@/lib/brain/fuse/types";
import type { TapeSession } from "@/lib/brain/fuse/rules";
import type { JevWindowSignal } from "@/lib/brain/fuse/jev-arm";
import type { RoleSignal } from "./bench";

export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;

export type BenchJevSignal = JevWindowSignal & { model: string; prompt_version: string; input_tokens: number; batch_id: string; created_at: string };

export type PersistedVisit = { arm: string; state: string; pstart_at: string | null; ended_at: string | null; tape_start_ms: number | null; opened_by: string };

export type BenchDay = {
  room_day_id: string;
  scratch: boolean | null;
  cues: FuseCue[];
  sessions: TapeSession[];
  /** null = the table is absent (migration unapplied) or the day has none — see `jev_signals_absent` */
  jev_signals: BenchJevSignal[] | null;
  jev_signals_absent: string | null;
  /** signal rows dropped because a required number was NULL or not finite (a NULL is not a confident zero) */
  jev_signals_invalid: number;
  jev_native_signals: BenchJevSignal[] | null;
  persisted: Record<string, PersistedVisit[]>;
  role_signals: RoleSignal[] | null;
  role_signals_absent: string | null;
  /** total_ms of `surface='jev'` traces near this day's signals — APPROXIMATE attribution, see bench-run */
  jev_trace_total_ms: number[] | null;
  /** J0 pre-check (spec §7: run jev-english first). null = jev_window_text absent or not read. */
  english_coverage: { windows: number; text_rows: number; english_nonempty: number } | null;
};

export interface BenchReader {
  roomDayMeta(ids: readonly string[]): Promise<{ id: string; scratch: boolean | null }[]>;
  loadDay(id: string): Promise<BenchDay>;
  /** bench_session rows by id — for signal files whose sessions the day's own signals did not name */
  sessionsById?(ids: readonly string[]): Promise<TapeSession[]>;
}

// ---------------------------------------------------------------- fixture reader

export function fixtureReader(fx: { days: (Partial<BenchDay> & { room_day_id: string })[] }): BenchReader {
  const byId = new Map(fx.days.map((d) => [d.room_day_id, d]));
  return {
    async roomDayMeta(ids) {
      return ids.filter((i) => byId.has(i)).map((i) => ({ id: i, scratch: byId.get(i)?.scratch ?? null }));
    },
    async loadDay(id) {
      const d = byId.get(id);
      if (!d) throw new Error(`fixture_has_no_day:${id}`);
      return {
        room_day_id: id,
        scratch: d.scratch ?? null,
        cues: d.cues ?? [],
        sessions: d.sessions ?? [],
        jev_signals: d.jev_signals ?? null,
        jev_signals_absent: d.jev_signals ? null : d.jev_signals_absent ?? "fixture_has_no_signals",
        jev_signals_invalid: d.jev_signals_invalid ?? 0,
        jev_native_signals: d.jev_native_signals ?? null,
        persisted: d.persisted ?? {},
        role_signals: d.role_signals ?? null,
        role_signals_absent: d.role_signals ? null : d.role_signals_absent ?? "fixture_has_no_role_signals",
        jev_trace_total_ms: d.jev_trace_total_ms ?? null,
        english_coverage: d.english_coverage ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------- database reader

/** Postgres 42P01 (undefined_table): by SQLSTATE when the driver carries it, else by the message. */
const isMissingRelation = (e: unknown): boolean =>
  (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "42P01") || /relation .* does not exist|42P01/i.test(e instanceof Error ? e.message : String(e));

/** NULL and undefined are NaN, never 0: a missing p_start must not read as a confident zero. */
const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : typeof v === "number" ? v : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v : String(v));

export function dbReader(sql: Sql): BenchReader {
  return {
    async roomDayMeta(ids) {
      const rows = (await sql`SELECT id, scratch FROM room_day WHERE id = ANY(${ids as string[]})`) as { id: string; scratch: boolean | null }[];
      return rows.map((r) => ({ id: r.id, scratch: r.scratch }));
    },

    async sessionsById(ids) {
      if (ids.length === 0) return [];
      const rows = (await sql`
        SELECT id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_iso,
               to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_iso
          FROM bench_session WHERE id = ANY(${ids as string[]})`) as { id: string; started_iso: string; ended_iso: string | null }[];
      return rows.map((s) => ({ id: s.id, started_at: s.started_iso, ended_at: s.ended_iso }));
    },

    async loadDay(id) {
      const meta = ((await sql`SELECT id, scratch FROM room_day WHERE id = ${id}`) as { id: string; scratch: boolean | null }[])[0];

      const cueRows = (await sql`
        SELECT id, type, payload, source, source_ref,
               to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_iso
          FROM cue WHERE room_day_id = ${id} ORDER BY at, id`) as { id: string; type: string; payload: unknown; source: string | null; source_ref: string | null; at_iso: string }[];
      const cues: FuseCue[] = cueRows.map((c) => ({
        id: c.id,
        type: c.type,
        at: c.at_iso,
        payload: c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? (c.payload as Record<string, unknown>) : null,
        source: c.source,
        source_ref: c.source_ref,
      }));

      let jev_signals: BenchJevSignal[] | null = null;
      let jev_signals_absent: string | null = null;
      let jev_signals_invalid = 0;
      try {
        const rows = (await sql`
          SELECT window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence,
                 p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso
            FROM jev_window_signal WHERE room_day_id = ${id} ORDER BY start_ms`) as Record<string, unknown>[];
        if (rows.length === 0) jev_signals_absent = "no_jev_signal_rows_for_this_day";
        else {
          const mapped = rows.map((r) => ({
            window_id: str(r.window_id), room_day_id: str(r.room_day_id), session_id: str(r.session_id),
            start_ms: num(r.start_ms), end_ms: num(r.end_ms), phase: r.phase as BenchJevSignal["phase"],
            phase_probs: (r.phase_probs ?? {}) as Record<string, number>, phase_confidence: num(r.phase_confidence),
            p_start: num(r.p_start), p_end: num(r.p_end), p_clinician: num(r.p_clinician), p_clinical: num(r.p_clinical),
            model: str(r.model), prompt_version: str(r.prompt_version), input_tokens: num(r.input_tokens), batch_id: str(r.batch_id), created_at: r.created_iso ? str(r.created_iso) : "",
          }));
          const ok = mapped.filter((x) => [x.start_ms, x.end_ms, x.p_start, x.p_end, x.p_clinician, x.p_clinical, x.phase_confidence].every(Number.isFinite));
          jev_signals_invalid = mapped.length - ok.length;
          if (ok.length === 0) jev_signals_absent = `all_${mapped.length}_signal_rows_invalid (NULL or non-finite required number)`;
          else jev_signals = ok;
        }
      } catch (e) {
        if (!isMissingRelation(e)) throw e;
        jev_signals_absent = "table_missing:jev_window_signal (migration 0106 not applied)";
      }

      const sessionIds = [...new Set([...(jev_signals ?? []).map((s) => s.session_id)])];
      const sessions: TapeSession[] = sessionIds.length === 0 ? [] : ((await sql`
        SELECT id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_iso,
               to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_iso
          FROM bench_session WHERE id = ANY(${sessionIds})`) as { id: string; started_iso: string; ended_iso: string | null }[]).map((s) => ({ id: s.id, started_at: s.started_iso, ended_at: s.ended_iso }));

      // Persisted visit rows — for the arms the bench does not run itself (hybrid, flash). No
      // `ambiguity` and no `reasons` here: the column is a re-encoding of the list, and these arms'
      // firing rules are not what is being benched. Their `ended_at` is NULL unless state = 'ended'.
      const visitRows = (await sql`
        SELECT arm, state, opened_by, tape_start_ms,
               to_char(pstart_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pstart_iso,
               to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_iso
          FROM visit WHERE room_day_id = ${id}`) as Record<string, unknown>[];
      const persisted: Record<string, PersistedVisit[]> = {};
      for (const v of visitRows) {
        (persisted[str(v.arm)] ??= []).push({
          arm: str(v.arm), state: str(v.state), pstart_at: v.pstart_iso ? str(v.pstart_iso) : null, ended_at: v.ended_iso ? str(v.ended_iso) : null,
          tape_start_ms: v.tape_start_ms === null || v.tape_start_ms === undefined ? null : num(v.tape_start_ms), opened_by: str(v.opened_by),
        });
      }

      let role_signals: RoleSignal[] | null = null;
      let role_signals_absent: string | null = null;
      try {
        const rows = (await sql`
          SELECT DISTINCT ON (window_id, speaker_idx) window_id, speaker_idx, role, role_confidence
            FROM jev_role_signal WHERE room_day_id = ${id} ORDER BY window_id, speaker_idx, created_at DESC`) as Record<string, unknown>[];
        if (rows.length === 0) role_signals_absent = "no_jev_role_signal_rows_for_this_day";
        else {
          const wins = [...new Set(rows.map((r) => str(r.window_id)))];
          const ac = (await sql`
            SELECT window_id, speaker_idx, bool_or(clinician_id IS NOT NULL) AS acoustic
              FROM room_turn_speaker WHERE window_id = ANY(${wins}) GROUP BY window_id, speaker_idx`) as { window_id: string; speaker_idx: number; acoustic: boolean }[];
          const flag = new Map(ac.map((a) => [`${a.window_id}#${a.speaker_idx}`, a.acoustic === true]));
          role_signals = rows
            .map((r) => ({
              window_id: str(r.window_id), speaker_idx: num(r.speaker_idx), role: str(r.role), role_confidence: num(r.role_confidence),
              acoustic_clinician: flag.get(`${str(r.window_id)}#${num(r.speaker_idx)}`) === true,
            }))
            .filter((r) => Number.isFinite(r.speaker_idx) && Number.isFinite(r.role_confidence));
        }
      } catch (e) {
        if (!isMissingRelation(e)) throw e;
        role_signals_absent = "table_missing:jev_role_signal (migration 0107 not applied)";
      }

      // Latency. llm_traces rows for surface='jev' carry question ids and a byte size, NOT a
      // room_day (lib/jev/client.ts request_input), so a trace cannot be tied to a day. The
      // nearest honest thing is the traces that completed inside this day's signal-write span,
      // ±10 minutes. It is approximate, another job's calls can land inside it, and it is labelled so.
      let jev_trace_total_ms: number[] | null = null;
      const stamps = (jev_signals ?? []).map((s) => Date.parse(s.created_at)).filter(Number.isFinite);
      if (stamps.length > 0) {
        const lo = new Date(Math.min(...stamps) - 600_000).toISOString();
        const hi = new Date(Math.max(...stamps) + 600_000).toISOString();
        const tr = (await sql`
          SELECT total_ms FROM llm_traces
           WHERE surface = 'jev' AND total_ms IS NOT NULL AND started_at >= ${lo}::timestamptz AND started_at <= ${hi}::timestamptz`) as { total_ms: number }[];
        jev_trace_total_ms = tr.map((t) => num(t.total_ms));
      }

      // J0 coverage: how many of the day's bench windows have a jev_window_text row, and how many of
      // those carry any English at all. Counts only; the text itself is never selected here.
      let english_coverage: BenchDay["english_coverage"] = null;
      try {
        const cov = (await sql`
          SELECT (SELECT count(*) FROM bench_window WHERE room_day_id = ${id}) AS windows,
                 (SELECT count(*) FROM jev_window_text WHERE room_day_id = ${id}) AS text_rows,
                 (SELECT count(*) FROM jev_window_text WHERE room_day_id = ${id} AND english IS NOT NULL) AS english_nonempty`) as Record<string, unknown>[];
        if (cov[0]) english_coverage = { windows: num(cov[0].windows), text_rows: num(cov[0].text_rows), english_nonempty: num(cov[0].english_nonempty) };
      } catch (e) {
        if (!isMissingRelation(e)) throw e;
      }

      return { room_day_id: id, scratch: meta?.scratch ?? null, cues, sessions, jev_signals, jev_signals_absent, jev_signals_invalid, jev_native_signals: null, persisted, role_signals, role_signals_absent, jev_trace_total_ms, english_coverage };
    },
  };
}
