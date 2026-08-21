/**
 * Fuse slice 3 — the warehouse join.
 *
 * Same shape as tests/unit/fuse-scratch-write.test.ts, and for the same reason: these run the
 * WHOLE chain rather than a slice of it. scripts/load-warehouse-fixture.ts → the real
 * POST /api/brain/cues handler → the real lib/brain/state SQL → a fake Postgres that models
 * the one thing the schema actually enforces, which is now TWO partial unique indexes:
 *
 *   cue_replay_natural_key     (session_id, type, at) WHERE source = 'replay'      (0046)
 *   cue_warehouse_natural_key  (source_ref, type, at) WHERE source = 'warehouse'   (0047)
 *
 * The tests that matter most are 6 and 7. Six live callers use POST /api/brain/cues with no
 * room_day_id; if slice 3 had leaked onto that path, live cue writing would change. And the
 * loader must refuse a bad fixture BEFORE the first request, not half way through it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The app handle (lib/db) — `room` and the bench tables scribe_store_stats counts
// ---------------------------------------------------------------------------

let appResponder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    return Promise.resolve(appResponder(text, values));
  },
}));

vi.mock("@/lib/kb-retrieve", () => ({ retrieve: async () => ({ ok: true, hits: [], embed_ms: 0, query_ms: 0 }) }));

// ---------------------------------------------------------------------------
// The brain pool (lib/brain/db). classifyBrainError stays REAL — the route's error
// mapping is part of what is under test.
// ---------------------------------------------------------------------------

const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];

const runSql = (text: string, values: unknown[] = []) => {
  brainCalls.push({ text, values });
  const rows = brainResponder(text, values);
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
import { istDate, SQL_CUE_INSERT, SQL_CUE_INSERT_SCRATCH } from "@/lib/brain/state";
import { SCRATCH_ROOM_PREFIX, SCRATCH_ROOM_DAY_PREFIX, scratchRoomDayIdFor, scratchRoomIdFor } from "@/lib/brain/scratch";
import { BRAIN_TOOLS, CUE_SOURCES } from "@/lib/mcp/tools/brain";
import { STORE_TOOLS } from "@/lib/mcp/tools/stores";
import {
  loadWarehouseFixture,
  main,
  parseArgs,
  parseMap,
  scratchRoomIdForDay,
  validateFixture,
  WAREHOUSE_CUE_TYPES,
  SCRATCH_ROOM_PREFIX as LOADER_ROOM_PREFIX,
  SCRATCH_ROOM_DAY_PREFIX as LOADER_DAY_PREFIX,
  type WarehouseEvent,
} from "@/scripts/load-warehouse-fixture";
import FIXTURE from "@/fixtures/warehouse/synthetic-19-aug.json";

// ---------------------------------------------------------------------------
// The world the fakes model — two real rooms, their scratch rooms, their scratch days
// ---------------------------------------------------------------------------

const IST = "2026-08-19";
const OPD7 = { id: "room_qyzghzaf", slug: "opd-7-k4hz", name: "OPD 7" };
const CARD = { id: "room_mn4kd8p2", slug: "cardiology-b2r8", name: "Cardiology" };

const OPD7_SCRATCH_ROOM = scratchRoomIdForDay(scratchRoomDayIdFor(scratchRoomIdFor(OPD7.id), IST))!;
const OPD7_DAY = scratchRoomDayIdFor(scratchRoomIdFor(OPD7.id), IST); // rd_scratch_qyzghzaf_20260819
const CARD_DAY = scratchRoomDayIdFor(scratchRoomIdFor(CARD.id), IST);

const MAP: Record<string, string> = { "opd-7": OPD7_DAY, cardiology: CARD_DAY };
const EVENTS = FIXTURE.events as WarehouseEvent[];

/** rows keyed the way each partial unique index keys them */
let cues: Map<string, Row>;
let days: Map<string, Row>;
let rooms: Set<string>;
/** (type, at) pairs the fake database refuses — used to model a broken door */
let failWrites: Set<string>;

const warehouseKey = (sourceRef: unknown, type: unknown, at: unknown) => `w|${String(sourceRef)}|${String(type)}|${new Date(String(at)).toISOString()}`;
const replayKey = (sessionId: unknown, type: unknown, at: unknown) => `r|${String(sessionId)}|${String(type)}|${new Date(String(at)).toISOString()}`;

function seed() {
  cues = new Map();
  failWrites = new Set();
  rooms = new Set([OPD7.id, CARD.id, scratchRoomIdFor(OPD7.id), scratchRoomIdFor(CARD.id)]);
  days = new Map([
    [OPD7_DAY, { id: OPD7_DAY, room_id: scratchRoomIdFor(OPD7.id), doctor_id: null, ist_date: IST, started_at: new Date(), ended_at: null, scratch: true }],
    [CARD_DAY, { id: CARD_DAY, room_id: scratchRoomIdFor(CARD.id), doctor_id: null, ist_date: IST, started_at: new Date(), ended_at: null, scratch: true }],
    // a LIVE day for the same real room — the thing slice 3 must never write into
    ["rd_live_opd7", { id: "rd_live_opd7", room_id: OPD7.id, doctor_id: null, ist_date: IST, started_at: new Date(), ended_at: null, scratch: false }],
    // a day whose id LOOKS like a scratch id but whose row is not flagged. The id is not the
    // guard; the column is. This is what proves the route re-reads the flag rather than
    // trusting the name it was handed.
    ["rd_scratch_qyzghzaf_20260820", { id: "rd_scratch_qyzghzaf_20260820", room_id: scratchRoomIdFor(OPD7.id), doctor_id: null, ist_date: "2026-08-20", started_at: new Date(), ended_at: null, scratch: false }],
  ]);
}

function brainDb(text: string, values: unknown[]): Row[] {
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return [];
  if (/pg_advisory_xact_lock/.test(text)) return [{ pg_advisory_xact_lock: null }];
  if (/SELECT 1 FROM room WHERE id =/.test(text)) return rooms.has(String(values[0])) ? [{ "?column?": 1 }] : [];

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
    const existing = [...days.values()].find((d) => d.room_id === roomId && d.ist_date === date);
    if (existing) return [existing];
    const row = { id, room_id: roomId, doctor_id: null, ist_date: date, started_at: new Date(), ended_at: null, scratch: /scratch\)/.test(text) };
    days.set(id!, row);
    return [row];
  }

  if (/^INSERT INTO cue/.test(text)) {
    const [id, roomDayId, type, payload, at, sessionId, source, sourceRef] = values as unknown[];
    if (failWrites.has(`${String(type)}|${new Date(String(at)).toISOString()}`)) {
      throw Object.assign(new Error("simulated write fault"), { code: "08006" });
    }
    const isScratch = /session_id, source, source_ref/.test(text);
    if (isScratch && source === "warehouse") {
      const k = warehouseKey(sourceRef, type, at);
      if (cues.has(k)) return []; // ON CONFLICT DO NOTHING → no row
      cues.set(k, { id, room_day_id: roomDayId, type, payload, at, session_id: sessionId, source, source_ref: sourceRef });
    } else if (isScratch && source === "replay") {
      const k = replayKey(sessionId, type, at);
      if (cues.has(k)) return [];
      cues.set(k, { id, room_day_id: roomDayId, type, payload, at, session_id: sessionId, source, source_ref: sourceRef });
    } else {
      cues.set(`live|${String(id)}`, { id, room_day_id: roomDayId, type, payload, at, source_ref: sourceRef ?? null, source: source ?? null, session_id: sessionId ?? null });
    }
    return [{ id, at: new Date(String(at)), created_at: new Date() }];
  }

  // slice 3's split counts
  if (/FROM cue c JOIN room_day d ON d\.id = c\.room_day_id WHERE d\.ist_date/.test(text)) {
    let live = 0;
    let scratch = 0;
    for (const c of cues.values()) {
      const d = days.get(String(c.room_day_id));
      if (!d || d.ist_date !== values[0]) continue;
      if (d.scratch === true) scratch++;
      else live++;
    }
    return [{ live_n: live, scratch_n: scratch }];
  }
  if (/FROM room_day WHERE ist_date = \$1::date/.test(text)) {
    const rows = [...days.values()].filter((d) => d.ist_date === values[0]);
    return [{ live_n: rows.filter((d) => d.scratch !== true).length, scratch_n: rows.filter((d) => d.scratch === true).length }];
  }

  if (/FROM visit WHERE room_day_id/.test(text)) return [];
  if (/FROM speaker_cluster WHERE room_day_id/.test(text)) return [];
  return [];
}

function appDb(text: string): Row[] {
  if (/FROM bench_chunk/.test(text)) return [{ upload_state: "uploaded", n: 1, bytes: 10 }];
  if (/GROUP BY status/.test(text)) return [{ status: "ended", n: 1 }];
  if (/COUNT\(\*\)::int AS n/.test(text)) return [{ n: 0 }];
  return [];
}

// --- fetch → the real route handler ---------------------------------------

const posted: Row[] = [];
const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  posted.push(JSON.parse(init.body) as Row);
  return (await POST(new Request(url, { method: "POST", headers: init.headers, body: init.body }))) as unknown as {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  };
};

beforeEach(() => {
  seed();
  brainCalls.length = 0;
  posted.length = 0;
  appResponder = appDb;
  brainResponder = brainDb;
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  delete process.env.BRAIN_BASE_URL;
});

const load = (events: WarehouseEvent[] = EVENTS) =>
  loadWarehouseFixture({ events, map: MAP, baseUrl: "https://preview.example", token: "tok", fetchImpl });

const postCue = (body: Row) =>
  POST(new Request("https://preview.example/api/brain/cues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));

const cueInserts = () => brainCalls.filter((c) => /^INSERT INTO cue/.test(c.text));
const tool = (name: string) => {
  const t = [...BRAIN_TOOLS, ...STORE_TOOLS].find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

// ===========================================================================

describe("1 — the fixture is what slice 3 says it is", () => {
  it("8 events, all four warehouse types, both rooms, and exactly one duplicate natural key", () => {
    expect(EVENTS).toHaveLength(8);
    expect([...new Set(EVENTS.map((e) => e.type))].sort()).toEqual([...WAREHOUSE_CUE_TYPES].sort());
    expect([...new Set(EVENTS.map((e) => e.room))].sort()).toEqual(["cardiology", "opd-7"]);
    const keys = EVENTS.map((e) => `${e.source_ref}|${e.type}|${e.at}`);
    expect(new Set(keys).size).toBe(7); // one deliberate duplicate
    expect(EVENTS.every((e) => typeof e.source_ref === "string" && e.source_ref.length > 0)).toBe(true);
    // the uids are fake, and the fixture says so
    expect(JSON.stringify(EVENTS)).not.toMatch(/ind_(?!fake_)/);
  });

  it("the loader's id prefixes have not drifted from lib/brain/scratch.ts", () => {
    // The loader re-derives these rather than importing them (it must stay free of @/lib/db).
    // This is the assert that keeps the copy honest.
    expect(LOADER_ROOM_PREFIX).toBe(SCRATCH_ROOM_PREFIX);
    expect(LOADER_DAY_PREFIX).toBe(SCRATCH_ROOM_DAY_PREFIX);
    expect(scratchRoomIdForDay(OPD7_DAY)).toBe(scratchRoomIdFor(OPD7.id));
    expect(OPD7_SCRATCH_ROOM).toBe("room_scratch_qyzghzaf");
    expect(OPD7_DAY).toBe("rd_scratch_qyzghzaf_20260819");
    // a live day id, or a typo, yields null rather than a plausible room that does not exist
    expect(scratchRoomIdForDay("rd_live_opd7")).toBeNull();
    expect(scratchRoomIdForDay("rd_scratch_qyzghzaf")).toBeNull();
  });
});

describe("2 — each of the four types is written once, with source 'warehouse' and its source_ref", () => {
  it("writes 7 of 8, absorbs the duplicate, and every row carries the key 0047 indexes", async () => {
    const r = await load();
    expect(r).toMatchObject({ ok: true, total: 8, written: 7, already_existed: 1, failed: 0 });
    expect(r.by_type).toEqual({ pqm_called: 3, pstart: 2, dx_event: 2, pulse_note: 1 });

    // every request named a scratch day, its scratch room, the warehouse source and a source_ref
    expect(posted).toHaveLength(8);
    for (const p of posted) {
      expect(p.source).toBe("warehouse");
      expect(String(p.source_ref).length).toBeGreaterThan(0);
      expect([OPD7_DAY, CARD_DAY]).toContain(p.room_day_id);
      expect(String(p.room_id).startsWith(SCRATCH_ROOM_PREFIX)).toBe(true);
      expect(p.session_id).toBeUndefined(); // a warehouse cue has no session
    }

    // sequential, in the warehouse's own time order
    const times = posted.map((p) => Date.parse(String(p.at)));
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // the write used the SCRATCH statement — the shared live one never ran
    expect(cueInserts()).toHaveLength(8);
    expect(cueInserts().every((c) => c.text === SQL_CUE_INSERT_SCRATCH)).toBe(true);
    expect(cueInserts().some((c) => c.text === SQL_CUE_INSERT)).toBe(false);

    // 7 distinct rows, one per natural key, one of each type present
    expect(cues.size).toBe(7);
    const stored = [...cues.values()];
    for (const t of WAREHOUSE_CUE_TYPES) expect(stored.some((c) => c.type === t)).toBe(true);
    for (const c of stored) {
      expect(c.source).toBe("warehouse");
      expect(c.session_id).toBeNull();
      expect(String(c.source_ref).length).toBeGreaterThan(0);
    }
    // and not one row landed on the live day
    expect(stored.some((c) => c.room_day_id === "rd_live_opd7")).toBe(false);
  });

  it("a well-formed scratch id whose row is not flagged is refused by the ROUTE, not the loader", async () => {
    const r = await loadWarehouseFixture({
      events: [EVENTS[0]!],
      map: { "opd-7": "rd_scratch_qyzghzaf_20260820" }, // looks scratch, row says otherwise
      baseUrl: "https://preview.example",
      token: "tok",
      fetchImpl,
    });
    expect(r).toMatchObject({ ok: false, written: 0, already_existed: 0, failed: 1 });
    expect(r.failures[0]).toMatchObject({ error: "not_a_scratch_day" });
    expect(posted).toHaveLength(1); // the loader did ask — the guard is the route's
    expect(cues.size).toBe(0);
  });

  it("a malformed map target is refused by the LOADER, with nothing asked and nothing written", async () => {
    const r = await loadWarehouseFixture({
      events: EVENTS,
      map: { "opd-7": "rd_live_opd7" }, // not a scratch-shaped id at all
      baseUrl: "https://preview.example",
      token: "tok",
      fetchImpl,
    });
    expect(r).toMatchObject({ ok: false, written: 0, already_existed: 0, failed: EVENTS.length });
    expect(r.failures[0]).toMatchObject({ error: "map_target_malformed" });
    expect(posted).toHaveLength(0); // not one request left the process
    expect(cues.size).toBe(0);
  });
});

describe("3 — re-running writes nothing", () => {
  it("second run reports all 8 already-existed and issues no new row", async () => {
    const first = await load();
    expect(first.written).toBe(7);
    const sizeAfterFirst = cues.size;

    posted.length = 0;
    const second = await load();
    expect(second).toMatchObject({ ok: true, total: 8, written: 0, already_existed: 8, failed: 0 });
    expect(cues.size).toBe(sizeAfterFirst); // not one new row
    expect(posted).toHaveLength(8); // it still asks; the index is what refuses
  });

  it("a run that died half way is finished by running it again", async () => {
    const victim = EVENTS[3]!;
    failWrites.add(`${victim.type}|${new Date(victim.at).toISOString()}`);
    const first = await load();
    expect(first.failed).toBe(1);
    expect(first.ok).toBe(false);

    failWrites.clear();
    const second = await load();
    expect(second.failed).toBe(0);
    expect(second.written).toBe(1); // only the one that never landed
    expect(second.already_existed).toBe(7);
    expect(cues.size).toBe(7);
  });
});

describe("4 — a room absent from the map is refused before anything is written", () => {
  it("validateFixture names the room, and nothing is posted", () => {
    const bad = [...EVENTS, { room: "dermatology", type: "pqm_called", at: EVENTS[0]!.at, source_ref: "qts_x" }];
    expect(validateFixture(bad, MAP)).toEqual({ error: "room_not_in_map", detail: "dermatology" });
    expect(posted).toHaveLength(0);
  });

  it("parseMap refuses a target that is not a scratch room-day at all", () => {
    expect(parseMap("opd-7=rd_live_opd7")).toEqual({ error: "map_target_not_scratch", detail: "opd-7=rd_live_opd7" });
    expect(parseMap("opd-7=rd_scratch_qyzghzaf")).toEqual({ error: "map_target_malformed", detail: "opd-7=rd_scratch_qyzghzaf" });
    expect(parseMap(`opd-7=${OPD7_DAY}`)).toEqual({ ok: true, map: { "opd-7": OPD7_DAY } });
  });
});

describe("5 — an event with no source_ref is refused", () => {
  it("refused by name — without a key, a re-run would write it twice", () => {
    const noRef = [{ room: "opd-7", type: "pqm_called", at: EVENTS[0]!.at }] as unknown as WarehouseEvent[];
    expect(validateFixture(noRef, MAP)).toMatchObject({ error: "event_source_ref_required" });
    const emptyRef = [{ room: "opd-7", type: "pqm_called", at: EVENTS[0]!.at, source_ref: "" }];
    expect(validateFixture(emptyRef, MAP)).toMatchObject({ error: "event_source_ref_required" });
    expect(posted).toHaveLength(0);
  });
});

describe("6 — source_ref without room_day_id is a 400 on the route, by name", () => {
  it("refused rather than accepted-and-dropped, and nothing is written", async () => {
    const res = await postCue({ room_id: OPD7.id, type: "pqm_called", source_ref: "qts_x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "source_ref_requires_room_day_id" });
    expect(cueInserts()).toHaveLength(0);
    expect(cues.size).toBe(0);
  });
});

describe("7 — the live path is untouched", () => {
  it("still writes through SQL_CUE_INSERT with no source_ref, session_id or source", async () => {
    const res = await postCue({ room_id: OPD7.id, type: "consult_mark", payload: { source: "kiosk" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    expect(body.ok).toBe(true);
    expect(body.scratch).toBeUndefined();

    // the SHARED statement ran, and it names none of the three scratch columns
    expect(cueInserts()).toHaveLength(1);
    expect(cueInserts()[0]!.text).toBe(SQL_CUE_INSERT);
    expect(SQL_CUE_INSERT).not.toMatch(/source_ref/);
    expect(cueInserts()[0]!.values).toHaveLength(5);

    const row = [...cues.values()][0]!;
    expect(row.source_ref).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.source).toBeNull();
  });

  it("the scratch statement carries source_ref as its eighth parameter, and only there", () => {
    expect(SQL_CUE_INSERT_SCRATCH).toContain("session_id, source, source_ref");
    expect(SQL_CUE_INSERT_SCRATCH).toContain("$8::text");
    expect(SQL_CUE_INSERT_SCRATCH).toContain("ON CONFLICT DO NOTHING");
  });
});

describe("8 — scribe_post_cue rejects source 'warehouse'", () => {
  it("warehouse is gone from CUE_SOURCES and from the tool's schema", async () => {
    expect([...CUE_SOURCES]).toEqual(["mcp", "replay"]);
    const t = tool("scribe_post_cue");
    const schema = t.inputSchema as { properties: { source: { enum: string[] } } };
    expect(schema.properties.source.enum).toEqual(["mcp", "replay"]);
    expect(t.description).not.toMatch(/mcp\|warehouse\|replay/);
  });
});

describe("9 — scribe_store_stats separates live and scratch", () => {
  it("the fixture's cues land under the scratch counts, never the live ones", async () => {
    await load();
    // The tool reads the real clock via istDate(), so move the fake's days onto today rather
    // than freezing time: the assertion is then about the SPLIT, not about what day it is.
    // The fake holds four days — two flagged scratch (which hold all 7 warehouse cues), plus
    // rd_live_opd7 and the scratch-LOOKING rd_scratch_qyzghzaf_20260820, whose rows are not
    // flagged and which therefore count as live. The name never decides; the column does.
    const today = istDate();
    for (const d of days.values()) d.ist_date = today;

    const out = (await tool("scribe_store_stats").handler({}, { origin: "https://preview.example" })) as Row;
    expect(out.ist_date).toBe(today);
    expect(out.degraded).toBeUndefined();

    expect(out.brain).toEqual({
      room_days_today: 2,        // the two unflagged days, including the scratch-NAMED one
      cues_today: 0,             // and not one warehouse cue counted as clinic traffic
      scratch_room_days_today: 2,
      scratch_cues_today: 7,
    });
  });

  it("a brain fault degrades both numbers to null rather than 500ing", async () => {
    const today = istDate();
    for (const d of days.values()) d.ist_date = today;
    brainResponder = (text, values) => {
      if (/FROM cue c JOIN room_day d/.test(text)) throw new Error("relation \"cue\" does not exist");
      return brainDb(text, values);
    };
    const out = (await tool("scribe_store_stats").handler({}, { origin: "https://preview.example" })) as Row;
    const brain = out.brain as Row;
    expect(brain.cues_today).toBeNull();
    expect(brain.scratch_cues_today).toBeNull();
    expect(out.degraded).toBe(true);
    // the other count is unaffected — each is its own fail-safe query
    expect(brain.scratch_room_days_today).toBe(2);
  });
});

describe("10 — migration 0047 records itself, per def3a8e's rule", () => {
  it("names version 47 and its own filename stem", async () => {
    const { readFileSync } = await import("node:fs");
    const sqlText = readFileSync("db/migrations/0047_warehouse_cue_key.sql", "utf8");
    expect(sqlText).toMatch(/INSERT INTO schema_migrations \(version, name\)/);
    expect(sqlText).toMatch(/VALUES \(47, '0047_warehouse_cue_key'\)/);
    expect(sqlText).toMatch(/ON CONFLICT DO NOTHING;/);
    // additive + idempotent, and the partial predicate is the whole point
    expect(sqlText).toMatch(/ADD COLUMN IF NOT EXISTS source_ref text/);
    expect(sqlText).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS cue_warehouse_natural_key/);
    expect(sqlText).toMatch(/WHERE source = 'warehouse'/);
    // and it modifies nothing that already exists: slice 2's key is only ever NAMED, in a
    // comment, never dropped, altered or recreated — and no statement here is a DROP at all.
    expect(sqlText).not.toMatch(/^\s*(DROP|ALTER INDEX|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(sqlText).not.toMatch(/^\s*CREATE[^\n]*cue_replay_natural_key/im);
    const statements = sqlText.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim());
    expect(statements.join("\n")).not.toMatch(/cue_replay_natural_key/);
  });
});

describe("11 — the CLI refuses before the first request, and prints no uid", () => {
  let dir: string;
  let logs: string[];
  let errs: string[];
  const fetchSpy = vi.fn();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wh-fixture-"));
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const run = (doc: unknown, map = `opd-7=${OPD7_DAY},cardiology=${CARD_DAY}`) => {
    const p = join(dir, "f.json");
    writeFileSync(p, JSON.stringify(doc));
    return main(["--fixture", p, "--base-url", "https://preview.example", "--map", map]);
  };

  it("an unmapped room stops the run at exit 2, with zero requests issued", async () => {
    const code = await run({ events: [{ room: "dermatology", type: "pqm_called", at: EVENTS[0]!.at, source_ref: "qts_x" }] });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("room_not_in_map");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a missing source_ref stops the run at exit 2, with zero requests issued", async () => {
    const code = await run({ events: [{ room: "opd-7", type: "pqm_called", at: EVENTS[0]!.at }] });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("event_source_ref_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a bad --map, a missing flag and a missing token are each refused by name", async () => {
    expect(parseArgs(["--base-url", "x", "--map", "a=rd_scratch_b_20260819"])).toMatchObject({ error: "fixture_required" });
    expect(parseArgs(["--fixture", "f", "--map", "a=rd_scratch_b_20260819"])).toMatchObject({ error: "base_url_required" });
    expect(parseArgs(["--fixture", "f", "--base-url", "x"])).toMatchObject({ error: "map_required" });
    expect(await run({ events: EVENTS }, "opd-7=nonsense")).toBe(2);

    const saved = process.env.BRAIN_SERVICE_TOKEN;
    delete process.env.BRAIN_SERVICE_TOKEN;
    expect(await run({ events: EVENTS })).toBe(2);
    expect(errs.join("\n")).toContain("service_token_not_configured");
    process.env.BRAIN_SERVICE_TOKEN = saved;
  });

  it("a successful run prints counts and no individual_uid", async () => {
    fetchSpy.mockImplementation((url: string, init: { method: string; headers: Record<string, string>; body: string }) => fetchImpl(url, init));
    const code = await run({ events: EVENTS });
    expect(code).toBe(0);
    const printed = [...logs, ...errs].join("\n");
    expect(printed).toContain("written 7  already-existed 1  failed 0  of 8");
    expect(printed).toContain("pqm_called=3");
    // the rule that matters: no uid, no payload, no token ever reaches the console
    expect(printed).not.toMatch(/ind_fake_/);
    expect(printed).not.toMatch(/individual_uid/);
    expect(printed).not.toMatch(/\btok\b/);
  });
});
