/**
 * The room diarize ENQUEUER (lib/stt/diarize-job.ts), against a mocked database.
 *
 * This used to test a pass that diarized windows inline and wrote three tables. C2 moved the work
 * onto the diarize_window job and deleted the cluster and turn writers, so what is left to prove is
 * narrow and load-bearing: the gate is a TRUE no-op, the scan still means "not yet diarized", a
 * window already queued is not queued again, a degraded read is recorded rather than swallowed, and
 * nothing here writes a row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];
const submitted: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  },
}));
vi.mock("@/lib/jobs/submit", () => ({
  submitJob: async (i: Record<string, unknown>) => { submitted.push(i); return { id: `job_${submitted.length}` }; },
}));

const { enqueueDiarizeWindows } = await import("@/lib/stt/diarize-job");

const ENV = ["ROOM_DIARIZE_ENABLED", "SPEAKER_CLUSTERS_ENABLED", "SPEAKER_MATCH_THRESHOLD"];
let saved: Record<string, string | undefined> = {};
const silent = () => {};

beforeEach(() => {
  calls.length = 0; responses = []; submitted.length = 0;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete (process.env as Record<string, string | undefined>)[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
});

describe("the gate off is a TRUE no-op", () => {
  it("no database work at all, not even the scan, and nothing enqueued", async () => {
    const r = await enqueueDiarizeWindows({ log: silent, actor: "cron:test" });
    expect(r.enabled).toBe(false);
    expect(r.scanned).toBe(0);
    expect(calls).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("this is the shipped state — the cron is scheduled but inert", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const entry = vercel.crons.find((c) => c.path === "/api/admin/diarize-windows");
    expect(entry).toBeDefined();
    expect(entry!.schedule).toBe("*/5 * * * *");
  });
});

describe("ROOM_DIARIZE_ENABLED — one name, and the retired one is ignored LOUDLY", () => {
  it("the DOCUMENTED truthy values enable it — case-insensitive, whitespace trimmed", async () => {
    const { roomDiarizeEnabled, ROOM_DIARIZE_TRUTHY } = await import("@/lib/stt/diarize-job");
    const quiet = () => {};
    expect([...ROOM_DIARIZE_TRUTHY]).toEqual(["1", "true", "yes", "on"]);
    for (const v of ["1", " 1", "1\n", "true", "TRUE", " True ", "yes", "YES", "on", "On"]) {
      expect(roomDiarizeEnabled({ ROOM_DIARIZE_ENABLED: v }, quiet), `value ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("the documented falsy values, and unset, disable it", async () => {
    const { roomDiarizeEnabled } = await import("@/lib/stt/diarize-job");
    const quiet = () => {};
    for (const v of [undefined, "", "   ", "0", "false", "FALSE", "no", "off", " Off "]) {
      expect(roomDiarizeEnabled({ ROOM_DIARIZE_ENABLED: v }, quiet), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("an UNRECOGNISED value FAILS LOUDLY — it is never read as off", async () => {
    const { roomDiarizeEnabled, FlagValueError } = await import("@/lib/stt/diarize-job");
    const quiet = () => {};
    for (const v of ["2", "enabled", "y", "tru", "1 1", "o n", "-1"]) {
      expect(() => roomDiarizeEnabled({ ROOM_DIARIZE_ENABLED: v }, quiet), `value ${JSON.stringify(v)}`).toThrow(FlagValueError);
    }
    // The enqueue surfaces it as a throw (the route makes it a non-2xx), with no database work.
    process.env.ROOM_DIARIZE_ENABLED = "enabled";
    await expect(enqueueDiarizeWindows({ log: silent, actor: "cron:test" })).rejects.toThrow(/unrecognised value/);
    expect(calls).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("the OLD name set to 1 does NOT turn it on — and says so, rather than being silently read", async () => {
    const { roomDiarizeEnabled } = await import("@/lib/stt/diarize-job");
    const lines: string[] = [];
    const on = roomDiarizeEnabled({ SPEAKER_CLUSTERS_ENABLED: "1" }, (m) => lines.push(m));
    expect(on, "a stale setting must not keep the path alive").toBe(false);
    expect(lines.join("\n"), "the operator who set it must be told it is ignored").toMatch(/SPEAKER_CLUSTERS_ENABLED is set and is IGNORED/);
    expect(lines.join("\n")).toMatch(/ROOM_DIARIZE_ENABLED/);
  });

  it("no production code reads the retired name for behaviour", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let hits = "";
    try { hits = execFileSync("grep", ["-rn", "SPEAKER_CLUSTERS_ENABLED", "lib", "app"], { encoding: "utf8" }); } catch { hits = ""; }
    // The only permitted mentions are the retirement constant and comments naming the rename.
    const offenders = hits.split("\n").filter(Boolean).filter((l) => !/RETIRED_ENV|renamed|Renamed/.test(l));
    expect(offenders, "a behavioural read of the old name is a second switch").toEqual([]);
  });
});

describe("the enqueue", () => {
  beforeEach(() => { process.env.ROOM_DIARIZE_ENABLED = "1"; });

  it("one diarize_window job per eligible window, with the window id and the caller as actor", async () => {
    responses = [[{ id: "bw_1" }, { id: "bw_2" }]];
    const r = await enqueueDiarizeWindows({ log: silent, actor: "cron:test" });
    expect(r.enqueued).toEqual([{ window_id: "bw_1", job_id: "job_1", retry_of_attempt: null }, { window_id: "bw_2", job_id: "job_2", retry_of_attempt: null }]);
    expect(submitted.map((s) => s.kind)).toEqual(["diarize_window", "diarize_window"]);
    expect(submitted[0]!.args).toEqual({ window_id: "bw_1" });
    expect(submitted[0]!.actor).toBe("cron:test");
  });

  it("the scan means NOT YET DIARIZED or FAILED WITH ATTEMPTS LEFT, and NOT ALREADY QUEUED", async () => {
    responses = [[]];
    await enqueueDiarizeWindows({ log: silent, actor: "cron:test" });
    const scan = calls[0]!.text;
    const { DIARIZE_MAX_ATTEMPTS } = await import("@/lib/stt/diarize-job");
    expect(scan).toMatch(/d\.window_id IS NULL OR \(d\.state = 'failed' AND d\.attempts < \?\)/);
    expect(calls[0]!.values).toContain(DIARIZE_MAX_ATTEMPTS);
    // The behavioural proof of the bound is the real-postgres retry test in c2-e2e-runner.test.ts.
    // A job does not write its row until it finishes, so without this clause a backlog longer than
    // one tick would enqueue the same window again every five minutes.
    expect(scan).toMatch(/j\.kind = 'diarize_window'/);
    expect(scan).toMatch(/j\.status IN \('queued', 'running'\)/);
  });

  it("a DEGRADED READ is recorded, not swallowed — it must not look like 'nothing eligible'", async () => {
    responses = [new Error("brain pool gone")];
    const r = await enqueueDiarizeWindows({ log: silent, actor: "cron:test" });
    expect(r.enqueued).toHaveLength(0);
    expect(r.errors.length, "the required sink is what makes an empty result honest").toBeGreaterThan(0);
    expect(r.errors[0]).toContain("bench_window scan");
  });

  it("it WRITES NOTHING — every table has its one writer on the job", () => {
    const src = codeOf("lib/stt/diarize-job.ts");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe("the calibration route writes nothing", () => {
  const src = readFileSync("app/api/admin/speaker-calibration/route.ts", "utf8");
  const code = codeOf("app/api/admin/speaker-calibration/route.ts");

  it("no write verb, no write SQL", () => {
    expect(code).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("it runs the SHIPPED matcher, not a re-implementation", () => {
    expect(src).toContain("sweepThreshold");
    const sweepSrc = codeOf("lib/stt/speaker-clusters.ts");
    expect(sweepSrc).toContain("matchCluster(e, clusters, threshold)");
    expect(sweepSrc).toContain("runningMean(cl.centroid, cl.count, e)");
  });

  it("it defaults to the 24 Aug Cardiology session PRD §7 names", () => {
    // The constant moved into the lib (a Next.js route may export only handlers and config); the
    // assertion follows the rule, not the file.
    expect(readFileSync("lib/stt/speaker-clusters.ts", "utf8")).toContain('CALIBRATION_SESSION_ID = "bs_z3gpbh6e"');
    expect(src).toContain("CALIBRATION_SESSION_ID");
  });

  it("auth is the Build 2/3 admin pattern", () => {
    expect(src).toContain("MIGRATION_SECRET");
    expect(src).toContain("verifyAdminJwt");
    expect(src).toContain('respondError("AUTH_REQUIRED"');
  });
});

describe("the migration", () => {
  const sql = readFileSync("db/migrations/0074_room_diarize.sql", "utf8");

  it("records itself and is additive only", () => {
    expect(sql).toContain("(74, '0074_room_diarize')");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE speaker_cluster/i);
  });

  it("speaker_cluster keeps exactly the shape 0042 gave it", () => {
    const ddl = sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim())
      .filter((s) => /^(CREATE|ALTER|DROP)\b/i.test(s));
    for (const stmt of ddl) expect(stmt).not.toMatch(/ALTER TABLE speaker_cluster/i);
  });

  it("the three new tables are the whole of it", () => {
    for (const t of ["room_diarize_window", "room_speaker_cluster_member", "room_turn_speaker"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });

  it("the turn binding is keyed on source_ref, which survives a re-drain", () => {
    expect(sql).toContain("PRIMARY KEY (window_id, source_ref)");
  });
});

describe("the brain reports clustering NOT RUNNING — it is not silently empty", () => {
  it("readGraph states running:false with a named reason, and never queries speaker_cluster", async () => {
    const { readGraph, CLUSTERING_STATUS } = await import("@/lib/brain/state");
    const seen: string[] = [];
    // The brain's own query interface. It answers visits, and FAILS THE TEST if anything asks for
    // speaker_cluster — an empty answer from that table is exactly the accident this replaced.
    const q = {
      query: async (text: string) => {
        seen.push(text);
        if (/speaker_cluster/i.test(text)) throw new Error("speaker_cluster was queried — it has no writer");
        return { rows: [] };
      },
    };
    const g = await readGraph(q as never, "room_1", "2026-09-10", "rd_1");

    expect(g.clustering.running, "a caller must be able to tell 'not running' from 'ran, found nobody'").toBe(false);
    expect(g.clustering.reason).toBe("clustering_not_running");
    expect(g.clustering).toEqual(CLUSTERING_STATUS);
    expect(g.clusters).toEqual([]);
    expect(seen.some((t) => /speaker_cluster/i.test(t)), "the empty answer is deliberate, not a query result").toBe(false);
  });

  it("with no room_day the status is still stated, not left for the caller to infer", async () => {
    const { readGraph } = await import("@/lib/brain/state");
    const g = await readGraph({ query: async () => ({ rows: [] }) } as never, "room_1", "2026-09-10", null);
    expect(g.clustering.running).toBe(false);
  });

  it("NOTHING in lib/ or app/ still queries speaker_cluster", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let hits = "";
    try { hits = execFileSync("grep", ["-rnE", "FROM speaker_cluster|JOIN speaker_cluster|INTO speaker_cluster|UPDATE speaker_cluster", "lib", "app"], { encoding: "utf8" }); }
    catch { hits = ""; }
    expect(hits.trim(), "a reader of a table with no writer is how [] passed for an answer").toBe("");
  });
});
