/**
 * Arch #21 (merge gate, refuter-b): a re-home container ("re-homed after reap of <id>") is bookkeeping, never a session the room started. Four reads that look for
 * "a session after X" must skip it. Real postgres, bound parameters; each test fails when its clause is removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), real: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
// routes only the statement under test to postgres; every other statement answers "no rows"
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => {
    const text = s.join("?");
    return H.real!(text) ? H.sql!(s, ...v) : Promise.resolve([]);
  },
}));
vi.mock("@/lib/bench", () => ({ listBenchSessions: async () => [] }));
const HAVE = dockerAvailable();
const pg = pgContainer("eta-arch21-rehome");
const NOTE = "re-homed after reap of bs_old";

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, source text, status text NOT NULL, result jsonb, error text,
      created_at timestamptz NOT NULL, acked_at timestamptz);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, status text NOT NULL, notes text);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL);
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

const NOW = new Date();
const ago = (s: number) => `'${new Date(NOW.getTime() - s * 1000).toISOString()}'`;

describe.runIf(HAVE)("a re-home container is not a session the room started", () => {
  it("getRecentStartAttempts (lib/bench-commands.ts): a failed start with only a re-home session after it is NOT session_started; a real session is", async () => {
    H.real = (t) => /session_started/.test(t);
    const { getRecentStartAttempts } = await import("@/lib/bench-commands");
    pg.exec(`
      INSERT INTO bench_command VALUES ('c1', 'ra', 'start_day', 'kiosk', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)}), ('c2', 'rb', 'start_day', 'kiosk', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)});
      INSERT INTO bench_session VALUES ('home_a', 'ra', ${ago(595)}, ${ago(580)}, 'ended', '${NOTE}'), ('real_b', 'rb', ${ago(595)}, NULL, 'recording', NULL);
    `);
    const a = await getRecentStartAttempts("ra", NOW);
    const b = await getRecentStartAttempts("rb", NOW);
    expect(a[0]?.session_started).toBe(false);
    expect(b[0]?.session_started).toBe(true);
  });

  it("the steward's own reads (lib/steward/executor.ts getStewardAttemptsToday)", async () => {
    H.real = (t) => /session_started/.test(t);
    const { realStartDeps } = await import("@/lib/steward/executor");
    const __stewardAttemptsTodayForTest = (await realStartDeps()).getStewardAttemptsToday;
    pg.exec(`
      INSERT INTO bench_command VALUES ('s1', 'rc', 'start_day', 'steward', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)}), ('s2', 'rd', 'start_day', 'steward', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)});
      INSERT INTO bench_session VALUES ('home_c', 'rc', ${ago(595)}, ${ago(580)}, 'ended', '${NOTE}'), ('real_d', 'rd', ${ago(595)}, NULL, 'recording', NULL);
    `);
    const c = await __stewardAttemptsTodayForTest("rc", NOW);
    const d = await __stewardAttemptsTodayForTest("rd", NOW);
    expect(c.filter((x) => x.session_started)).toHaveLength(0);
    expect(d.filter((x) => x.session_started)).toHaveLength(1);
  });

  it("the Steward's sense read (lib/steward/sense.ts start_attempts)", async () => {
    H.real = (t) => /c\.source = 'steward'/.test(t) && /ANY/.test(t);
    const { senseAll } = await import("@/lib/steward/sense");
    pg.exec(`
      INSERT INTO bench_command VALUES ('n1', 're', 'start_day', 'steward', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)}), ('n2', 'rf', 'start_day', 'steward', 'acked', NULL, NULL, ${ago(600)}, ${ago(590)});
      INSERT INTO bench_session VALUES ('home_e', 're', ${ago(595)}, ${ago(580)}, 'ended', '${NOTE}'), ('real_f', 'rf', ${ago(595)}, NULL, 'recording', NULL);
    `);
    const roster = ["re", "rf"].map((room_id) => ({ room_id, room_name: room_id, machine: null })) as never;
    const out = await senseAll(pg.sql as never, NOW, roster, [], {});
    const att = (id: string) => out.get(id)?.start_attempts ?? [];
    expect(att("re").filter((x) => x.session_started)).toHaveLength(0);
    expect(att("rf").filter((x) => x.session_started)).toHaveLength(1);
  });

  it("the watchdog's start_died read (lib/room-watchdog.ts): a re-home session is not a NEWER session that hides a dead start", async () => {
    H.real = (t) => /NOT EXISTS \(SELECT 1 FROM bench_chunk/.test(t);
    const W = await import("@/lib/room-watchdog");
    const diedAt = NOW.getTime() - 5 * 60_000; // ended 5 min ago: inside the death window, past the retry grace
    const t = (ms: number) => `'${new Date(ms).toISOString()}'`;
    pg.exec(`
      INSERT INTO bench_session VALUES ('dead_g', 'rg', ${t(diedAt - 15_000)}, ${t(diedAt)}, 'ended', NULL), ('home_g', 'rg', ${t(diedAt - 5_000)}, ${t(diedAt - 1_000)}, 'ended', '${NOTE}');
      INSERT INTO bench_chunk VALUES ('hc_g', 'home_g');
      INSERT INTO bench_session VALUES ('dead_h', 'rh', ${t(diedAt - 15_000)}, ${t(diedAt)}, 'ended', NULL), ('retry_h', 'rh', ${t(diedAt + 30_000)}, NULL, 'recording', NULL);
    `);
    const found = await W.readDeadStarts();
    expect(found).toContain("rg");      // the re-home container does not hide it
    expect(found).not.toContain("rh");  // a real retry still clears it
  });
});
