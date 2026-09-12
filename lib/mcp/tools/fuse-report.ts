/**
 * lib/mcp/tools/fuse-report.ts — scribe_fuse_report (Fuse slice 5, PRD §11.5). READ scope.
 *
 * The artefact the designer reviews. Four sources for one room-day, side by side, and the
 * places they disagree. DISAGREEMENT IS THE PRODUCT: this is not a health check and not a
 * summary, and a version of it that made everything look tidy would be worthless.
 *
 * The two headlines it exists to surface, both of which must survive on the real corpus:
 *
 *   · THE SILENCE. OPD 7 has a stretch of tape — 04:36:59Z → 10:39:35Z, over six hours — with
 *     no warehouse event of any kind. It is computed from the CUE TIMELINE (S6) and never
 *     from visits, because no visit represents it and none should: nothing happened in the
 *     warehouse, so the fuse minted nothing, so a visit-shaped view of the day cannot see it.
 *   · THE UNACCOUNTED MARKS. A clinician tapped the kiosk and the warehouse has no trace of
 *     the consult at all. Cardiology has two.
 *
 * A SCRATCH ROOM HAS NO TAPE. bench_session rows belong to the REAL room, which is why
 * scribe_day_report aimed at a scratch room comes back empty and why this tool exists. The real
 * room is recovered with realRoomIdFor() from lib/brain/scratch.ts — the exported inverse of the
 * function that derived the scratch id in the first place, not string surgery here.
 *
 * WRITES NOTHING (S3). Every statement in this file is a SELECT. No cue, no visit, no trace.
 * Identity is off by default (S5): individual_uid appears only with include_identity:true.
 * Every constant that shaped the answer is reported in `parameters` rather than buried (S4).
 */

import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import { listBenchChunks, listBenchSessions, type BenchChunkRow } from "@/lib/bench";
import { endTimeDisagrees, tapeEndMs } from "./bench";
import { STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { realRoomIdFor, SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
import { DEFAULT_ARM, SQL_CUES_FOR_ROOM_DAY, SQL_ROOM_DAY_BY_ID, SQL_TURN_CUE_COUNTS, SQL_VISITS_FOR_DAY, TURN_CUE_TYPES, WINDOW_CUE_TYPE, type RoomDayByIdRow } from "@/lib/brain/state";
import { ALL_RULES_REASONS, LAST_MARK_WINDOW_MS } from "@/lib/brain/fuse/rules";
import { argBool, argDetail, argStr, DETAIL_SCHEMA, failSafe, type McpTool, type ToolArgs } from "../registry";

/**
 * How long the warehouse must say nothing before it counts as a SILENCE.
 *
 * 60 minutes, and the number is a judgement rather than a measurement, so it is named, exported
 * and reported in `parameters` where a reader can disagree with it. The reasoning: a busy OPD
 * clinic produces a warehouse event every few minutes, and the ordinary between-patient gap is
 * single-digit minutes. An hour is far outside that and still fine-grained enough to split the
 * OPD 7 six-hour hole from a lunch break rather than swallowing both into one row.
 */
export const SILENCE_THRESHOLD_MS = 60 * 60 * 1000;

/** Below this a visit is reported as low-confidence in the reconciliation. */
export const LOW_CONFIDENCE_BELOW = 0.6;

/** The cue types that come from the warehouse. `consult_mark` is tape-side and is not one. */
export const WAREHOUSE_CUE_TYPES = ["pqm_called", "pstart", "dx_event", "pulse_note"] as const;

/**
 * Warehouse events that change a visit's STATE without opening or closing it. Arm A's only one
 * is the dx_event, which moves a visit to at_diagnostics; this is that arm's vocabulary written
 * down, not a rule of its own, and it is named here so the reconciliation can say "moved"
 * rather than lumping those events in with the ones that did nothing.
 */
export const STATE_MOVING_CUE_TYPES = ["dx_event"] as const;
const MARK_CUE_TYPE = "consult_mark";

/**
 * The `room` row for a room id. Goes through lib/db's tagged template (that handle takes no
 * text+params form), so this constant is the exact statement the template issues, named so the
 * report can quote it word for word.
 */
export const SQL_REPORT_ROOM_SELECT = "SELECT id, slug, name, disabled_at FROM room WHERE id = $1 LIMIT 1";

type CueRow = { id: string; type: string; at: Date | string; payload: unknown; source: string | null; source_ref: string | null };
type VisitRow = {
  id: string; individual_uid: string | null; state: string; confidence: number | null;
  end_reason: string | null; ambiguity: string | null; arm: string | null;
  opened_by: string | null; opened_by_kind: string | null;
};
type RoomRow = { id: string; slug: string; name: string; disabled_at: string | Date | null };

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(ms(v)).toISOString());
const payloadOf = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

/** A tape interval per session: [first piece, last piece]. Used to answer "was tape running?". */
type TapeSpan = { session_id: string; from: number; to: number };

const overlaps = (spans: TapeSpan[], from: number, to: number): boolean => spans.some((s) => s.from < to && s.to > from);

const fuseReport: McpTool = {
  name: "scribe_fuse_report",
  description:
    "The fuse scoreboard for ONE room-day (PRD §11.5): marks vs warehouse vs visits vs tape, and every place they disagree. Names the arm (default rules). A SCRATCH room-day reads the REAL room's tape, because a scratch room has none of its own. `silence` walks the WAREHOUSE CUE timeline — never the visits — and reports every gap longer than the reported threshold with whether tape was running across it; that is how the OPD 7 six-hour hole is visible at all, since no visit represents it. Each entry names its `edge`: leading (tape start → first warehouse event), between, trailing (last event → tape end), or whole_day when the warehouse recorded NOTHING across a whole day of tape. One threshold for all four. Every warehouse event is attributed to exactly one of warehouse_opened_a_visit / closed / moved / unbound, and the four sum to warehouse_total. `marks_unaccounted` counts kiosk taps whose window holds no warehouse clock — consultations the warehouse has no trace of. SPEECH TURNS (slice A): four more counters — turns_total, turn_silences, speaker_matches and turn_cues_total, the three types partitioning the day's turn cues so they sum to the total. They come from their own aggregate, so they survive a failure of the full cue read; speaker_matches is legitimately 0 until slice B, and a reported zero is not a missing count. Also `turn_tape`: how much tape was actually listened to, rolled up from payload.window and payload.source_used on the day's turn cues — windows asked, minutes asked / with words / silent (a partition, exact in ms and rounded in minutes), how many windows the BACKUP microphone answered, and the language whisper.cpp reported per window. Windows are counted once each, so overlapping asks add their minutes twice and say so with windows_overlap. COMPLETENESS (K3): every asked window carries one `stt_window` cue saying whether it finished, and turn_tape reports windows_complete / windows_incomplete / windows_without_marker plus an `incomplete` list naming each unfinished window and why it stopped. An incomplete window has ZERO turns by construction — the writer rolls the partial back rather than committing 71 rows of 162 — so its emptiness is an unfinished read, never silence. stt_window is deliberately NOT one of the three evidence counters: it says a window was finished, never that anything was heard. Stored in_tape_window is REPORTED, never recomputed; a disagreement with the tape actually read is named rather than corrected. Read-only: writes nothing. individual_uid is omitted unless include_identity:true. Every constant that shaped the result is in `parameters`.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "rd_… — scratch or live" },
      arm: { type: "string", description: "which arm's visits to report; default rules" },
      include_identity: { type: "boolean", default: false, description: "include individual_uid" },
      detail: DETAIL_SCHEMA,
    },
    required: ["room_day_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ visits: [] as unknown[], marks: [] as unknown[] }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ok: false, error: "room_day_id_required" };
      const arm = argStr(args, "arm", 32) ?? DEFAULT_ARM;
      const includeIdentity = argBool(args, "include_identity");

      const dayRes = await query<RoomDayByIdRow>(SQL_ROOM_DAY_BY_ID, [roomDayId]);
      const day = dayRes.rows[0];
      if (!day) return { ok: false, error: "room_day_not_found", room_day_id: roomDayId };

      // ---- which room actually holds the tape? -------------------------------
      // A scratch room has none. realRoomIdFor is the exported inverse of the function that
      // derived the scratch id, so the two cannot drift apart; a live day resolves to itself.
      const isScratch = day.room_id.startsWith(SCRATCH_ROOM_PREFIX);
      const realRoomId = isScratch ? realRoomIdFor(day.room_id) : day.room_id;
      let realRoom: RoomRow | null = null;
      const degraded: string[] = [];
      if (realRoomId) {
        try {
          const rows = (await sql`SELECT id, slug, name, disabled_at FROM room WHERE id = ${realRoomId} LIMIT 1`) as RoomRow[];
          realRoom = rows[0] ?? null;
        } catch (e) {
          degraded.push(`room_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      }

      // ---- the tape, from the REAL room ---------------------------------------
      const spans: TapeSpan[] = [];
      let sessions: Array<Record<string, unknown>> = [];
      let firstPieceMs: number | null = null;
      let lastPieceMs: number | null = null;
      let totalRecordedMs = 0;
      if (realRoom) {
        try {
          const rows = await listBenchSessions({ room_id: realRoom.id, ist_date: day.ist_date });
          const ordered = [...rows].sort((a, b) => ms(a.started_at) - ms(b.started_at));
          for (const s of ordered) {
            let chunks: BenchChunkRow[] = [];
            try {
              chunks = await listBenchChunks(s.id);
            } catch {
              degraded.push(`${s.id}:chunks_read_failed`);
            }
            const tapeMs = tapeEndMs(chunks);
            const startedMs = ms(s.started_at);
            const storedMs = s.ended_at === null ? null : ms(s.ended_at);
            if (tapeMs !== null) {
              spans.push({ session_id: s.id, from: startedMs, to: tapeMs });
              totalRecordedMs += Math.max(0, tapeMs - startedMs);
              if (firstPieceMs === null || startedMs < firstPieceMs) firstPieceMs = startedMs;
              if (lastPieceMs === null || tapeMs > lastPieceMs) lastPieceMs = tapeMs;
            }
            sessions.push({
              id: s.id,
              started_at: iso(s.started_at),
              // THE TAPE CLOCK: the last piece recorded on either mic, never the stored end.
              tape_ended_at: tapeMs === null ? null : new Date(tapeMs).toISOString(),
              stored_ended_at: iso(s.ended_at),
              end_time_disagrees: endTimeDisagrees(storedMs, tapeMs),
              chunk_count: chunks.length,
            });
          }
        } catch (e) {
          sessions = [];
          degraded.push(`tape_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      }

      // ---- the cues ------------------------------------------------------------
      let cues: CueRow[] = [];
      try {
        cues = (await query<CueRow>(SQL_CUES_FOR_ROOM_DAY, [roomDayId])).rows;
      } catch (e) {
        degraded.push(`cues_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
      const inOrder = [...cues].sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
      const markCues = inOrder.filter((c) => c.type === MARK_CUE_TYPE);
      const whCues = inOrder.filter((c) => (WAREHOUSE_CUE_TYPES as readonly string[]).includes(c.type));

      // ---- the visits, for the named arm ---------------------------------------
      let visitRows: VisitRow[] = [];
      try {
        visitRows = (await query<VisitRow>(SQL_VISITS_FOR_DAY, [roomDayId, arm])).rows;
      } catch (e) {
        degraded.push(`visits_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
      const visitByOpenedBy = new Map(visitRows.filter((v) => v.opened_by).map((v) => [v.opened_by!, v]));

      // ---- the speech turns (slice A) -------------------------------------------
      // Four counters, and the fourth is the identity that makes the other three checkable: the
      // three types PARTITION the turn cues of the day, so they sum to the total. The same
      // discipline as the warehouse's four buckets — a count that cannot be checked against
      // anything is a number, not evidence.
      //
      // Its own aggregate, not a filter over the cue list above: a day of turns is thousands of
      // rows carrying transcript text, and these counts survive a failure of that larger read
      // rather than disappearing with it. A failure here degrades to zeros and a named degraded
      // read — never a throw, and never a wrong number.
      const turnCounts: Record<string, number> = {};
      for (const t of TURN_CUE_TYPES) turnCounts[t] = 0;
      try {
        const rows = (await query<{ type: string; n: number | string }>(SQL_TURN_CUE_COUNTS, [roomDayId])).rows;
        for (const row of rows) {
          const n = typeof row.n === "number" ? row.n : Number(row.n);
          if (Number.isFinite(n)) turnCounts[row.type] = n;
        }
      } catch (e) {
        degraded.push(`turn_cue_counts_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
      const turnCuesTotal = TURN_CUE_TYPES.reduce((a, t) => a + (turnCounts[t] ?? 0), 0);

      // ---- the tape the turns came from (slice A, K2 correction 4) --------------
      // PRD §10 asked for five more numbers, and every one of them is a rollup over the WINDOW
      // a turn cue was produced for — payload.window and payload.source_used, written by
      // buildTurns on every turn and every silence. None is derivable from a turn's own bounds:
      // a turn is as long as the phrase, not as long as the tape somebody asked about, and a
      // silent window has no turn at all.
      //
      // Derived from the cue list this report ALREADY read, not from a second aggregate. The
      // four counters above have their own aggregate because they must survive a failure of
      // that read; these cannot — a window is a payload field, so there is nothing to roll up
      // if the payloads did not arrive. When the read failed, `cues_read_failed` is already in
      // `degraded` and this section reports zeros over zero windows rather than a wrong number.
      // K3: stt_window joins the walk. It is NOT evidence — it never says anything was heard —
      // so it stays out of the three-way evidence partition above and is counted here instead,
      // where the question is "what did we ask for and did we finish it". It is also the ONLY
      // authority on the second half of that question: a window with no turns and no marker was
      // never asked, while a window with a complete:false marker was asked and could not finish.
      type TurnWindow = { from: number; to: number; words: number; silences: number; markers: number; complete: boolean | null; stoppedEarly: string | null; segmentCount: number | null; mics: Set<string>; langs: Set<string> };
      const windows = new Map<string, TurnWindow>();
      let turnCuesWithoutWindow = 0;
      const ROLLUP_TYPES: readonly string[] = [...TURN_CUE_TYPES, WINDOW_CUE_TYPE];
      for (const c of inOrder) {
        if (!ROLLUP_TYPES.includes(c.type)) continue;
        const pay = c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? (c.payload as Record<string, unknown>) : null;
        const w = pay?.window && typeof pay.window === "object" && !Array.isArray(pay.window) ? (pay.window as Record<string, unknown>) : null;
        const from = typeof w?.start_ms === "number" ? w.start_ms : NaN;
        const to = typeof w?.end_ms === "number" ? w.end_ms : NaN;
        // A cue written before K2 carries no window. COUNTED AND NAMED rather than assumed to
        // be zero minutes: the day's minutes are then understated, and the reader has to be
        // told that rather than shown a total that looks complete.
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          turnCuesWithoutWindow++;
          continue;
        }
        const key = `${from}|${to}`;
        let entry = windows.get(key);
        if (!entry) {
          entry = { from, to, words: 0, silences: 0, markers: 0, complete: null, stoppedEarly: null, segmentCount: null, mics: new Set(), langs: new Set() };
          windows.set(key, entry);
        }
        if (c.type === "stt_turn") entry.words++;
        else if (c.type === "stt_silence") entry.silences++;
        else if (c.type === WINDOW_CUE_TYPE) {
          entry.markers++;
          // Only a marker that actually SAYS so moves this off null. A marker whose payload
          // carries no `complete` field is a marker that did not answer the question, and
          // reading its silence as `false` would invent a failure that nothing reported.
          if (typeof pay?.complete === "boolean") {
            // Two markers for one window should be impossible — delete-then-insert replaces the
            // pair. If it ever happens the PESSIMISTIC reading wins: a complete marker never
            // overwrites an incomplete one, because the unfinished read is the one worth acting on.
            entry.complete = entry.complete === false ? false : pay.complete;
          }
          if (pay?.complete === false && typeof pay?.stopped_early === "string") entry.stoppedEarly = pay.stopped_early;
          if (typeof pay?.segment_count === "number") entry.segmentCount = pay.segment_count;
        }
        entry.mics.add(typeof pay?.source_used === "string" ? pay.source_used : "unreported");
        entry.langs.add(typeof pay?.language === "string" ? pay.language : "unreported");
      }
      const windowList = [...windows.values()].sort((a, b) => a.from - b.from || a.to - b.to);
      let msAsked = 0;
      let msWithWords = 0;
      let windowsBackup = 0;
      const langWindows: Record<string, number> = {};
      for (const w of windowList) {
        const span = w.to - w.from;
        msAsked += span;
        // WITH WORDS means the window produced at least one stt_turn — on ANY read of it. A
        // window re-transcribed from the other microphone is the same window asked once, and
        // "somebody spoke in it" is not undone by a second read that heard nothing.
        if (w.words > 0) msWithWords += span;
        if (w.mics.has("backup")) windowsBackup++;
        for (const l of w.langs) langWindows[l] = (langWindows[l] ?? 0) + 1;
      }
      const msSilent = msAsked - msWithWords;
      const windowsWithWords = windowList.filter((w) => w.words > 0).length;
      // K3 §3 — completeness, which is a different question from "was anything said".
      //   complete === true   the window finished; its turns are the whole window
      //   complete === false  the window was ASKED and could not finish; its turns were rolled
      //                       back, so zero stt_turn rows exist for it and the absence is not
      //                       silence — it is an unfinished read
      //   complete === null   no marker at all: written before K3, or by something else
      const windowsComplete = windowList.filter((w) => w.complete === true).length;
      const incompleteWindows = windowList.filter((w) => w.complete === false);
      const windowsNoMarker = windowList.filter((w) => w.complete === null).length;
      // Windows are counted once each, so two overlapping asks are two windows and their minutes
      // are added twice. Said out loud rather than silently merged: merging would make the three
      // minute figures stop partitioning, and a reader who sees this flag knows to read the total
      // as "minutes asked for", not "minutes of tape covered".
      let windowsOverlap = false;
      for (let i = 1; i < windowList.length; i++) {
        if (windowList[i]!.from < windowList[i - 1]!.to) { windowsOverlap = true; break; }
      }
      const minutes = (msValue: number) => Math.round(msValue / 6000) / 10;
      const turnTape = {
        windows_total: windowList.length,
        windows_with_words: windowsWithWords,
        windows_silent: windowList.length - windowsWithWords,
        // The exact partition, in the unit it was measured in: asked = with_words + silent, to
        // the millisecond. The minutes below are the same three numbers for a human, and are
        // rounded independently — so check the identity on the ms, never on the minutes.
        ms_asked: msAsked,
        ms_with_words: msWithWords,
        ms_silent: msSilent,
        minutes_asked: minutes(msAsked),
        minutes_with_words: minutes(msWithWords),
        minutes_silent: minutes(msSilent),
        // U4's answer, per window. NOT a partition with a primary count: one window read twice
        // can name both microphones, and it is counted here if EITHER read used the backup.
        windows_backup_mic: windowsBackup,
        // What whisper.cpp reported, by how many windows reported it. A day is usually one
        // language; two is a real answer, not an error, and 'unreported' is its own bucket
        // rather than being folded into any language.
        languages: Object.entries(langWindows)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([language, w]) => ({ language, windows: w })),
        windows_complete: windowsComplete,
        windows_incomplete: incompleteWindows.length,
        // A window with no USABLE marker is NOT reported as complete — neither one written
        // before K3, nor one whose payload never answered. Saying nothing is the honest answer.
        windows_without_marker: windowsNoMarker,
        // Named, not just counted: an unfinished window is a piece of tape nobody has read, and a
        // bare count would leave the reader unable to go back and re-ask for it.
        ...(incompleteWindows.length
          ? {
              incomplete: incompleteWindows.map((w) => ({
                from: new Date(w.from).toISOString(),
                to: new Date(w.to).toISOString(),
                start_ms: w.from,
                end_ms: w.to,
                stopped_early: w.stoppedEarly,
                segment_count: w.segmentCount,
              })),
            }
          : {}),
        ...(windowsOverlap ? { windows_overlap: true } : {}),
        ...(turnCuesWithoutWindow ? { turn_cues_without_window: turnCuesWithoutWindow } : {}),
      };

      // ---- marks and their windows ---------------------------------------------
      // The SAME rule arm A binds by: [this mark, the next mark), and the last mark of the day
      // gets LAST_MARK_WINDOW_MS. Reported, not re-derived differently.
      const marks = markCues.map((c, i) => {
        const from = ms(c.at);
        const next = markCues[i + 1];
        const to = next ? ms(next.at) : from + LAST_MARK_WINDOW_MS;
        const holds = whCues.filter((w) => (w.type === "pstart" || w.type === "pqm_called") && ms(w.at) >= from && ms(w.at) < to);
        // A mark that bound a clock shows the visit that clock opened; an unaccounted mark
        // opened its own visit, keyed on the mark's cue id.
        const bound = holds.length > 0
          ? holds.map((w) => visitByOpenedBy.get(w.source_ref ?? w.id)).find((v) => v !== undefined) ?? null
          : visitByOpenedBy.get(c.id) ?? null;
        return {
          cue_id: c.id,
          at: iso(c.at),
          in_tape: overlaps(spans, from, from + 1),
          window_from: new Date(from).toISOString(),
          window_to: new Date(to).toISOString(),
          window_holds: holds.length,
          bound_visit_id: holds.length > 0 ? bound?.id ?? null : null,
        };
      });
      const marksUnaccounted = marks.filter((m) => m.window_holds === 0).length;

      // ---- warehouse ------------------------------------------------------------
      const byType: Record<string, number> = {};
      for (const t of WAREHOUSE_CUE_TYPES) byType[t] = 0;
      let storedInTape = 0;
      let storedOutsideTape = 0;
      const inTapeDisagreements: Array<Record<string, unknown>> = [];
      for (const w of whCues) {
        byType[w.type] = (byType[w.type] ?? 0) + 1;
        const p = payloadOf(w.payload);
        const stored = typeof p.in_tape_window === "boolean" ? p.in_tape_window : null;
        if (stored === true) storedInTape++;
        else if (stored === false) storedOutsideTape++;
        // S6/§5: the STORED value is authoritative in the counts and is never recomputed in
        // place. The tape actually read is compared to it and a disagreement is NAMED.
        const observed = overlaps(spans, ms(w.at), ms(w.at) + 1);
        if (stored !== null && stored !== observed) {
          inTapeDisagreements.push({ cue_id: w.id, type: w.type, at: iso(w.at), stored_in_tape_window: stored, observed_in_tape: observed });
        }
      }

      // ---- how each warehouse event actually bound ------------------------------
      // One count said "bound to a visit", and it only ever meant OPENED one, so a day where
      // twelve notes closed a visit and four dx_events moved one to at_diagnostics reported 26
      // events as having done nothing. They did. Four buckets now, and EVERY event lands in
      // exactly one of them: the four sum to warehouse_total, which a test asserts, because
      // that identity is the entire point of the split.
      //
      // The visit row does not record WHICH note closed it, so the close is attributed rather
      // than looked up: each visit whose end_reason names a cue kind consumes one event of that
      // kind for the same person, earliest first. On this corpus that gives twelve closing
      // notes and one that found nothing, which is what happened.
      //
      // Precedence is opened → closed → moved, so an event that opened a visit is counted as an
      // opener even if it later moved the same one.
      const visitsByUid = new Map<string, VisitRow[]>();
      for (const v of visitRows) {
        if (!v.individual_uid) continue;
        const list = visitsByUid.get(v.individual_uid) ?? [];
        list.push(v);
        visitsByUid.set(v.individual_uid, list);
      }
      // (individual_uid, end_reason) → how many visits that pair closed. `end_reason` is the
      // arm's own vocabulary and 'pulse_note' is also a cue type, which is exactly how a close
      // is traced back to the event that caused it; 'day_rollover' names no cue and so matches
      // nothing, correctly.
      const closeBudget = new Map<string, number>();
      for (const v of visitRows) {
        if (!v.individual_uid || !v.end_reason) continue;
        const k = `${v.individual_uid}|${v.end_reason}`;
        closeBudget.set(k, (closeBudget.get(k) ?? 0) + 1);
      }

      let whOpened = 0;
      let whClosed = 0;
      let whMoved = 0;
      let whUnbound = 0;
      for (const w of whCues) {
        if (visitByOpenedBy.has(w.source_ref ?? w.id)) { whOpened++; continue; }
        const uid = typeof payloadOf(w.payload).individual_uid === "string" ? (payloadOf(w.payload).individual_uid as string) : null;
        if (!uid) { whUnbound++; continue; }
        const budgetKey = `${uid}|${w.type}`;
        const remaining = closeBudget.get(budgetKey) ?? 0;
        if (remaining > 0) { closeBudget.set(budgetKey, remaining - 1); whClosed++; continue; }
        // A MOVER changed a visit's state without opening or closing it. Arm A's only mover is
        // the dx_event, and its rule is exactly this: with no visit for the person it binds to
        // nothing, with one it opens the hole.
        if ((STATE_MOVING_CUE_TYPES as readonly string[]).includes(w.type) && visitsByUid.has(uid)) { whMoved++; continue; }
        whUnbound++;
      }

      // ---- the silence, from the CUE TIMELINE and never from visits (S6) --------
      // A gap wider than the threshold, between the warehouse and either the next warehouse
      // event or the EDGE OF THE TAPE. No visit is consulted, and none is invented to carry it.
      //
      // The edges are the point. An earlier build measured only the intervals BETWEEN
      // consecutive warehouse events, which meant the two loudest findings on this corpus were
      // invisible: a day with 5h 53m of tape whose warehouse knows about one hour of it
      // reported no silence, and a day with seven hours of tape and NO warehouse record at all
      // reported no silence either. Silence at the edge of a day is still silence.
      //
      // ONE threshold for all four kinds, deliberately — a second constant would be a second
      // thing to tune and a second thing to disagree about.
      const silence: Array<Record<string, unknown>> = [];
      const hasTape = firstPieceMs !== null && lastPieceMs !== null;
      const push = (edge: string, from: number, to: number) => {
        // A negative or zero interval is not a silence. That is not a guard against bad data:
        // on scratch OPD 7 the first warehouse event PRECEDES the tape and the last FOLLOWS
        // it, so both edges are genuinely negative and neither is a finding.
        if (to - from <= SILENCE_THRESHOLD_MS) return;
        silence.push({
          edge,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          duration_ms: to - from,
          tape_running: overlaps(spans, from, to),
        });
      };

      if (hasTape) {
        if (whCues.length === 0) {
          // No warehouse record for the whole recorded day. Never emitted alongside the other
          // kinds — there are no other kinds when there is nothing to sit between.
          push("whole_day", firstPieceMs!, lastPieceMs!);
        } else {
          push("leading", firstPieceMs!, ms(whCues[0]!.at));
          for (let i = 1; i < whCues.length; i++) push("between", ms(whCues[i - 1]!.at), ms(whCues[i]!.at));
          push("trailing", ms(whCues[whCues.length - 1]!.at), lastPieceMs!);
        }
      }

      // ---- reconciliation --------------------------------------------------------
      const visitsByState: Record<string, number> = {};
      const ambiguityCounts: Record<string, number> = {};
      const endReasonCounts: Record<string, number> = {};
      let belowConfidence = 0;
      for (const v of visitRows) {
        visitsByState[v.state] = (visitsByState[v.state] ?? 0) + 1;
        if (typeof v.confidence === "number" && v.confidence < LOW_CONFIDENCE_BELOW) belowConfidence++;
        // ambiguity is a COMMA-JOINED CLOSED SET: split it and count exact tokens. Anything
        // that is not in the set is counted under its own key so a stray value is visible
        // rather than silently folded away.
        if (v.ambiguity) for (const token of v.ambiguity.split(",").map((t) => t.trim()).filter(Boolean)) {
          ambiguityCounts[token] = (ambiguityCounts[token] ?? 0) + 1;
        }
        // end_reason answers why a visit ENDED, so only a closed visit is counted.
        if (v.state === "ended" && v.end_reason) endReasonCounts[v.end_reason] = (endReasonCounts[v.end_reason] ?? 0) + 1;
      }
      const unknownTokens = Object.keys(ambiguityCounts).filter((t) => !ALL_RULES_REASONS.includes(t));

      // Tier 2 §2.4. Summary is the SCOREBOARD — the counts and the disagreements an operator
      // reads to answer "did this day reconcile". `full` adds the per-row lists (visits, marks,
      // silence spans, sessions) behind those counts. `ok`, `degraded` and `parameters` ride both:
      // a number is not readable without the constants that produced it.
      const full = {
        ok: true,
        room_day_id: roomDayId,
        ist_date: day.ist_date,
        arm,
        room: {
          scratch_room_id: isScratch ? day.room_id : null,
          real_room_id: realRoom?.id ?? realRoomId ?? null,
          real_room_slug: realRoom?.slug ?? null,
          is_scratch: isScratch,
          ...(isScratch && !realRoom ? { note: "real room not found — tape sections are empty, not wrong" } : {}),
        },
        parameters: {
          last_mark_window_ms: LAST_MARK_WINDOW_MS,
          silence_threshold_ms: SILENCE_THRESHOLD_MS,
          low_confidence_below: LOW_CONFIDENCE_BELOW,
          stalled_badge_minutes: STALLED_BADGE_MINUTES,
          warehouse_cue_types: WAREHOUSE_CUE_TYPES,
          mark_cue_type: MARK_CUE_TYPE,
          turn_cue_types: TURN_CUE_TYPES,
          window_cue_type: WINDOW_CUE_TYPE,
          default_arm: DEFAULT_ARM,
        },
        tape: {
          sessions,
          first_piece_at: firstPieceMs === null ? null : new Date(firstPieceMs).toISOString(),
          last_piece_at: lastPieceMs === null ? null : new Date(lastPieceMs).toISOString(),
          total_recorded_ms: totalRecordedMs,
        },
        // The tape that was LISTENED TO, which is a different question from the tape that was
        // recorded above: `tape` is what the microphones produced, `turn_tape` is how much of it
        // anybody asked scribe_transcribe_range about and what came back. Its own section rather
        // than four more lines in `reconciliation` — reconciliation is where sources that should
        // agree are checked against each other, and there is nothing here to disagree with yet.
        turn_tape: turnTape,
        marks,
        warehouse: {
          by_type: byType,
          first_at: whCues.length ? iso(whCues[0]!.at) : null,
          last_at: whCues.length ? iso(whCues[whCues.length - 1]!.at) : null,
          in_tape: storedInTape,
          outside_tape: storedOutsideTape,
          ...(inTapeDisagreements.length ? { in_tape_window_disagreements: inTapeDisagreements } : {}),
        },
        visits: visitRows.map((v) => ({
          id: v.id,
          opened_by: v.opened_by,
          opened_by_kind: v.opened_by_kind,
          state: v.state,
          confidence: v.confidence,
          ambiguity: v.ambiguity,
          end_reason: v.state === "ended" ? v.end_reason : null,
          // S5 — the uid is the spine, and it stays out of the answer unless asked for.
          ...(includeIdentity ? { individual_uid: v.individual_uid } : {}),
        })),
        reconciliation: {
          marks_total: marks.length,
          marks_bound: marks.length - marksUnaccounted,
          marks_unaccounted: marksUnaccounted,
          warehouse_total: whCues.length,
          warehouse_opened_a_visit: whOpened,
          warehouse_closed_a_visit: whClosed,
          warehouse_moved_a_visit: whMoved,
          warehouse_unbound: whUnbound,
          // The four turn counters. speaker_matches is legitimately 0 until slice B writes one,
          // and a reported zero is not the same thing as a missing count.
          turns_total: turnCounts.stt_turn ?? 0,
          turn_silences: turnCounts.stt_silence ?? 0,
          speaker_matches: turnCounts.speaker_match ?? 0,
          turn_cues_total: turnCuesTotal,
          visits_total: visitRows.length,
          visits_by_state: visitsByState,
          visits_unknown: visitsByState.unknown ?? 0,
          visits_below_confidence_0_6: belowConfidence,
          ambiguity_counts: ambiguityCounts,
          end_reason_counts: endReasonCounts,
          ...(unknownTokens.length ? { ambiguity_tokens_outside_closed_set: unknownTokens } : {}),
          silence,
        },
        ...(degraded.length ? { degraded: true, degraded_reads: degraded } : {}),
      };
      if (argDetail(args) === "full") return full;
      // ─── §2.4 summary, corrected by the Refuter's (d) ────────────────────────────────────────
      // `silence` is NOT a top-level field: it lives at `reconciliation.silence`, so the first
      // version counted `full.silence` (always undefined) and reported silence_spans 0 on the very
      // day the section exists for — OPD 7's six-hour hole. It also left the whole spans array
      // riding inside `reconciliation`, so "summary" returned the widest list in the payload.
      //
      // The scoreboard IS the summary: every counter in `reconciliation` stays, the per-row lists
      // (visits, marks, tape.sessions, and the silence spans) become counts, and `parameters`
      // rides both widths because a number is not readable without the constants that produced it.
      const { silence: silenceSpans, ...reconciliationCounts } = full.reconciliation;
      const { visits, marks: markRows, tape: tapeFull, ...rest } = full;
      return {
        ...rest,
        reconciliation: reconciliationCounts,
        counts: {
          visits: visits.length,
          marks: markRows.length,
          silence_spans: silenceSpans.length,
          sessions: tapeFull.sessions.length,
        },
        tape: {
          first_piece_at: tapeFull.first_piece_at,
          last_piece_at: tapeFull.last_piece_at,
          total_recorded_ms: tapeFull.total_recorded_ms,
        },
      };
    }),
};

export const FUSE_REPORT_TOOLS: McpTool[] = [fuseReport];
