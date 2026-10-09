/**
 * REL2-R3 K3 on a real postgres:16 with ALL migrations applied (the refuter's repro fixtures, seeded through the real CHECKs): K3-1 the Bench session tools, K3-2 the job doors, K3-3 scratch ids, K3-4 aggregates.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
const R2 = vi.hoisted(() => ({ presign: 0, get: 0 }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => { R2.presign++; return "https://r2.example/x"; }, getObjectBytes: async () => { R2.get++; return new Uint8Array([1]); } }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rel2-r3-k3");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const ctx = { origin: "x", actor: "a", scopes: new Set(["read", "invoke", "write"]) } as never;
const call = async (name: string, args: Record<string, unknown>) => { const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface"); return (await CALLABLE_TOOLS.get(name)!.handler({ ...args }, ctx)) as Record<string, any>; };

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const files = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
});
afterAll(() => { if (HAVE) pg.stop(); });

const T = (ms: number) => new Date(ms).toISOString();
const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
const CLEAN_DAY = "2026-10-05";

function seed(): void {
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('${BR}', 'blind-room', 'Blind Room', 'x'), ('r_clean', 'clean-room', 'Clean Room', 'x');
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_blind', '${BR}', '${BD}'), ('rd_clean', 'r_clean', '${CLEAN_DAY}');
    -- bs_blind: a session on the held-out pair with a chunk (the refuter's K3-1 repro); bs_clean: a clean session; bs_win: clean room and day, one window placed on the held-out room-day
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES
      ('bs_blind', '${BR}', '${T(dayStart + 3_600_000)}', '${T(dayStart + 7_200_000)}', 'ended'),
      ('bs_clean', 'r_clean', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T05:00:00Z', 'ended'),
      ('bs_win', 'r_clean', '${CLEAN_DAY}T06:00:00Z', '${CLEAN_DAY}T07:00:00Z', 'ended');
    INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES
      ('bc_blind', 'bs_blind', 0, 'bench/k_blind', 'audio/webm', '${T(dayStart + 3_600_000)}', '${T(dayStart + 3_900_000)}', 300000, 1000, 'verified'),
      ('bc_clean', 'bs_clean', 0, 'bench/k_clean', 'audio/webm', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T04:05:00Z', 300000, 1000, 'verified'),
      ('bc_win', 'bs_win', 0, 'bench/k_win', 'audio/webm', '${CLEAN_DAY}T06:00:00Z', '${CLEAN_DAY}T06:05:00Z', 300000, 1000, 'verified');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES
      ('bw_blind', 'bs_blind', 'rd_blind', ${dayStart + 3_600_000}, ${dayStart + 4_500_000}, 'primary'),
      ('bw_win', 'bs_win', 'rd_blind', ${Date.parse(CLEAN_DAY + "T06:00:00Z")}, ${Date.parse(CLEAN_DAY + "T06:15:00Z")}, 'primary'),
      ('bw_clean', 'bs_clean', 'rd_clean', ${Date.parse(CLEAN_DAY + "T04:00:00Z")}, ${Date.parse(CLEAN_DAY + "T04:15:00Z")}, 'primary');
  `);
}

(HAVE ? describe : describe.skip)("K3-1 the Bench session tools on real SQL: a held-out session is not listed, reported, replayed, served or presigned", () => {
  beforeAll(() => { seed(); });
  it("scribe_list_sessions: by room + date the held-out session is absent and counted; the window-only session is excluded too; the clean one is listed; unfiltered lists only the clean one", async () => {
    const byPair = await call("scribe_list_sessions", { room_id: BR, ist_date: BD });
    expect(byPair.sessions).toEqual([]);
    expect(byPair.n_blind_excluded).toBe(1);
    const all = await call("scribe_list_sessions", {});
    expect(all.sessions.map((x: { id: string }) => x.id)).toEqual(["bs_clean"]);
    expect(all.n_blind_excluded).toBe(2); // bs_blind (its room and day) and bs_win (one window placed on a held-out room-day)
  });
  it("scribe_day_report: the held-out room + day is refused before any session read; a clean day lists its session; the window-only session is left out and counted", async () => {
    H.statements.length = 0;
    expect(await call("scribe_day_report", { room_id: BR, ist_date: BD })).toMatchObject({ sessions: [], error: "blind_room_day" });
    expect(H.statements.filter((t) => /FROM bench_session s/.test(t))).toEqual([]);
    const clean = await call("scribe_day_report", { room_id: "r_clean", ist_date: CLEAN_DAY, detail: "summary" });
    expect(clean.sessions.map((x: { session_id?: string; id?: string }) => x.session_id ?? x.id)).toEqual(["bs_clean"]);
    expect(clean.n_blind_excluded).toBe(1);
  });
  it("scribe_replay_session: refused with 0 event reads; scribe_get_session and scribe_get_recording (every mode, the refuter's repro): refused, 0 presigns", async () => {
    H.statements.length = 0; R2.presign = 0; R2.get = 0;
    expect(await call("scribe_replay_session", { session_id: "bs_blind" })).toMatchObject({ cues: [], error: "blind_room_day" });
    expect(await call("scribe_replay_session", { session_id: "bs_win" })).toMatchObject({ cues: [], error: "blind_room_day" });
    expect(H.statements.filter((t) => /FROM bench_event|FROM bench_chunk c WHERE|FROM bench_chunk\s+WHERE/.test(t) && !/FROM bench_session s WHERE/.test(t))).toEqual([]);
    for (const id of ["bs_blind", "bs_win"]) {
      expect(await call("scribe_get_session", { session_id: id }), id).toMatchObject({ session: null, error: "blind_room_day" });
      for (const mode of ["manifest", "timeline", "chunk", "zip"]) expect(await call("scribe_get_recording", { session_id: id, mode, chunk_idx: 0 }), `${id} ${mode}`).toMatchObject({ error: "blind_room_day" });
    }
    expect(R2).toEqual({ presign: 0, get: 0 });
    // the clean session is still served (the guard is not a blanket)
    expect(await call("scribe_get_session", { session_id: "bs_clean" })).toMatchObject({ session: { id: "bs_clean" } });
    expect((await call("scribe_get_recording", { session_id: "bs_clean", mode: "manifest" })).error).toBeUndefined();
    expect(R2.presign).toBeGreaterThan(0);
    expect(await call("scribe_replay_session", { session_id: "bs_clean" })).toMatchObject({ session_id: "bs_clean" });
  });
});
