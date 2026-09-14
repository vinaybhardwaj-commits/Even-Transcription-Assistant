/**
 * E11(a) — the EXACT comparison is guarded by what the real Whisper client emits, not by a hand fixture.
 *
 * The first E11 test guarded `full.error === EMPTY_TRANSCRIPT` with one typed string. The Refuter
 * deleted that row and `.includes()` survived; `.startsWith()` survived with the row present. So this
 * file drives the room_window job through the REAL `lib/whisper.ts` — only `fetch` is faked — and
 * takes every discriminating error from the client's own output: a 500 whose body is
 * `empty_transcript` becomes `http_500: empty_transcript` because the client builds it that way.
 *
 * `@/lib/whisper` is wrapped, not replaced: every call goes to the real client unless a test sets an
 * override, and the wrapper records what the real client returned so assertions compare against it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;

const DB = vi.hoisted(() => ({
  windowState: "transcribing", attemptWrites: 0, subjectDone: 0, routingReads: 0, runInserts: 0, lastError: null as string | null,
}));
const ROUTER = vi.hoisted(() => ({ submits: 0 }));
const CUES = vi.hoisted(() => ({ calls: 0 }));
/** `override` replaces the client's answer; `results` records every answer the room path received. */
const CLIENT = vi.hoisted(() => ({ override: null as Row | null, results: [] as Row[] }));

vi.mock("@/lib/db", () => {
  const sql = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window w JOIN bench_session"))
      return [{ id: "bw_1", session_id: "sess_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary",
                clip_r2_key: null, grid_aligned: true, room_id: "room_1", state: DB.windowState }];
    if (q.includes("FROM bench_chunk"))
      return [{ idx: 0, source: "primary", r2_key: "chunks/a.webm", content_type: "audio/webm",
                started_at: new Date(0).toISOString(), ended_at: new Date(900_000).toISOString(), upload_state: "uploaded" }];
    if (q.includes("UPDATE bench_window SET state = 'transcribed'")) { DB.windowState = "transcribed"; return []; }
    if (q.includes("UPDATE bench_window SET state = 'closed'")) { DB.windowState = "closed"; return []; }
    if (q.includes("FROM stt_routing")) { DB.routingReads += 1; return [{ engine_id: "route" }]; }
    if (q.includes("INSERT INTO transcription_run")) { DB.runInserts += 1; return []; }
    if (q.includes("SET attempts = attempts + 1")) { DB.attemptWrites += 1; DB.lastError = String(v[0]); return [{ attempts: 1 }]; }
    if (q.includes("UPDATE stt_subject_job SET state = 'done'")) { DB.subjectDone += 1; return []; }
    return [];
  };
  return { sql, db: {} };
});
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}`,
}));
vi.mock("@/lib/whisper", async (orig) => {
  const real = await orig<typeof import("@/lib/whisper")>();
  return {
    ...real,
    transcribeWithWhisper: async (...a: Parameters<typeof real.transcribeWithWhisper>) => {
      const r = (CLIENT.override ?? (await real.transcribeWithWhisper(...a))) as Row;
      CLIENT.results.push(r);
      return r;
    },
  };
});
vi.mock("@/lib/bench-join", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  joinServiceConfigured: () => true,
  callJoinService: async () => ({ ok: true, key: "clips/joined.webm" }),
}));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => true }));
vi.mock("@/lib/brain/db", () => ({ TOKEN_ENV: "BRAIN_SERVICE_TOKEN", getPool: () => ({}), query: async () => ({ rows: [], rowCount: 0 }) }));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));
vi.mock("@/lib/mcp/tools/bench", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeWindowCues: async () => { CUES.calls += 1; return { written: 1, deleted: 0, failed: 0, complete: true, window_recorded: true }; },
}));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async () => { ROUTER.submits += 1; return { ok: true, job_id: "rj_1" }; },
  pollRouteJob: async () => ({ ok: true, state: "running" }),
  routeTranscribe: async () => ({ ok: true }),
}));

const { EMPTY_TRANSCRIPT } = await import("@/lib/whisper-constants");
const { transcribeWithWhisper, WHISPER_RETRY_BACKOFF_MS } = await import("@/lib/whisper");
const ARGS = { window_id: "bw_1", origin: "https://x.test", actor: "admin_1", via: "admin_route" };

async function driveRoom() {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Row = {};
  const visited: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    visited.push(step);
    const out = await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
    if (out.kind === "done") return { visited, error: undefined as string | undefined };
    if (out.kind === "fail") return { visited, error: (out as { error: string }).error };
    progress = (out as { progress: Row }).progress;
    step = (out as { step: string }).step;
  }
  throw new Error(`did not settle: ${visited.join(" -> ")}`);
}

/** Every way the Mini can answer, as a fake fetch. The client turns each into its own error string. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const hangUntilAborted: Fetch = (_u, init) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const SERVER: Array<{ label: string; fetch: Fetch | null }> = [
  { label: "200, empty text (a quiet room)", fetch: async () => new Response(JSON.stringify({ text: "", segments: [], language: "en" }), { status: 200 }) },
  { label: "500, body empty_transcript", fetch: async () => new Response(EMPTY_TRANSCRIPT, { status: 500 }) },
  { label: "500, body upstream prose", fetch: async () => new Response("upstream exploded", { status: 500 }) },
  { label: "404, empty body", fetch: async () => new Response("", { status: 404 }) },
  { label: "200, body is not JSON (empty_transcript)", fetch: async () => new Response(EMPTY_TRANSCRIPT, { status: 200 }) },
  { label: "never answers (timeout)", fetch: hangUntilAborted },
  { label: "fetch throws (network)", fetch: async () => { throw new TypeError("fetch failed"); } },
  { label: "no WHISPER_BASE_URL", fetch: null },
];

let FETCH: Fetch = async () => { throw new Error("no fetch set"); };
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  Object.assign(DB, { windowState: "transcribing", attemptWrites: 0, subjectDone: 0, routingReads: 0, runInserts: 0, lastError: null });
  ROUTER.submits = 0; CUES.calls = 0; CLIENT.override = null; CLIENT.results = [];
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  process.env.WHISPER_BASE_URL = "https://whisper.test";
  vi.stubGlobal("fetch", (u: string, i: RequestInit) => FETCH(String(u), i));
  // The client's own clocks — the retry backoff and its 90 s / 180 s aborts — fire at once. Nothing
  // else is shortened, so vitest's own timers are untouched.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms === WHISPER_RETRY_BACKOFF_MS || ms === 90_000 || ms === 180_000 ? 0 : ms)) as typeof setTimeout);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const useServer = (s: (typeof SERVER)[number]) => {
  if (s.fetch) FETCH = s.fetch;
  else delete process.env.WHISPER_BASE_URL;
};

describe("E11(a) — what the real client emits, per way the server can answer", () => {
  it("one scenario per LISTED producer in lib/whisper.ts (a hand-kept list, not proof of every producer), and exactly ONE answer is the bare constant", async () => {
    const errors: string[] = [];
    for (const s of SERVER) {
      process.env.WHISPER_BASE_URL = "https://whisper.test";
      useServer(s);
      const r = await transcribeWithWhisper(new Uint8Array([1]), "audio/webm");
      expect(r.ok, s.label).toBe(false);
      errors.push((r as { error: string }).error);
    }
    // One of every producer in lib/whisper.ts — a scenario list that missed one would not be "every error".
    for (const prefix of ["whisper_base_url_missing", "http_", "timeout_", "network: ", EMPTY_TRANSCRIPT]) {
      expect(errors.some((e) => e.startsWith(prefix)), `no scenario produced ${prefix}`).toBe(true);
    }
    expect(errors.filter((e) => e === EMPTY_TRANSCRIPT), "only a 200 with no text is the bare constant").toHaveLength(1);
    // And the real client DOES emit the constant inside other errors — which is why equality must be exact.
    expect(errors.filter((e) => e !== EMPTY_TRANSCRIPT && e.includes(EMPTY_TRANSCRIPT)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("E11(a) — the room_window job, through the REAL client: silent iff the client said exactly EMPTY_TRANSCRIPT", () => {
  for (const s of SERVER) {
    it(s.label, async () => {
      useServer(s);
      const r = await driveRoom();
      const full = CLIENT.results[CLIENT.results.length - 1] as { ok: boolean; error?: string };
      expect(full.ok).toBe(false);
      if (full.error === EMPTY_TRANSCRIPT) {
        expect(r.error, "a quiet room finishes").toBeUndefined();
        expect(r.visited).toEqual(["prepare", "segment", "finish"]);
        expect(DB.attemptWrites).toBe(0);
        expect(DB.windowState).toBe("transcribed");
      } else {
        expect(r.error, `${full.error} must fail loudly`).toBe("room_window_failed: whisper_unavailable");
        expect(r.visited).toEqual(["prepare", "segment"]);
        expect(DB.attemptWrites).toBe(1);
        expect(DB.lastError, "the attempt is charged to the client's own error").toBe(`whisper_unavailable: ${full.error}`);
        expect(DB.windowState).toBe("closed");
        expect(CUES.calls, "no silence for a read that did not happen").toBe(0);
      }
      expect(ROUTER.submits + DB.routingReads + DB.runInserts, "never an engine").toBe(0);
    });
  }
});

describe("E11(a) — near misses: only the bare constant is silence", () => {
  // The real client cannot emit these today. They are derived from the constant, not typed, and they
  // exist for one reason: to fail `.startsWith()`, `.endsWith()` or a case-folded match, which no
  // string the client emits today can do.
  const NEAR = [`${EMPTY_TRANSCRIPT}_v2`, `${EMPTY_TRANSCRIPT}: detail`, `${EMPTY_TRANSCRIPT} `, ` ${EMPTY_TRANSCRIPT}`,
    `x_${EMPTY_TRANSCRIPT}`, EMPTY_TRANSCRIPT.toUpperCase()];
  for (const error of NEAR) {
    it(JSON.stringify(error), async () => {
      CLIENT.override = { ok: false, error, latency_ms: 1, attempts: 1 };
      const r = await driveRoom();
      expect(r.error).toBe("room_window_failed: whisper_unavailable");
      expect(DB.attemptWrites).toBe(1);
    });
  }
  it("control: the bare constant is silence", async () => {
    CLIENT.override = { ok: false, error: EMPTY_TRANSCRIPT, latency_ms: 1, attempts: 1 };
    const r = await driveRoom();
    expect(r.error).toBeUndefined();
    expect(DB.attemptWrites).toBe(0);
  });
});
