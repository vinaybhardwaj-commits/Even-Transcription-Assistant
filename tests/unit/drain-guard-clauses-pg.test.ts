/**
 * DRAIN-GUARD D-G1: blindWindowIds on a real postgres:16 (ALL migrations), each clause pinned ALONE by a window only that clause can catch, so removing any one clause changes the set.
 * Held-out: w_rts (turn row only), w_txt (window text only), w_emo (emotion row only), w_sibrts + w_sib (a CLEAN window whose session holds a held-out one: the whole-session clause),
 * w_cross (previous-day session that runs past midnight into the held-out day: the session-span clause), w_bd (session on the held-out day, window itself placed on a clean day).
 * Kept: w_ok, w_prev (same room, day before, ends before midnight), w_next (day after).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v), { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-drain-guard-clauses");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const PREV = addDay(BD, -1), NEXT = addDay(BD, 1), CLEAN_DAY = "2026-10-05";
const ist = (d: string, hhmm: string) => new Date(Date.parse(`${d}T${hhmm}:00+05:30`)).toISOString();

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  const win = (id: string, session: string, rd: string, n: number) => `('${id}', '${session}', '${rd}', ${n * 1000}, ${n * 1000 + 900}, 'primary', 'closed')`;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('${BR}', 'blind-room', 'Blind Room', 'x'), ('r_clean', 'clean-room', 'Clean Room', 'x');
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_blind', '${BR}', '${BD}'), ('rd_prev', '${BR}', '${PREV}'), ('rd_next', '${BR}', '${NEXT}'), ('rd_clean', 'r_clean', '${CLEAN_DAY}');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES
      ('s_rts', 'r_clean', '${CLEAN_DAY}T01:00:00Z', '${CLEAN_DAY}T02:00:00Z', 'ended'),
      ('s_txt', 'r_clean', '${CLEAN_DAY}T03:00:00Z', '${CLEAN_DAY}T04:00:00Z', 'ended'),
      ('s_emo', 'r_clean', '${CLEAN_DAY}T05:00:00Z', '${CLEAN_DAY}T06:00:00Z', 'ended'),
      ('s_sib', 'r_clean', '${CLEAN_DAY}T07:00:00Z', '${CLEAN_DAY}T08:00:00Z', 'ended'),
      ('s_ok', 'r_clean', '${CLEAN_DAY}T09:00:00Z', '${CLEAN_DAY}T10:00:00Z', 'ended'),
      ('s_bd', '${BR}', '${ist(BD, "10:00")}', '${ist(BD, "11:00")}', 'ended'),
      ('s_cross', '${BR}', '${ist(PREV, "22:00")}', '${ist(BD, "02:00")}', 'ended'),
      ('s_prev', '${BR}', '${ist(PREV, "10:00")}', '${ist(PREV, "11:00")}', 'ended'),
      ('s_next', '${BR}', '${ist(NEXT, "10:00")}', '${ist(NEXT, "11:00")}', 'ended');
    INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES
      ('bc_cross', 's_cross', 0, 'bench/k_cross', 'audio/webm', '${ist(PREV, "22:00")}', '${ist(BD, "02:00")}', 14400000, 1000, 'verified');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, state) VALUES
      ${[win("w_rts", "s_rts", "rd_clean", 1), win("w_txt", "s_txt", "rd_clean", 2), win("w_emo", "s_emo", "rd_clean", 3), win("w_sibrts", "s_sib", "rd_clean", 4), win("w_sib", "s_sib", "rd_clean", 5),
         win("w_ok", "s_ok", "rd_clean", 6), win("w_bd", "s_bd", "rd_prev", 7), win("w_cross", "s_cross", "rd_prev", 8), win("w_prev", "s_prev", "rd_prev", 9), win("w_next", "s_next", "rd_next", 10)].join(",\n      ")};
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, room_day_id, no_role_reason) VALUES ('w_rts', 'r1', 0, 'rd_blind', 'no_match'), ('w_sibrts', 'r2', 0, 'rd_blind', 'no_match');
    INSERT INTO jev_window_text (window_id, room_day_id, source, char_count) VALUES ('w_txt', 'rd_blind', 'empty', 0);
    INSERT INTO room_span_emotion (window_id, diarize_run_id, run_start_ms, run_end_ms, chunk_idx, chunk_count, segment_start_ms, segment_end_ms, room_day_id, speaker_idx, source_refs, clip_start_s, clip_end_s, state, reason)
      VALUES ('w_emo', 'run1', 0, 1000, 0, 1, 0, 1000, 'rd_blind', 0, ARRAY['r3'], 0, 1, 'skipped', 'x');
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("blindWindowIds: every clause alone", () => {
  it("holds out exactly the windows only one clause each can catch, and keeps the neighbours of the held-out day", async () => {
    const { blindWindowIds } = await import("@/lib/room-access/check");
    expect((await blindWindowIds()).sort()).toEqual(["w_bd", "w_cross", "w_emo", "w_rts", "w_sib", "w_sibrts", "w_txt"]);
  });
});
