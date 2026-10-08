/**
 * Arch #16 guard (refuter ARCH-16 finding 2): the new-session POST ends ONLY this room's `recording` rows quiet for > STALLED_BADGE_MINUTES.
 * Runs the real route against real postgres, because a mocked sql can only regex the text and a `< now()` mutant (end every recording row) survives that.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_a" }) }));
const pg = pgContainer("eta-arch16-post");
const HAVE = dockerAvailable();
beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, label text, mic_label text, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, status text NOT NULL DEFAULT 'recording', notes text, created_by text, ist_date date);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO bench_session (id, room_id, started_at, status) VALUES
      ('bs_live', 'room_a', now() - interval '3 hours', 'recording'),
      ('bs_stale', 'room_a', now() - interval '4 hours', 'recording'),
      ('bs_fresh0', 'room_a', now() - interval '2 minutes', 'recording'),
      ('bs_paused', 'room_a', now() - interval '5 hours', 'paused'),
      ('bs_other', 'room_b', now() - interval '5 hours', 'recording');
    INSERT INTO bench_session (id, room_id, started_at, status, notes) VALUES
      ('bs_home', 'room_a', now() - interval '6 hours', 'recording', 're-homed after reap of bs_old');
    INSERT INTO bench_chunk (id, session_id, created_at) VALUES
      ('c1', 'bs_live', now() - interval '4 minutes'), ('c2', 'bs_live', now() - interval '9 minutes'),
      ('c3', 'bs_stale', now() - interval '45 minutes');
  `);
  H.sql = pg.sql as never;
}, 120_000);
afterAll(() => { if (HAVE) pg.stop(); });
describe("Arch #16 guard: POST /api/bench/sessions on real postgres", () => {
  it("REQUIRED PROOF ran, or was skipped deliberately", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
  it("ends only the >10 min quiet recording row of THIS room", async () => {
    if (!HAVE) return;
    const { POST } = await import("@/app/api/bench/sessions/route");
    await POST({ json: async () => ({}) } as never);
    const rows = (await pg.sql`SELECT id, status, ended_at, notes FROM bench_session ORDER BY id`) as Array<Record<string, unknown>>;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect(by.bs_live.status).toBe("recording");
    expect(by.bs_fresh0.status).toBe("recording");
    expect(by.bs_paused.status).toBe("paused");
    expect(by.bs_other.status).toBe("recording");
    expect(by.bs_stale.status).toBe("ended");
    expect(by.bs_home.status).toBe("recording");                       // Arch #21: a re-home container is never superseded...
    expect(by.bs_home.notes).toBe("re-homed after reap of bs_old");   // ...and its note is untouched
    expect(rows.filter((r) => r.status === "recording" && !["bs_live","bs_fresh0","bs_other","bs_home"].includes(String(r.id)))).toHaveLength(1); // the new one
  });
});
