/**
 * Build 4 §A — the room diarize pass, against a mocked database and a mocked Mini.
 *
 * The properties worth the mocking: the gate is a TRUE no-op (not a pass that reads first and
 * then declines), an unset threshold refuses BEFORE any cluster is written, a re-run cannot apply
 * the same voice to the same mean twice, and every diarize call goes through the one shared slot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { encodeCentroid, EMBEDDING_DIMS } from "@/lib/stt/speaker-clusters";

const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const calls: Array<{ text: string; values: unknown[] }> = [];
let responses: unknown[] = [];
const diarizeCalls: Array<{ label: string; at: number; done: number }> = [];
let diarizeImpl: (label: string) => Promise<unknown> = async () => ({ ok: false, error: "not_configured", retryable: false, timing: {} });

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? []);
  },
}));
vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1, 2, 3]) }));
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: unknown, opts: { encounterId: string }) => {
    const at = Date.now();
    const r = await diarizeImpl(opts.encounterId);
    diarizeCalls.push({ label: opts.encounterId, at, done: Date.now() });
    return r;
  },
}));

const { runRoomDiarizePass } = await import("@/lib/stt/diarize-job");

const vec = (seed: number) => {
  const v = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) v[i] = Math.sin(seed * 1.7 + i * 0.11);
  return v;
};
const emb = (seed: number) => encodeCentroid(vec(seed)).toString("base64");

const WINDOW = {
  id: "bw_1", session_id: "bs_x", room_day_id: "rd_1",
  start_ms: "1787553000000", end_ms: "1787553900000", clip_r2_key: "clips/bs_x/a-b-primary.webm",
};

const okDiarize = (speakers: unknown[]) => async () => ({
  ok: true,
  result: { speakers, transcript_segments: [{ start_ms: 0, end_ms: 10_000, speaker_idx: 0 }] },
  latencyMs: 10,
  timing: { wall_ms: 10 },
});

const ENV = ["SPEAKER_CLUSTERS_ENABLED", "SPEAKER_MATCH_THRESHOLD"];
let saved: Record<string, string | undefined> = {};
const silent = () => {};

beforeEach(() => {
  calls.length = 0; responses = []; diarizeCalls.length = 0;
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
  it("no database work at all, not even the scan", async () => {
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.enabled).toBe(false);
    expect(r.scanned).toBe(0);
    expect(calls).toHaveLength(0);
    expect(diarizeCalls).toHaveLength(0);
  });

  it("this is the shipped state — the cron is scheduled but inert", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const entry = vercel.crons.find((c) => c.path === "/api/admin/diarize-windows");
    expect(entry).toBeDefined();
    expect(entry!.schedule).toBe("*/5 * * * *");
  });
});

describe("an unset threshold refuses BEFORE anything is written", () => {
  it("gate on, threshold unset = loud error, no scan, no cluster", async () => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.enabled).toBe(true);
    expect(r.errors).toContain("threshold_unset");
    expect(calls.some((c) => c.text.includes("INSERT INTO speaker_cluster"))).toBe(false);
    expect(diarizeCalls).toHaveLength(0);
  });

  it("an INVALID threshold refuses the same way", async () => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    process.env.SPEAKER_MATCH_THRESHOLD = "2";
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.errors).toContain("threshold_invalid");
  });

  it("a DRY run needs no threshold — that is how the threshold gets chosen", async () => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: emb(1) }]);
    responses = [[WINDOW], []];
    const r = await runRoomDiarizePass({ log: silent, dry: true });
    expect(r.dry).toBe(true);
    expect(r.diarized).toBe(1);
    expect(r.clusters_created).toBe(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO speaker_cluster"))).toBe(false);
    expect(calls.some((c) => c.text.includes("INSERT INTO room_diarize_window"))).toBe(true);
  });
});

describe("the cluster writer", () => {
  beforeEach(() => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    process.env.SPEAKER_MATCH_THRESHOLD = "0.7";
  });

  it("an empty room-day opens a new cluster, kind='other'", async () => {
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: emb(1) }]);
    responses = [[WINDOW], [], [], [], [], []];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.clusters_created).toBe(1);
    const insert = calls.find((c) => c.text.includes("INSERT INTO speaker_cluster"))!;
    expect(insert.text).toContain("'other'");
    // Nothing computes the kind, and 'doctor' appears nowhere.
    expect(insert.text).not.toContain("doctor");
  });

  it("NOTHING in the writer can produce kind='doctor'", () => {
    const src = codeOf("lib/stt/diarize-job.ts");
    expect(src).not.toContain("doctor");
  });

  it("a matching sample UPDATES the centroid instead of opening a cluster", async () => {
    const same = emb(1);
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: same }]);
    responses = [
      [WINDOW],
      [],                                // markWindow: the room_diarize_window state row
      [{ id: "sc_existing", centroid: "\\x" + encodeCentroid(vec(1)).toString("hex"), n: 1 }],
      [{ cluster_id: "sc_existing" }],   // membership claimed
      [],                                // centroid UPDATE
      [], [],
    ];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.clusters_updated).toBe(1);
    expect(r.clusters_created).toBe(0);
    expect(calls.some((c) => c.text.includes("UPDATE speaker_cluster"))).toBe(true);
  });

  it("A RE-RUN CANNOT MOVE THE MEAN TWICE — the ledger conflict stops it", async () => {
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: emb(1) }]);
    responses = [
      [WINDOW],
      [],                                // markWindow: the room_diarize_window state row
      [{ id: "sc_existing", centroid: "\\x" + encodeCentroid(vec(1)).toString("hex"), n: 1 }],
      [],                                // membership INSERT conflicts → RETURNING is empty
      [], [],
    ];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.clusters_updated).toBe(0);
    expect(calls.some((c) => c.text.includes("UPDATE speaker_cluster"))).toBe(false);
  });

  it("the membership ledger is the idempotency key, ON CONFLICT DO NOTHING", async () => {
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: emb(1) }]);
    responses = [[WINDOW], [], [], [], [], []];
    await runRoomDiarizePass({ log: silent });
    const member = calls.find((c) => c.text.includes("INSERT INTO room_speaker_cluster_member"))!;
    expect(member.text).toContain("ON CONFLICT (window_id, speaker_idx) DO NOTHING");
  });

  it("a speaker with no usable embedding is skipped, not clustered on a guess", async () => {
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other" }]);
    responses = [[WINDOW], [], []];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.clusters_created).toBe(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO speaker_cluster"))).toBe(false);
  });

  it("a FAILED cluster read writes nothing — it must not fracture the day", async () => {
    diarizeImpl = okDiarize([{ idx: 0, label: "S0", type: "other", embedding_base64: emb(1) }]);
    responses = [[WINDOW], [], new Error("relation speaker_cluster does not exist")];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.clusters_created).toBe(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO speaker_cluster"))).toBe(false);
  });
});

describe("failures are named, visible, and do not block the queue", () => {
  beforeEach(() => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    process.env.SPEAKER_MATCH_THRESHOLD = "0.7";
  });

  it("a diarize failure writes state='failed' with its reason and moves on", async () => {
    diarizeImpl = async () => ({ ok: false, error: "http_500: boom", retryable: false, timing: {} });
    responses = [[WINDOW], []];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.failed).toBe(1);
    const mark = calls.find((c) => c.text.includes("INSERT INTO room_diarize_window"))!;
    expect(mark.values).toContain("failed");
    expect(mark.values.some((v) => String(v).includes("http_500"))).toBe(true);
  });

  it("NO SLOT is retryable — no row is written, so the next tick picks it up", async () => {
    diarizeImpl = async () => ({ ok: false, error: "diarize_busy_queue_wait_exceeded_120000ms", retryable: true, timing: {} });
    responses = [[WINDOW]];
    const r = await runRoomDiarizePass({ log: silent });
    expect(r.failed).toBe(0);
    expect(calls.some((c) => c.text.includes("INSERT INTO room_diarize_window"))).toBe(false);
  });

  it("the scan excludes windows that already have a diarize row", async () => {
    responses = [[]];
    await runRoomDiarizePass({ log: silent });
    expect(calls[0]!.text).toContain("NOT EXISTS");
    expect(calls[0]!.text).toContain("room_diarize_window");
  });
});

describe("admission control", () => {
  it("every diarize call goes through the shared slot, labelled as a room call", async () => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    process.env.SPEAKER_MATCH_THRESHOLD = "0.7";
    diarizeImpl = okDiarize([]);
    responses = [[WINDOW], []];
    await runRoomDiarizePass({ log: silent });
    expect(diarizeCalls[0]!.label).toMatch(/^room:bw_/);
  });

  it("windows are processed SEQUENTIALLY — never two Mini calls in flight", async () => {
    process.env.SPEAKER_CLUSTERS_ENABLED = "1";
    process.env.SPEAKER_MATCH_THRESHOLD = "0.7";
    let inFlight = 0;
    let maxInFlight = 0;
    diarizeImpl = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, result: { speakers: [], transcript_segments: [] }, latencyMs: 5, timing: {} };
    };
    responses = [
      [WINDOW, { ...WINDOW, id: "bw_2" }, { ...WINDOW, id: "bw_3" }],
      [], [], [],
    ];
    await runRoomDiarizePass({ log: silent });
    expect(diarizeCalls).toHaveLength(3);
    expect(maxInFlight).toBe(1);
  });

  it("the job uses the gate's room label helper rather than typing one", () => {
    const src = codeOf("lib/stt/diarize-job.ts");
    expect(src).toContain("roomDiarizeLabel(w.id)");
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
