/**
 * REL3-MF on a real postgres:16 (ALL migrations, seeded through the real CHECKs): GET /api/bench/sessions/{id}/manifest refuses the WHOLE session (403 blind_room_day) when ANY window of it is held
 * out by ANY placement, exactly like get_session (guardSessionSpan). A clean-day session whose window has turn rows on a held-out room-day was 200 before.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { FORMER_BLIND_PAIRS } from "../support/former-blind-pairs";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v), { transaction: async () => [] }) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/x" }));
vi.mock("@/lib/cookie", async (orig) => ({ ...((await orig()) as object), readAdminCookie: async () => "admin-cookie" }));
vi.mock("@/lib/auth", async (orig) => ({ ...((await orig()) as object), verifyAdminJwt: async () => ({ sub: "admin" }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-rel3-mf");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const CLEAN = "2026-10-05";
const man = async (id: string) => (await import("@/app/api/bench/sessions/[id]/manifest/route")).GET(new NextRequest("http://x/m"), { params: Promise.resolve({ id }) });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  const w = (id: string, s: string) => `('${id}', '${s}', 'rd_clean', ${Date.parse(`${CLEAN}T04:00:00Z`)}, ${Date.parse(`${CLEAN}T04:15:00Z`)}, 'primary')`;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash) VALUES ('${BR}', 'blind-room', 'Blind Room', 'x'), ('r_clean', 'clean-room', 'Clean Room', 'x');
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_blind', '${BR}', '${BD}'), ('rd_clean', 'r_clean', '${CLEAN}');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES
      ('bs_clean', 'r_clean', '${CLEAN}T04:00:00Z', '${CLEAN}T05:00:00Z', 'ended'),
      ('bs_turn', 'r_clean', '${CLEAN}T04:00:00Z', '${CLEAN}T05:00:00Z', 'ended');
    INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state) VALUES
      ('bc_clean', 'bs_clean', 0, 'bench/k_clean', 'audio/webm', '${CLEAN}T04:00:00Z', '${CLEAN}T04:05:00Z', 300000, 1000, 'verified'),
      ('bc_turn', 'bs_turn', 0, 'bench/k_turn', 'audio/webm', '${CLEAN}T04:00:00Z', '${CLEAN}T04:05:00Z', 300000, 1000, 'verified');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ${w("bw_clean", "bs_clean")}, ${w("bw_turn", "bs_turn")};
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, room_day_id, no_role_reason) VALUES ('bw_turn', 'r1', 0, 'rd_blind', 'no_match');
  `);
});
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("REL3-MF: the manifest route serves a session with a window whose turn rows sit on a formerly held-out day", () => {
  it("clean-day session whose window has turn rows on a formerly held-out room-day -> 200 with its chunk (lifted)", async () => {
    const res = await man("bs_turn");
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).chunks).toHaveLength(1);
  });
  it("the clean session -> 200 with its chunk", async () => {
    const res = await man("bs_clean");
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).chunks).toHaveLength(1);
  });
  it("a guard that cannot answer fails closed: 503, not 200", async () => {
    const keep = H.sql;
    H.sql = (async (s: TemplateStringsArray, ...v: unknown[]) => { if (s.join("?").includes("window_blind")) throw new Error("db down"); return keep!(s, ...v); }) as never;
    try { expect((await man("bs_clean")).status).toBe(503); } finally { H.sql = keep; }
  });
});
