/**
 * nemotron-overflow-pg.test.ts — REQUIRED PROOF for the HF overflow on postgres:16 (migration 0147 + the store's claim and usage SQL):
 *   1. 0147 applies twice, registers once, defaults existing claims to 'box', and its CHECK refuses another machine;
 *   2. claimPending(…, 'hf') records machine = hf; a re-claim after the lease lapses takes the new machine; the default is box;
 *   3. overflowUsage: backlog = eligible unclaimed windows (not live-claimed, not answered); hf minutes = TODAY's (IST) ingested hf rows only;
 *      live unfinished hf claims count, finished or expired ones do not, box rows and claims never do;
 *   4. NEVER TWO WORKERS ON ONE WINDOW: a box claim and an hf claim racing for the same window give it to exactly one.
 * DOCKER: CI host only. All ids are fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-nemo-overflow");
const M147 = "db/migrations/0147_nemotron_claim_machine.sql";

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL, grid_aligned boolean NOT NULL DEFAULT false, clip_r2_key text, source_mic text);
`;
type Store = typeof import("@/lib/diarize-nemotron/store");
let store: Store;
const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
  const s = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  return (await H.sql!(s)) as T[];
};
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
/** A stored result row, minimal and valid. `receivedAt` is a SQL expression. */
const row = (id: string, machine: string, audioMs: number, receivedAt = "now()", status = "ok") =>
  `INSERT INTO diarize_nemotron_window (window_id, room_day_id, engine, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json,
     speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, received_at)
   VALUES ('${id}', 'rd_1', 'nemotron', 'm', 'r', '{}', 'h', 'wk', '${machine}', ${audioMs}, '[]', 0, 0, 0, 0, 'p', '${status}', ${receivedAt});`;

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  pg.exec(readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0140_diarize_nemotron.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0143_nemotron_lab.sql", "utf8"));
  // a claim that predates 0147 must read as box afterwards
  pg.exec(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until) VALUES ('bw_old', 'box-0', now() + interval '10 minutes');`);
  pg.exec(readFileSync(M147, "utf8"));
  pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_1', 'room_fake1', '2026-10-01');`);
  H.sql = pg.sql as never;
  store = await import("@/lib/diarize-nemotron/store");
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/nemotron-overflow-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0147", () => {
  it("applies a second time, registers once, and a pre-existing claim is box", async () => {
    pg.exec(readFileSync(M147, "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations WHERE version = 147"))[0]!.n).toBe(1);
    expect((await q<{ machine: string }>("SELECT machine FROM diarize_nemotron_claim WHERE window_id = 'bw_old'"))[0]!.machine).toBe("box");
    pg.exec(`DELETE FROM diarize_nemotron_claim;`);
  });
  it("the CHECK refuses any machine but box and hf", () => {
    expect(fails(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, machine) VALUES ('c1', 'w', now(), 'hf');`)).toBe("");
    expect(fails(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, machine) VALUES ('c2', 'w', now(), 'laptop');`)).toMatch(/claim_machine_chk/);
    pg.exec(`DELETE FROM diarize_nemotron_claim;`);
  });
});

describe.runIf(HAVE)("claimPending records the machine", () => {
  beforeEach(() => {
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim; DELETE FROM bench_window;
      INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key) VALUES
        ('bw_a', 's', 'rd_1', 1000, 901000, 'closed', true, 'clips/a'), ('bw_b', 's', 'rd_1', 2000, 902000, 'closed', true, 'clips/b');`);
  });
  it("default box; hf when asked; a re-claim after the lease lapses takes the new machine and bumps attempts", async () => {
    expect((await store.claimPending("box-1", 1)).map((w) => w.window_id)).toEqual(["bw_b"]);
    expect((await store.claimPending("hf-1", 1, "hf")).map((w) => w.window_id)).toEqual(["bw_a"]);
    expect(await q(`SELECT window_id, machine FROM diarize_nemotron_claim ORDER BY window_id`)).toEqual([
      { window_id: "bw_a", machine: "hf" }, { window_id: "bw_b", machine: "box" }]);
    pg.exec(`UPDATE diarize_nemotron_claim SET lease_until = now() - interval '1 second' WHERE window_id = 'bw_a';`);
    expect((await store.claimPending("box-1", 1)).map((w) => w.window_id)).toEqual(["bw_a"]);
    expect(await q(`SELECT machine, attempts, worker_id FROM diarize_nemotron_claim WHERE window_id = 'bw_a'`)).toEqual([{ machine: "box", attempts: 2, worker_id: "box-1" }]);
  });
  it("never two workers on one window: a box and an hf claim for the same window give it to exactly one", async () => {
    pg.exec(`DELETE FROM bench_window WHERE id = 'bw_b';`);
    const [a, b] = await Promise.all([store.claimPending("box-1", 8), store.claimPending("hf-1", 8, "hf")]);
    expect(a.length + b.length).toBe(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM diarize_nemotron_claim WHERE window_id = 'bw_a'`))[0]!.n).toBe(1);
  });
});

describe.runIf(HAVE)("overflowUsage", () => {
  beforeEach(() => {
    pg.exec(`DELETE FROM diarize_nemotron_window; DELETE FROM diarize_nemotron_claim; DELETE FROM bench_window;`);
  });
  const win = (id: string, o: { day?: string; state?: string; clip?: boolean } = {}) =>
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, state, grid_aligned, clip_r2_key)
             VALUES ('${id}', 's', '${o.day ?? "rd_1"}', 1000, 901000, '${o.state ?? "closed"}', true, ${o.clip === false ? "NULL" : `'clips/${id}'`});`);

  it("backlog counts eligible unclaimed windows only (the blind set is empty since 10 Oct, so there is no blind exclusion to prove)", async () => {
    win("bw_1"); win("bw_2"); win("bw_3"); win("bw_4"); win("bw_open", { state: "open" }); win("bw_noclip", { clip: false });
    pg.exec(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until) VALUES ('bw_2', 'w', now() + interval '10 minutes');`); // live claim: not backlog
    pg.exec(row("bw_3", "box", 900000)); // answered: not backlog
    pg.exec(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until) VALUES ('bw_4', 'w', now() - interval '1 minute');`); // expired claim, attempts left: backlog
    expect((await store.overflowUsage()).backlog).toBe(2); // bw_1, bw_4
  });

  it("hf minutes are TODAY's (IST) ingested hf rows only; box rows and other days do not count", async () => {
    pg.exec(row("a", "hf", 900000) + row("b", "hf", 300000) + row("c", "box", 900000));
    pg.exec(row("d", "hf", 900000, "now() - interval '2 days'"));
    const u = await store.overflowUsage();
    expect(u.hfIngestedMs).toBe(1_200_000);
  });

  it("the IST day boundary: a row at 00:30 IST today counts, one at 23:30 IST yesterday does not", async () => {
    const istMidnightUtc = `((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
    pg.exec(row("f", "hf", 900000, `${istMidnightUtc} + interval '30 minutes'`) + row("g", "hf", 600000, `${istMidnightUtc} - interval '30 minutes'`));
    // the first row is "today" only once IST 00:30 has passed; before that it is in the future, still the same IST date
    expect((await store.overflowUsage()).hfIngestedMs).toBe(900000);
  });

  it("live unfinished hf claims count; finished, expired and box claims do not", async () => {
    const claim = (id: string, machine: string, lease: string, done = "NULL") =>
      `INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, machine, done_at) VALUES ('${id}', 'w', ${lease}, '${machine}', ${done});`;
    pg.exec(claim("c1", "hf", "now() + interval '5 minutes'") + claim("c2", "hf", "now() + interval '5 minutes'") + claim("c3", "hf", "now() - interval '1 minute'")
      + claim("c4", "hf", "now() + interval '5 minutes'", "now()") + claim("c5", "box", "now() + interval '5 minutes'"));
    expect((await store.overflowUsage()).hfLiveClaims).toBe(2);
  });
});
