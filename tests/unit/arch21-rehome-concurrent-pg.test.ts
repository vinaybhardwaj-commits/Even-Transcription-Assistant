/**
 * Arch #21 re-check R4 (and R1/R5) on REAL postgres: late chunks of ONE reaped session, arriving at once (primary + backup lanes, retries), get exactly ONE
 * re-home session; two different reaped sessions never share a home; the home's bounds cover every piece. The route runs for real; only its R2 head, auth,
 * session lookup and window evaluation are stubbed.
 *
 * `sql.transaction` is shimmed over ASYNC docker/psql (one session per transaction: BEGIN … COMMIT), because the harness's own `sql` is synchronous and
 * could never overlap two transactions. A CONTROL run drops the advisory-lock statement and sleeps where the lock was, and must produce duplicates —
 * proof that this test can see the race it guards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  pg: null as null | { sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>; name: string },
  dropLock: false,
  sessions: new Map<string, { id: string; room_id: string; room_slug: string; started_at: string; status: string; ended_at: string; notes: string }>(),
}));

const quote = (v: unknown): string => (v === null || v === undefined ? "NULL" : `'${(v instanceof Date ? v.toISOString() : String(v)).replace(/'/g, "''")}'`);
const render = (text: string, values: unknown[]): string => text.replace(/\$(\d+)/g, (_m, n) => quote(values[Number(n) - 1]));

const lazy = (strings: TemplateStringsArray, values: unknown[]) => {
  let text = "";
  strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ""); });
  return {
    text, values,
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return H.pg!.sql(strings, ...values).then(res, rej); },
  };
};

vi.mock("@/lib/db", () => {
  const sql = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => lazy(s, v), {
    transaction: (qs: Array<{ text: string; values: unknown[] }>) =>
      new Promise<unknown[]>((resolve, reject) => {
        const parts = qs.map((q) => render(q.text, q.values).trim().replace(/;\s*$/, ""));
        const last = parts.length - 1;
        const body = parts
          .map((p, i) => {
            if (i === 0 && H.dropLock) return "SELECT 1";                                   // control: the advisory lock statement is dropped
            if (i === 1) return `${p};\nSELECT pg_sleep(0.6)`;                              // dwell AFTER the insert-if-none and BEFORE commit, so without the lock every transaction checks "none yet" before any commits
            return i === last ? `WITH u AS (${p}) SELECT coalesce(jsonb_agg(u), '[]'::jsonb) FROM u` : p;
          })
          .join(";\n");
        const child = execFile("docker", ["exec", "-i", H.pg!.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { maxBuffer: 1 << 24 }, (err, stdout) => {
          if (err) return reject(err);
          const lines = stdout.trim().split("\n").filter(Boolean);
          const rows = JSON.parse(lines[lines.length - 1] ?? "[]") as unknown[];
          resolve([[], [], rows]);
        });
        child.stdin!.end(`BEGIN;\n${body};\nCOMMIT;\n`);
      }),
  });
  return { sql };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_opd4" }) }));
vi.mock("@/lib/r2", () => ({ headObject: async () => ({ size: 100 }), benchChunkKey: (_r: string, _d: string, sid: string, idx: number, src: string) => `k/${sid}/${src}/${idx}` }));
vi.mock("@/lib/bench-window", () => ({ evaluateAndWriteWindows: async () => {}, istDateOf: () => "2026-10-07" }));
vi.mock("@/lib/bench", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findBenchSession: async (id: string) => H.sessions.get(id) ?? null,
}));
vi.mock("next/server", async (orig) => ({ ...((await orig()) as Record<string, unknown>), after: (fn: () => unknown) => { void Promise.resolve(fn()); } }));

const HAVE = dockerAvailable();
const pg = pgContainer("eta-arch21-rehome");
process.env.BENCH_CHUNK_REAPED_REPLIES = "1";   // the new replies / re-home are behind this server flag (default OFF)
const { POST } = await import("@/app/api/bench/chunks/route");

const reaped = (id: string) => ({ id, room_id: "room_opd4", room_slug: "opd-4", started_at: "2026-10-07T03:30:00.000Z", status: "ended", ended_at: "2026-10-07T06:56:31.000Z", notes: "auto-ended: no chunks >30m (reaper)" });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, label text, mic_label text, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, status text NOT NULL DEFAULT 'recording', notes text);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, idx int NOT NULL, source text NOT NULL DEFAULT 'primary', r2_key text, content_type text,
      started_at timestamptz, ended_at timestamptz, duration_ms int, size_bytes int, upload_state text, gap_before_ms int, peak_level real, avg_level real, created_at timestamptz DEFAULT now(),
      UNIQUE (session_id, source, idx));
    CREATE TABLE bench_event (id text PRIMARY KEY, session_id text NOT NULL, kind text NOT NULL, at timestamptz NOT NULL, brain_status text NOT NULL, payload jsonb, created_at timestamptz DEFAULT now());
  `);
  H.pg = { sql: pg.sql as never, name: pg.name };
  H.sessions.set("bs_A", reaped("bs_A"));
  H.sessions.set("bs_B", reaped("bs_B"));
}, 120_000);
afterAll(() => { if (HAVE) pg.stop(); });

const late = (sid: string, idx: number, source: "primary" | "backup", at: string) =>
  POST({ json: async () => ({ session_id: sid, idx, source, started_at: at, ended_at: at, duration_ms: 1000, size_bytes: 100, gap_before_ms: 0 }) } as never)
    .then((r) => r.json() as Promise<Record<string, unknown>>);
const homes = async (sid: string) => (await pg.sql`SELECT id, started_at, ended_at, status FROM bench_session WHERE notes = ${"re-homed after reap of " + sid}`) as Array<{ id: string; started_at: string; ended_at: string; status: string }>;

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("R4 — concurrent late chunks of one reaped session", () => {
  it("six at once (both lanes, retries) create exactly ONE ended home session and every piece lands in it", async () => {
    H.dropLock = false;
    const t = (m: number) => `2026-10-07T10:${String(m).padStart(2, "0")}:00.000Z`;
    const replies = await Promise.all([
      late("bs_A", 3, "primary", t(11)), late("bs_A", 3, "backup", t(11)), late("bs_A", 4, "primary", t(16)),
      late("bs_A", 4, "backup", t(16)), late("bs_A", 3, "primary", t(11)), late("bs_A", 5, "primary", t(21)),
    ]);
    const h = await homes("bs_A");
    expect(h).toHaveLength(1);
    expect(h[0]!.status).toBe("ended");
    expect(new Set(replies.map((r) => r.rehomed_session_id))).toEqual(new Set([h[0]!.id]));
    const rows = (await pg.sql`SELECT idx, source FROM bench_chunk WHERE session_id = ${h[0]!.id}`) as Array<{ idx: number; source: string }>;
    expect(rows.map((r) => `${r.source}:${r.idx}`).sort()).toEqual(["backup:90003", "backup:90004", "primary:90003", "primary:90004", "primary:90005"]);   // the retry of 3 is idempotent
    expect((await pg.sql`SELECT count(*)::int AS n FROM bench_chunk WHERE session_id = 'bs_A'`)[0]).toEqual({ n: 0 });                                    // nothing in the ended session
  }, 120_000);

  it("round 2 — a retry loop writes ONE chunk_rehomed event per piece (natural key: home session + source + rehomed idx)", async () => {
    const h = (await homes("bs_A"))[0]!;
    await late("bs_A", 3, "primary", "2026-10-07T10:11:00.000Z");
    await late("bs_A", 3, "primary", "2026-10-07T10:11:00.000Z");
    const n = (await pg.sql`SELECT count(*)::int AS n FROM bench_event WHERE session_id = ${h.id} AND kind = 'chunk_rehomed' AND payload->>'chunk_source' = 'primary' AND (payload->>'rehomed_idx')::int = 90003`)[0] as { n: number };
    expect(n.n).toBe(1);
    const all = (await pg.sql`SELECT count(*)::int AS n FROM bench_event WHERE session_id = ${h.id} AND kind = 'chunk_rehomed'`)[0] as { n: number };
    expect(all.n).toBe(5);   // primary 3,4,5 + backup 3,4 — one each, however many times each was sent
  }, 60_000);

  it("R5 — the home's bounds cover every piece that landed in it", async () => {
    const h = (await homes("bs_A"))[0]!;
    expect(new Date(h.started_at).toISOString()).toBe("2026-10-07T10:11:00.000Z");
    expect(new Date(h.ended_at).toISOString()).toBe("2026-10-07T10:21:00.000Z");
    await late("bs_A", 6, "primary", "2026-10-07T09:50:00.000Z");                       // an EARLIER piece arriving later widens the start
    const w = (await homes("bs_A"))[0]!;
    expect(new Date(w.started_at).toISOString()).toBe("2026-10-07T09:50:00.000Z");
    expect(new Date(w.ended_at).toISOString()).toBe("2026-10-07T10:21:00.000Z");
  }, 60_000);

  it("R1 — a second reaped session in the same room gets its OWN home, so idx 3 of each both survive", async () => {
    const r = await late("bs_B", 3, "primary", "2026-10-07T10:30:00.000Z");
    const a = (await homes("bs_A"))[0]!, b = (await homes("bs_B"))[0]!;
    expect(b.id).not.toBe(a.id);
    expect(r.rehomed_session_id).toBe(b.id);
    const keys = (await pg.sql`SELECT r2_key FROM bench_chunk WHERE idx = 90003 AND source = 'primary' ORDER BY r2_key`) as Array<{ r2_key: string }>;
    expect(keys.map((k) => k.r2_key)).toEqual(["k/bs_A/primary/3", "k/bs_B/primary/3"]);
  }, 60_000);

  it("CONTROL — without the advisory lock the same race creates duplicate homes (this test can see the bug it guards)", async () => {
    H.sessions.set("bs_C", reaped("bs_C"));
    H.dropLock = true;
    await Promise.all([3, 4, 5, 6].map((i) => late("bs_C", i, "primary", `2026-10-07T11:0${i}:00.000Z`)));
    H.dropLock = false;
    expect((await homes("bs_C")).length).toBeGreaterThan(1);
  }, 120_000);
});
