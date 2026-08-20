/**
 * Fuse slice 2 — the scratch write.
 *
 * These tests run the WHOLE chain, not a slice of it: scribe_replay_write → postBrainCue →
 * the real POST /api/brain/cues handler → the real lib/brain/state SQL → a fake Postgres that
 * models the one thing the schema actually enforces, the PARTIAL unique index over
 * (session_id, type, at) WHERE source = 'replay'. `fetch` is stubbed to call the route handler
 * directly, so the guard under test is the guard that ships.
 *
 * The test that matters most is number 7. Six live callers use POST /api/brain/cues without a
 * room_day_id. If the scratch check ever ran on one of them, live cue writing would stop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The app handle (lib/db) — `room`, `bench_session`, `bench_event`
// ---------------------------------------------------------------------------

const appCalls: Array<{ text: string; values: unknown[] }> = [];
let appResponder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    return Promise.resolve(appResponder(text, values));
  },
}));

vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/x", getObjectBytes: async () => new Uint8Array() }));
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => ({ ok: true, transcript: "", language: "en", duration_seconds: 0, latency_ms: 0 }) }));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));

// ---------------------------------------------------------------------------
// The brain pool (lib/brain/db) — `room_day`, `cue`, and the locked transaction.
// classifyBrainError stays REAL: the route's error mapping is part of what is under test.
// ---------------------------------------------------------------------------

const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];

const runSql = (text: string, values: unknown[] = []) => {
  brainCalls.push({ text, values });
  const rows = brainResponder(text, values); // may throw — that is a DB fault, on purpose
  return { rows, rowCount: rows.length };
};

vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    brainLog: () => {},
    getPool: () => ({ connect: async () => ({ query: async (t: string, v?: unknown[]) => runSql(t, v ?? []), release: () => {} }) }),
    query: async (t: string, v?: unknown[]) => runSql(t, v ?? []),
  };
});

import { POST } from "@/app/api/brain/cues/route";
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";
import { SQL_CUE_INSERT, SQL_CUE_INSERT_SCRATCH } from "@/lib/brain/state";
import { scratchRoomDayIdFor, scratchRoomIdFor, scratchSlugFor, SCRATCH_PIN_HASH } from "@/lib/brain/scratch";

const tool = (name: string) => {
  const t = BENCH_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const ctx = { origin: "https://preview.example" };

// ---------------------------------------------------------------------------
// The world the fakes model
// ---------------------------------------------------------------------------

const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test" };
const SCRATCH_ROOM_ID = scratchRoomIdFor(ROOM.id); // room_scratch_t
const SCRATCH_DAY_ID = scratchRoomDayIdFor(SCRATCH_ROOM_ID, "2026-08-19"); // rd_scratch_t_20260819
const SESSION_ID = "bs_a";
const SESSION = {
  id: SESSION_ID, room_id: ROOM.id, label: null, mic_label: null,
  started_at: "2026-08-19T05:00:00Z", ended_at: null, status: "ended", notes: null,
  room_slug: ROOM.slug, room_name: ROOM.name,
};

const T0 = Date.parse("2026-08-19T05:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const EVENTS = [
  { id: "be_1", kind: "consult_mark", at: iso(T0 + 60_000), brain_status: "sent", payload: { source: "kiosk", note: "Dr Sharma" } },
  { id: "be_2", kind: "mic_primary_lost", at: iso(T0 + 120_000), brain_status: "sent", payload: { reason: "silence", idx: 1 } },
  { id: "be_3", kind: "mic_primary_restored", at: iso(T0 + 180_000), brain_status: "sent", payload: { reason: "audio_resumed", idx: 1 } },
  { id: "be_4", kind: "kiosk_tab_gone", at: iso(T0 + 240_000), brain_status: "sent", payload: {} }, // not replayable
  { id: "be_5", kind: "kiosk_remount_resumed", at: iso(T0 + 300_000), brain_status: "sent", payload: { silence_seconds: 12 } },
];
const REPLAYABLE = 4; // the five above minus kiosk_tab_gone

/** Rooms that exist in the fake `room` table, by id. */
let rooms: Map<string, Row>;
/** room_day rows by id, and a (room_id|ist_date) index — the UNIQUE the schema declares. */
let days: Map<string, Row>;
/** The cue table, keyed the way the PARTIAL unique index keys replay cues. */
let cues: Map<string, Row>;
/** (type, at) pairs the fake database refuses to insert — used to model a half-finished run. */
let failWrites: Set<string>;

const replayKey = (sessionId: unknown, type: unknown, at: unknown) => `${String(sessionId)}|${String(type)}|${new Date(String(at)).toISOString()}`;

function seed() {
  rooms = new Map([[ROOM.id, { ...ROOM, disabled_at: null }]]);
  days = new Map();
  cues = new Map();
  failWrites = new Set();
}

// --- the app-side fake -----------------------------------------------------

appResponder = () => [];

function appDb(text: string, values: unknown[]): Row[] {
  if (/FROM bench_session s/.test(text)) return String(values[0]) === SESSION_ID ? [SESSION] : [];
  if (/FROM bench_event/.test(text)) return EVENTS;
  if (/^SELECT id, slug, name, disabled_at FROM room WHERE id =/.test(text)) {
    const r = rooms.get(String(values[0]));
    return r ? [r] : [];
  }
  if (/^INSERT INTO room \(id, slug, name, pin_hash\)/.test(text)) {
    const [id, slug, name, pin] = values as string[];
    if (!rooms.has(id!)) rooms.set(id!, { id, slug, name, pin_hash: pin, disabled_at: null });
    return [];
  }
  return [];
}

// --- the brain-side fake ---------------------------------------------------

function brainDb(text: string, values: unknown[]): Row[] {
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return [];
  if (/pg_advisory_xact_lock/.test(text)) return [{ pg_advisory_xact_lock: null }];
  if (/SELECT 1 FROM room WHERE id =/.test(text)) return rooms.has(String(values[0])) ? [{ "?column?": 1 }] : [];

  // room_day by (room_id, ist_date) — the live SELECT and the scratch SELECT
  if (/FROM room_day WHERE room_id = \$1 AND ist_date = \$2::date/.test(text)) {
    const hit = [...days.values()].find((d) => d.room_id === values[0] && d.ist_date === values[1]);
    return hit ? [hit] : [];
  }
  if (/FROM room_day WHERE id = \$1/.test(text)) {
    const d = days.get(String(values[0]));
    return d ? [d] : [];
  }
  if (/^INSERT INTO room_day/.test(text)) {
    const [id, roomId, date] = values as string[];
    const scratch = /scratch\)/.test(text); // the scratch upsert names the column
    const existing = [...days.values()].find((d) => d.room_id === roomId && d.ist_date === date);
    if (existing) return [existing]; // ON CONFLICT … DO UPDATE … RETURNING, flag untouched
    const row = { id, room_id: roomId, doctor_id: null, ist_date: date, started_at: new Date(), ended_at: null, scratch };
    days.set(id!, row);
    return [row];
  }

  if (/^INSERT INTO cue/.test(text)) {
    const [id, roomDayId, type, payload, at, sessionId, source] = values as unknown[];
    if (failWrites.has(`${String(type)}|${new Date(String(at)).toISOString()}`)) {
      throw Object.assign(new Error("simulated write fault"), { code: "08006" });
    }
    const isScratch = /session_id, source/.test(text);
    if (isScratch && source === "replay") {
      const key = replayKey(sessionId, type, at);
      if (cues.has(key)) return []; // ON CONFLICT DO NOTHING → no row
      cues.set(key, { id, room_day_id: roomDayId, type, payload, at, session_id: sessionId, source });
    } else {
      cues.set(`live|${String(id)}`, { id, room_day_id: roomDayId, type, payload, at });
    }
    return [{ id, at: new Date(String(at)), created_at: new Date() }];
  }

  if (/FROM visit WHERE room_day_id/.test(text)) return [];
  if (/FROM speaker_cluster WHERE room_day_id/.test(text)) return [];
  return [];
}

// --- fetch → the real route handler ---------------------------------------

let posted: Row[] = [];

beforeEach(() => {
  seed();
  appCalls.length = 0;
  brainCalls.length = 0;
  posted = [];
  appResponder = appDb;
  brainResponder = brainDb;
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  delete process.env.BRAIN_BASE_URL;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)) as Row);
    return POST(new Request(String(url), { method: "POST", headers: init.headers as HeadersInit, body: String(init.body) }));
  });
});

const call = (name: string, args: Row) => tool(name).handler(args, ctx) as Promise<Row>;

/** POST the cue route directly, the way a live caller does. */
const postCue = async (body: Row) =>
  POST(new Request("https://preview.example/api/brain/cues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));

const cueInserts = () => brainCalls.filter((c) => /^INSERT INTO cue/.test(c.text));

// ===========================================================================

describe("1 — scribe_replay_session is untouched: same dry run, still writes nothing", () => {
  it("read scope, dry_run:true, wrote:'nothing', and not one write leaves the process", async () => {
    const t = tool("scribe_replay_session");
    expect(t.scope).toBe("read");
    const out = await call("scribe_replay_session", { session_id: SESSION_ID });
    expect(out).toMatchObject({ dry_run: true, wrote: "nothing", source: "replay", emitted: REPLAYABLE, total: REPLAYABLE, truncated: false });
    expect(out.natural_key).toEqual(["session_id", "type", "at"]);
    // the slice-1 shaping is unchanged: the excluded kind is absent, names are filtered out
    const list = out.cues as Array<Row>;
    expect(list.some((c) => c.type === "kiosk_tab_gone")).toBe(false);
    expect((list[0]!.payload as Row).note).toBeUndefined();
    // and nothing at all was written
    expect(posted).toHaveLength(0);
    expect(cues.size).toBe(0);
    expect(days.size).toBe(0);
    expect(rooms.size).toBe(1);
  });
});

describe("2 — scribe_replay_write writes each cue once, into the scratch day", () => {
  it("every cue lands with source 'replay' and the session's id, on a scratch room-day", async () => {
    const out = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(out).toMatchObject({ ok: true, written: REPLAYABLE, already_existed: 0, failed: 0, truncated: false, room_day_id: SCRATCH_DAY_ID });
    expect(tool("scribe_replay_write").scope).toBe("write");

    // every request named the scratch day, the session, and the replay source
    expect(posted).toHaveLength(REPLAYABLE);
    for (const p of posted) {
      expect(p.room_day_id).toBe(SCRATCH_DAY_ID);
      expect(p.session_id).toBe(SESSION_ID);
      expect(p.source).toBe("replay");
      expect(p.room_id).toBe(SCRATCH_ROOM_ID);
    }
    // the cue times are the events' own, not the clock, and the order is time order
    expect(posted.map((p) => p.at)).toEqual([iso(T0 + 60_000), iso(T0 + 120_000), iso(T0 + 180_000), iso(T0 + 300_000)]);
    // the write used the SCRATCH statement — the shared live one never ran
    expect(cueInserts()).toHaveLength(REPLAYABLE);
    expect(cueInserts().every((c) => c.text === SQL_CUE_INSERT_SCRATCH)).toBe(true);
    expect(cueInserts().some((c) => c.text === SQL_CUE_INSERT)).toBe(false);
    // and the rows carry the two new columns
    expect(cues.size).toBe(REPLAYABLE);
    for (const row of cues.values()) {
      expect(row.session_id).toBe(SESSION_ID);
      expect(row.source).toBe("replay");
      expect(row.room_day_id).toBe(SCRATCH_DAY_ID);
    }
    // the day it wrote to is a scratch day, and it is NOT the room's live day
    expect(days.get(SCRATCH_DAY_ID)).toMatchObject({ scratch: true, room_id: SCRATCH_ROOM_ID, ist_date: "2026-08-19" });
    expect([...days.values()].some((d) => d.room_id === ROOM.id)).toBe(false);
  });

  it("the payload is exactly what the dry run shows — names filtered, nothing added", async () => {
    const dry = (await call("scribe_replay_session", { session_id: SESSION_ID })).cues as Array<Row>;
    posted = [];
    await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(posted.map((p) => p.payload)).toEqual(dry.map((c) => c.payload));
    expect((posted[0]!.payload as Row).note).toBeUndefined(); // the operator's free text never leaves
  });
});

describe("3 — running it twice writes nothing the second time", () => {
  it("second run: written 0, already_existed 4, and the table is unchanged", async () => {
    const first = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(first).toMatchObject({ written: REPLAYABLE, already_existed: 0 });
    const snapshot = [...cues.keys()].sort();

    const second = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(second).toMatchObject({ ok: true, written: 0, already_existed: REPLAYABLE, failed: 0 });
    expect([...cues.keys()].sort()).toEqual(snapshot);
    expect(cues.size).toBe(REPLAYABLE);
  });
});

describe("4 — a day whose scratch flag is false is refused by name, and nothing is written", () => {
  it("not_a_scratch_day, 409, and no INSERT INTO cue is ever issued", async () => {
    days.set("rd_live", { id: "rd_live", room_id: ROOM.id, doctor_id: null, ist_date: "2026-08-19", started_at: new Date(), ended_at: null, scratch: false });
    brainCalls.length = 0;

    const res = await postCue({ room_id: ROOM.id, type: "consult_mark", room_day_id: "rd_live", session_id: SESSION_ID, source: "replay" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_a_scratch_day" });
    expect(cueInserts()).toHaveLength(0);
    expect(cues.size).toBe(0);
    // the guard ran INSIDE the locked transaction, and the transaction rolled back
    const order = brainCalls.map((c) => c.text);
    expect(order.some((t) => /pg_advisory_xact_lock/.test(t))).toBe(true);
    expect(order.indexOf("ROLLBACK")).toBeGreaterThan(order.findIndex((t) => /FROM room_day WHERE id = \$1/.test(t)));
    expect(order).not.toContain("COMMIT");
  });

  it("an unknown room_day_id is room_day_not_found, 404, and writes nothing", async () => {
    const res = await postCue({ room_id: ROOM.id, type: "consult_mark", room_day_id: "rd_nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "room_day_not_found" });
    expect(cueInserts()).toHaveLength(0);
  });

  it("the writer refuses a live day before sending anything, when it can already see the flag", async () => {
    // the scratch day exists but was somehow created live — the tool refuses, the route would too
    days.set(SCRATCH_DAY_ID, { id: SCRATCH_DAY_ID, room_id: SCRATCH_ROOM_ID, doctor_id: null, ist_date: "2026-08-19", started_at: new Date(), ended_at: null, scratch: false });
    const out = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(out).toMatchObject({ ok: false, error: "not_a_scratch_day", written: 0 });
    expect(posted).toHaveLength(0);
    expect(cues.size).toBe(0);
  });
});

describe("5 — the scratch room and the scratch day are reused, not created again", () => {
  it("one INSERT INTO room and one INSERT INTO room_day across two runs", async () => {
    await call("scribe_replay_write", { session_id: SESSION_ID });
    const roomInserts = appCalls.filter((c) => /^INSERT INTO room \(/.test(c.text));
    const dayInserts = brainCalls.filter((c) => /^INSERT INTO room_day/.test(c.text));
    expect(roomInserts).toHaveLength(1);
    expect(dayInserts).toHaveLength(1);
    expect(roomInserts[0]!.values).toEqual([SCRATCH_ROOM_ID, scratchSlugFor(ROOM.slug), "SCRATCH · OPD Test", SCRATCH_PIN_HASH]);
    expect(dayInserts[0]!.values).toEqual([SCRATCH_DAY_ID, SCRATCH_ROOM_ID, "2026-08-19"]);

    appCalls.length = 0;
    brainCalls.length = 0;
    const second = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(second).toMatchObject({ room_day_id: SCRATCH_DAY_ID, scratch_room_day_created: false });
    expect((second.scratch_room as Row).created).toBe(false);
    expect(appCalls.filter((c) => /^INSERT INTO room \(/.test(c.text))).toHaveLength(0);
    expect(brainCalls.filter((c) => /^INSERT INTO room_day/.test(c.text))).toHaveLength(0);
    expect(rooms.size).toBe(2); // the real room and its one scratch room
    expect(days.size).toBe(1);
  });

  it("the scratch room's PIN hash is not a bcrypt hash, so no PIN can ever open it", async () => {
    await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(rooms.get(SCRATCH_ROOM_ID)!.pin_hash).toBe(SCRATCH_PIN_HASH);
    expect(String(rooms.get(SCRATCH_ROOM_ID)!.pin_hash)).not.toMatch(/^\$2[aby]\$/);
  });
});

describe("6 — a run that fails part-way is resumed cleanly by running it again", () => {
  it("the failed cue is the only one the second run writes", async () => {
    failWrites.add(`mic_primary_restored|${iso(T0 + 180_000)}`);
    const first = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(first).toMatchObject({ ok: false, written: REPLAYABLE - 1, already_existed: 0, failed: 1 });
    expect((first.failures as Row[])[0]).toMatchObject({ type: "mic_primary_restored" });
    expect(cues.size).toBe(REPLAYABLE - 1);

    failWrites.clear();
    const second = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(second).toMatchObject({ ok: true, written: 1, already_existed: REPLAYABLE - 1, failed: 0 });
    expect(cues.size).toBe(REPLAYABLE);
    expect([...cues.keys()].some((k) => k.includes("mic_primary_restored"))).toBe(true);
  });

  it("a brain that refuses everything stops the run and says so, instead of hammering it", async () => {
    for (const e of EVENTS) failWrites.add(`${e.kind}|${new Date(e.at).toISOString()}`);
    const out = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(out).toMatchObject({ ok: false, written: 0, failed: 3, stopped_early: "consecutive_failures" });
    expect(posted).toHaveLength(3); // stopped after three, not four
  });
});

describe("7 — PRODUCTION SAFETY: no room_day_id means the live path, with no scratch check", () => {
  it("a live cue resolves today's day from the clock, uses the shared insert, and never reads `scratch`", async () => {
    const res = await postCue({ room_id: ROOM.id, type: "consult_mark", at: iso(T0), payload: { source: "kiosk" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    expect(body.ok).toBe(true);
    expect(body.cue_id).toBeTruthy();
    expect(body.already_existed).toBeUndefined(); // the live response shape is unchanged
    expect(body.scratch).toBeUndefined();

    // the day came from resolveRoomDay (room + IST date), not from an id
    expect(brainCalls.some((c) => /FROM room_day WHERE room_id = \$1 AND ist_date = \$2::date/.test(c.text))).toBe(true);
    expect(brainCalls.some((c) => /FROM room_day WHERE id = \$1/.test(c.text))).toBe(false);
    // the insert is the shared statement, byte for byte — no session_id, no source, no ON CONFLICT
    expect(cueInserts()).toHaveLength(1);
    expect(cueInserts()[0]!.text).toBe(SQL_CUE_INSERT);
    expect(cueInserts()[0]!.values).toHaveLength(5);
    // and the word `scratch` never appears in ANY statement the live path issues
    expect(brainCalls.some((c) => /scratch/i.test(c.text))).toBe(false);
    expect(days.size).toBe(1);
    expect([...days.values()][0]).toMatchObject({ room_id: ROOM.id, scratch: false });
  });

  it("all six live callers' shapes still write: type-only, with `at`, with a payload, with neither", async () => {
    for (const body of [
      { room_id: ROOM.id, type: "kiosk_heartbeat" },
      { room_id: ROOM.id, type: "consult_mark", payload: { source: "mcp", note: "second patient" } },
      { room_id: ROOM.id, type: "mic_primary_lost", at: iso(T0 + 1000), payload: { reason: "silence" } },
      { room_id: ROOM.id, type: "operator_pin", payload: { phase: "in_chair", source: "mcp" } },
    ]) {
      const res = await postCue(body);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Row).ok).toBe(true);
    }
    expect(cueInserts()).toHaveLength(4);
    expect(cueInserts().every((c) => c.text === SQL_CUE_INSERT)).toBe(true);
    expect(brainCalls.some((c) => /scratch/i.test(c.text))).toBe(false);
  });

  it("an unknown room still 404s before anything is written, exactly as before", async () => {
    const res = await postCue({ room_id: "room_ghost", type: "consult_mark" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "unknown_room" });
    expect(cueInserts()).toHaveLength(0);
  });

  it("the new columns are refused rather than silently dropped when no room_day_id is given", async () => {
    const a = await postCue({ room_id: ROOM.id, type: "consult_mark", session_id: SESSION_ID });
    expect(a.status).toBe(400);
    expect(await a.json()).toMatchObject({ error: "session_id_requires_room_day_id" });
    const b = await postCue({ room_id: ROOM.id, type: "consult_mark", source: "replay" });
    expect(b.status).toBe(400);
    expect(await b.json()).toMatchObject({ error: "source_requires_room_day_id" });
    expect(cueInserts()).toHaveLength(0);
  });
});

describe("8 — the writer refuses by name when BRAIN_BASE_URL is set", () => {
  it("nothing is read, nothing is posted, nothing is created", async () => {
    process.env.BRAIN_BASE_URL = "https://brain.example/";
    const out = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(out).toMatchObject({ ok: false, error: "brain_base_url_set", written: 0, already_existed: 0, failed: 0 });
    expect(posted).toHaveLength(0);
    expect(appCalls).toHaveLength(0);
    expect(brainCalls).toHaveLength(0);
    expect(rooms.size).toBe(1);
    expect(days.size).toBe(0);
  });
});

describe("the limit — honest truncation, and a resumable run", () => {
  it("over the limit the first `limit` are written, truncated says so with the true total", async () => {
    const out = await call("scribe_replay_write", { session_id: SESSION_ID, limit: 2 });
    expect(out).toMatchObject({ written: 2, truncated: true, emitted: 2, total: REPLAYABLE });
    expect(String(out.truncation_note)).toContain("of 4 replayable events");
    expect(cues.size).toBe(2);
    // running it again without the limit finishes the job and rewrites nothing
    const rest = await call("scribe_replay_write", { session_id: SESSION_ID });
    expect(rest).toMatchObject({ written: REPLAYABLE - 2, already_existed: 2, failed: 0 });
    expect(cues.size).toBe(REPLAYABLE);
  });

  it("the default is 200 and the schema caps at 500 — each cue is one request", () => {
    const limit = (tool("scribe_replay_write").inputSchema.properties as { limit: { default: number; maximum: number } }).limit;
    expect(limit).toMatchObject({ default: 200, maximum: 500 });
  });

  it("a bad session id and an unknown session are refused by name", async () => {
    expect(await call("scribe_replay_write", { session_id: "nope" })).toMatchObject({ error: "bad_session_id" });
    expect(await call("scribe_replay_write", { session_id: "bs_missing" })).toMatchObject({ error: "session_not_found" });
    expect(posted).toHaveLength(0);
  });
});
