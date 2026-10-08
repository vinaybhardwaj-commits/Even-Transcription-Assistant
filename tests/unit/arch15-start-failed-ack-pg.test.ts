/**
 * Arch #15 (arch-refuter-a pin b): lib/bench.ts listBenchSessions' `start_failed_ack` EXISTS, on REAL postgres. The window is [started_at - 1 min,
 * COALESCE(ended_at, now()) + 3 min], the command must be a start_day, and it must be `failed`. One room per case so cases cannot see each other.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
const HAVE = dockerAvailable();
const pg = pgContainer("eta-arch15-ack");

// session 2026-10-05 03:30:00Z .. 03:30:15Z; an ack is placed at an offset from the start (s) or the end (e)
const S = "2026-10-05T03:30:00Z";
const E = "2026-10-05T03:30:15Z";
const CASES: Array<{ room: string; kind: string; status: string; ackAt: string; want: boolean; why: string }> = [
  { room: "r_in_before", kind: "start_day", status: "failed", ackAt: "2026-10-05T03:29:00Z", want: true, why: "exactly 1 min before the start is inside" },
  { room: "r_out_before", kind: "start_day", status: "failed", ackAt: "2026-10-05T03:28:59Z", want: false, why: "61 s before the start is outside" },
  { room: "r_in_after", kind: "start_day", status: "failed", ackAt: "2026-10-05T03:33:15Z", want: true, why: "exactly 3 min after the end is inside" },
  { room: "r_out_after", kind: "start_day", status: "failed", ackAt: "2026-10-05T03:33:16Z", want: false, why: "181 s after the end is outside" },
  { room: "r_inside", kind: "start_day", status: "failed", ackAt: "2026-10-05T03:30:12Z", want: true, why: "the usual ack, a moment before the compensation ends the session" },
  { room: "r_kind", kind: "end_day", status: "failed", ackAt: "2026-10-05T03:30:12Z", want: false, why: "a failed end_day is not a failed start" },
  { room: "r_status", kind: "start_day", status: "acked", ackAt: "2026-10-05T03:30:12Z", want: false, why: "an acked start is not a failed start" },
  { room: "r_none", kind: "", status: "", ackAt: "", want: false, why: "no command at all" },
];

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  const rooms = CASES.map((c) => `('${c.room}', '${c.room}-slug', '${c.room}')`).join(",");
  const sessions = CASES.map((c) => `('bs_${c.room}', '${c.room}', '${S}', '${E}', 'ended', NULL)`).join(",");
  const cmds = CASES.filter((c) => c.kind).map((c, i) => `('cmd_${i}', '${c.room}', '${c.kind}', '${c.status}', '${c.ackAt}')`).join(",");
  pg.exec(`
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, label text, mic_label text, started_at timestamptz NOT NULL, ended_at timestamptz,
      status text NOT NULL, notes text);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, source text NOT NULL DEFAULT 'primary', upload_state text, size_bytes bigint,
      gap_before_ms int, created_at timestamptz DEFAULT now());
    CREATE TABLE bench_event (id text PRIMARY KEY, session_id text NOT NULL, kind text NOT NULL);
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, status text NOT NULL, acked_at timestamptz);
    INSERT INTO room (id, slug, name) VALUES ${rooms};
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status, notes) VALUES ${sessions};
    INSERT INTO bench_command (id, room_id, kind, status, acked_at) VALUES ${cmds};
  `);
  H.sql = pg.sql as never;
}, 120_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("listBenchSessions.start_failed_ack on real postgres", () => {
  it("is true exactly where a FAILED start_day was acked inside [start - 1 min, end + 3 min], with the window edges inclusive", async () => {
    const { listBenchSessions } = await import("@/lib/bench");
    const rows = await listBenchSessions({});
    const by = new Map(rows.map((r) => [r.room_id, r.start_failed_ack === true]));
    for (const c of CASES) expect(by.get(c.room), `${c.room}: ${c.why}`).toBe(c.want);
  });
});
