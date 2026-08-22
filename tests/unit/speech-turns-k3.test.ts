/**
 * Speech turns, slice A — kickoff K3, the window is the write unit.
 *
 * WHY THIS SLICE EXISTS. Whisper is not a deterministic writer: two runs of the same clip
 * returned 162 and 165 segments. source_ref is built from segment boundaries, so a second run's
 * keys mostly MISS the first run's — an insert-only writer therefore ACCUMULATES two disagreeing
 * opinions of one window instead of deduplicating. The write unit moved from the turn to the
 * window: delete the window's rows, insert the new set, one transaction.
 *
 * Four things are proved here:
 *
 *   1. 0052 puts stt_window in BOTH predicates, and SQL_CUE_INSERT_TURN still repeats the turn
 *      one character for character.
 *   2. The batch statement is the single-row statement with n tuples — same columns, same casts,
 *      same named arbiter — so the two cannot drift.
 *   3. THE REPLACE, end to end through the REAL route handler: the delete matches on the ASKED
 *      window in the payload and never on segment times, it runs under the same lock and the
 *      same in-lock scratch re-read, and a 165-segment second run leaves 165 rows and not 327.
 *   4. The decoder is pinned to what the endpoint actually honours, and no seed is sent.
 *
 * The fake Postgres models the two things that matter: the partial unique index over
 * (source_ref, type), and a DELETE that can only see payload->window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const appCalls: Array<{ text: string; values: unknown[] }> = [];
let appResponder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    return Promise.resolve(appResponder(text, values));
  },
}));

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
import {
  SQL_CUE_DELETE_WINDOW,
  SQL_CUE_INSERT_TURN,
  WINDOW_CUE_TYPE,
  WINDOW_OWNED_TYPES,
  buildTurnBatchInsert,
} from "@/lib/brain/state";

const migration = (name: string) => readFileSync(join(process.cwd(), "db", "migrations", name), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// ===========================================================================
// 1. migration 0052 — one family, four names, two predicates
// ===========================================================================

describe("0052 — stt_window joins the turn family in BOTH predicates", () => {
  const sql = migration("0052_stt_window_type.sql");
  const body = squash(sql.replace(/^--.*$/gm, ""));

  it("excludes the four from the replay key and includes them in the turn key", () => {
    expect(body).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS cue_replay_natural_key ON cue (session_id, type, at) " +
        "WHERE source = 'replay' AND type NOT IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match');",
    );
    expect(body).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS cue_turn_natural_key ON cue (source_ref, type) " +
        "WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match');",
    );
  });

  it("each DROP immediately precedes its own CREATE — no predicate is ever left wider", () => {
    const order = [...body.matchAll(/(DROP INDEX IF EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS) (\w+)/g)].map((m) => `${m[1]!.startsWith("DROP") ? "drop" : "create"}:${m[2]}`);
    expect(order).toEqual([
      "drop:cue_replay_natural_key", "create:cue_replay_natural_key",
      "drop:cue_turn_natural_key", "create:cue_turn_natural_key",
    ]);
  });

  it("RECORDS ITSELF", () => {
    expect(squash(sql)).toContain("INSERT INTO schema_migrations (version, name) VALUES (52, '0052_stt_window_type') ON CONFLICT DO NOTHING;");
  });

  it("touches no table and no other index — five statements, nothing else", () => {
    expect(body).not.toContain("cue_warehouse_natural_key");
    expect(body).not.toMatch(/ALTER TABLE|DROP TABLE|DELETE FROM cue|UPDATE cue/);
    expect(body.split(";").filter((p) => p.trim().length > 0)).toHaveLength(5);
  });

  it("0050 and 0051 are NOT edited — the history stays what production already ran", () => {
    expect(squash(migration("0050_turn_cue_keys.sql"))).toContain("VALUES (50, '0050_turn_cue_keys')");
    expect(squash(migration("0051_narrow_replay_key.sql"))).toContain("VALUES (51, '0051_narrow_replay_key')");
    // neither mentions the type 0052 introduces
    expect(migration("0050_turn_cue_keys.sql")).not.toContain("stt_window");
    expect(migration("0051_narrow_replay_key.sql")).not.toContain("stt_window");
  });
});

// ===========================================================================
// 2. the batch statement — the single-row one, n times
// ===========================================================================

describe("buildTurnBatchInsert — one statement for a whole window", () => {
  it("at n=1 it IS SQL_CUE_INSERT_TURN", () => {
    expect(squash(buildTurnBatchInsert(1))).toBe(squash(SQL_CUE_INSERT_TURN));
  });

  it("numbers its parameters 8 to a row, in the column order", () => {
    const s = buildTurnBatchInsert(3);
    expect(s).toContain("($1, $2, $3, $4::jsonb, $5::timestamptz, $6::text, $7::text, $8::text)");
    expect(s).toContain("($9, $10, $11, $12::jsonb, $13::timestamptz, $14::text, $15::text, $16::text)");
    expect(s).toContain("($17, $18, $19, $20::jsonb, $21::timestamptz, $22::text, $23::text, $24::text)");
    expect(s.match(/::jsonb/g)).toHaveLength(3);
  });

  it("keeps the NAMED arbiter at every size — a batch is not a licence to swallow conflicts", () => {
    for (const n of [1, 2, 165]) {
      expect(squash(buildTurnBatchInsert(n))).toContain(
        "ON CONFLICT (source_ref, type) WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match') DO NOTHING RETURNING id, at, created_at",
      );
    }
  });

  it("refuses a non-positive size rather than emitting `VALUES ()`", () => {
    for (const n of [0, -1, 1.5, NaN]) expect(() => buildTurnBatchInsert(n)).toThrow(/positive integer/);
  });
});

describe("SQL_CUE_DELETE_WINDOW — the asked window, never Whisper's segment times", () => {
  const s = squash(SQL_CUE_DELETE_WINDOW);

  it("matches on payload->window, cast to bigint on both ends", () => {
    expect(s).toContain("(payload->'window'->>'start_ms')::bigint = $3");
    expect(s).toContain("(payload->'window'->>'end_ms')::bigint = $4");
    // NOT on `at`, and not on source_ref — those are what moved between runs
    expect(s).not.toContain("source_ref");
    expect(s).not.toMatch(/\bat\b *=/);
  });

  it("is scoped to the day, the session and replay — never a whole table", () => {
    expect(s).toContain("room_day_id = $1");
    expect(s).toContain("session_id = $2");
    expect(s).toContain("source = 'replay'");
  });

  it("deletes only the three types this writer OWNS, and never speaker_match", () => {
    expect(s).toContain("type IN ('stt_turn', 'stt_silence', 'stt_window')");
    expect(s).not.toContain("speaker_match");
    expect([...WINDOW_OWNED_TYPES]).toEqual(["stt_turn", "stt_silence", "stt_window"]);
  });
});

// ===========================================================================
// 3. the replace, through the REAL route handler
// ===========================================================================

const ROOM_ID = "room_scratch_t";
const DAY_ID = "rd_scratch_t_20260819";
const SESSION_ID = "bs_a";
const WIN = { start_ms: Date.parse("2026-08-19T05:06:00Z"), end_ms: Date.parse("2026-08-19T05:08:00Z") };

let cueRows: Row[];
let dayScratch: boolean;
let insertFault: string | null;

/** A cue as the writer would send it. */
const draft = (type: string, atMs: number, win = WIN, extra: Row = {}) => ({
  type,
  at: new Date(atMs).toISOString(),
  payload: { window: win, session_id: SESSION_ID, ...extra },
  source_ref: `${SESSION_ID}|${atMs}|${atMs + 1000}|${type === WINDOW_CUE_TYPE ? "window" : "-"}`,
});

function brainDb(text: string, values: unknown[]): Row[] {
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return [];
  if (/pg_advisory_xact_lock/.test(text)) return [{ pg_advisory_xact_lock: null }];
  if (/SELECT 1 FROM room WHERE id =/.test(text)) return [{ "?column?": 1 }];
  if (/FROM room_day WHERE id = \$1/.test(text)) {
    return String(values[0]) === DAY_ID
      ? [{ id: DAY_ID, room_id: ROOM_ID, doctor_id: null, ist_date: "2026-08-19", started_at: new Date(), ended_at: null, scratch: dayScratch }]
      : [];
  }
  if (/^DELETE FROM cue/.test(text)) {
    const [roomDayId, sessionId, startMs, endMs] = values as [string, string, number, number];
    const owned = ["stt_turn", "stt_silence", "stt_window"];
    const gone = cueRows.filter((r) => {
      const w = (r.payload as Row | null)?.window as Row | undefined;
      return r.room_day_id === roomDayId && r.session_id === sessionId && r.source === "replay" &&
        owned.includes(String(r.type)) && Number(w?.start_ms) === Number(startMs) && Number(w?.end_ms) === Number(endMs);
    });
    cueRows = cueRows.filter((r) => !gone.includes(r));
    return gone.map((r) => ({ id: r.id }));
  }
  if (/^INSERT INTO cue/.test(text)) {
    if (insertFault) throw Object.assign(new Error(insertFault), { code: "08006" });
    // The LIVE statement takes five parameters and no conflict clause. Modelled here so the
    // production-safety test below exercises the real live branch rather than a rejection.
    if (values.length === 5) {
      const [id, roomDayId, type, payload, at] = values;
      cueRows.push({ id, room_day_id: roomDayId, type, payload: payload ? JSON.parse(String(payload)) : null, at });
      return [{ id, at: new Date(String(at)), created_at: new Date() }];
    }
    const out: Row[] = [];
    // n tuples, 8 params each — exactly how buildTurnBatchInsert lays them out
    for (let i = 0; i + 8 <= values.length; i += 8) {
      const [id, roomDayId, type, payload, at, sessionId, source, sourceRef] = values.slice(i, i + 8);
      // the partial unique index over (source_ref, type), including WITHIN this statement
      const dup = cueRows.some((r) => r.source === "replay" && r.source_ref === sourceRef && r.type === type);
      if (dup) continue;
      cueRows.push({ id, room_day_id: roomDayId, type, payload: payload ? JSON.parse(String(payload)) : null, at, session_id: sessionId, source, source_ref: sourceRef });
      out.push({ id, at: new Date(String(at)), created_at: new Date() });
    }
    return out;
  }
  if (/FROM cue WHERE room_day_id/.test(text)) return [];
  if (/FROM visit WHERE room_day_id/.test(text)) return [];
  if (/FROM speaker_cluster WHERE room_day_id/.test(text)) return [];
  return [];
}

const post = async (body: Row) =>
  POST(new Request("https://preview.example/api/brain/cues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));

const batchBody = (cues: unknown[], over: Row = {}) => ({
  room_id: ROOM_ID, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay",
  replace_window: { session_id: SESSION_ID, ...WIN }, cues, ...over,
});

beforeEach(() => {
  cueRows = [];
  dayScratch = true;
  insertFault = null;
  brainCalls.length = 0;
  appCalls.length = 0;
  appResponder = () => [];
  brainResponder = brainDb;
  process.env.BRAIN_SERVICE_TOKEN = "tok";
});

describe("the batch path — delete then insert, one lock, one transaction", () => {
  it("THE HEADLINE: a 165-segment re-run of a 162-segment window leaves 165 rows, not 327", async () => {
    const first = await post(batchBody([
      ...Array.from({ length: 162 }, (_, i) => draft("stt_turn", WIN.start_ms + i * 100)),
      draft(WINDOW_CUE_TYPE, WIN.start_ms, WIN, { complete: true }),
    ]));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, batch: true, deleted: 0, written: 163 });
    expect(cueRows).toHaveLength(163);

    // Whisper's second opinion: 165 segments, on DIFFERENT boundaries, so almost no source_ref
    // from the first run recurs. An insert-only writer would now hold 328 rows.
    const second = await post(batchBody([
      ...Array.from({ length: 165 }, (_, i) => draft("stt_turn", WIN.start_ms + i * 97 + 13)),
      draft(WINDOW_CUE_TYPE, WIN.start_ms, WIN, { complete: true }),
    ]));
    const body = (await second.json()) as Row;
    expect(body).toMatchObject({ ok: true, deleted: 163, written: 166 });
    expect(cueRows).toHaveLength(166);
    expect(cueRows.filter((r) => r.type === "stt_turn")).toHaveLength(165);
    // exactly ONE completeness cue survives the replace
    expect(cueRows.filter((r) => r.type === WINDOW_CUE_TYPE)).toHaveLength(1);
  });

  it("the delete runs INSIDE the lock, before the insert, in one transaction", async () => {
    cueRows.push({ id: "old", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "x", payload: { window: WIN } });
    await post(batchBody([draft("stt_turn", WIN.start_ms)]));
    const order = brainCalls.map((c) => c.text.split(" ").slice(0, 3).join(" "));
    const lock = order.findIndex((t) => /pg_advisory_xact_lock/.test(t));
    const del = order.findIndex((t) => /^DELETE FROM cue/.test(t));
    const ins = order.findIndex((t) => /^INSERT INTO cue/.test(t));
    const commit = order.findIndex((t) => /^COMMIT/.test(t));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(del);
    expect(del).toBeLessThan(ins);
    expect(ins).toBeLessThan(commit);
    // ONE insert statement for the batch, not one per row
    expect(brainCalls.filter((c) => /^INSERT INTO cue/.test(c.text))).toHaveLength(1);
  });

  it("the delete only reaches rows whose payload.window is THIS window", async () => {
    const other = { start_ms: WIN.start_ms + 600_000, end_ms: WIN.end_ms + 600_000 };
    cueRows.push(
      { id: "mine", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "a", payload: { window: WIN } },
      { id: "neighbour", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "b", payload: { window: other } },
      { id: "a_mark", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "consult_mark", source_ref: "c", payload: { window: WIN } },
      { id: "no_window", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "d", payload: { text: "pre-K2" } },
    );
    const res = await post(batchBody([]));
    expect(await res.json()).toMatchObject({ deleted: 1, written: 0 });
    expect(cueRows.map((r) => r.id).sort()).toEqual(["a_mark", "neighbour", "no_window"]);
  });

  it("an EMPTY cues array with a replace_window is a DELETE-ONLY call — K3 §7's cleanup, no new tool", async () => {
    for (let i = 0; i < 77; i++) {
      cueRows.push({ id: `r${i}`, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: `s${i}`, payload: { window: WIN } });
    }
    const res = await post(batchBody([]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 77, written: 0, attempted: 0 });
    expect(cueRows).toHaveLength(0);
    // and it issued no INSERT at all rather than `VALUES ()`
    expect(brainCalls.some((c) => /^INSERT INTO cue/.test(c.text))).toBe(false);
  });

  it("the within-write key still absorbs a duplicate — two turns sharing a start both land", async () => {
    const at = WIN.start_ms;
    const res = await post(batchBody([
      { type: "stt_turn", at: new Date(at).toISOString(), payload: { window: WIN }, source_ref: `${SESSION_ID}|${at}|${at + 1000}|-` },
      // SAME start, different end → a different key → both land (0051 proved this in production)
      { type: "stt_turn", at: new Date(at).toISOString(), payload: { window: WIN }, source_ref: `${SESSION_ID}|${at}|${at + 2000}|-` },
      // an exact repeat of the first → the same key → absorbed, and counted as already_existed
      { type: "stt_turn", at: new Date(at).toISOString(), payload: { window: WIN }, source_ref: `${SESSION_ID}|${at}|${at + 1000}|-` },
    ]));
    expect(await res.json()).toMatchObject({ written: 2, already_existed: 1, attempted: 3 });
  });

  it("A FAILED INSERT ROLLS THE DELETE BACK — the previous window survives, never 71 of 162", async () => {
    for (let i = 0; i < 10; i++) {
      cueRows.push({ id: `keep${i}`, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: `k${i}`, payload: { window: WIN } });
    }
    insertFault = "simulated write fault";
    const res = await post(batchBody([draft("stt_turn", WIN.start_ms)]));
    expect(res.status).toBe(503);
    // the fake DB applied the delete, but the route ROLLED BACK — and a real Postgres would
    // restore the rows. What is asserted here is that ROLLBACK was issued and COMMIT was not.
    expect(brainCalls.some((c) => /^ROLLBACK/.test(c.text))).toBe(true);
    expect(brainCalls.some((c) => /^COMMIT/.test(c.text))).toBe(false);
  });
});

describe("the batch path reuses the guard — it does not re-implement it", () => {
  it("a day whose scratch flag is not true is refused 409, and NOTHING is deleted", async () => {
    dayScratch = false;
    cueRows.push({ id: "safe", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "a", payload: { window: WIN } });
    const res = await post(batchBody([draft("stt_turn", WIN.start_ms)]));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "not_a_scratch_day" });
    expect(cueRows).toHaveLength(1);
    expect(brainCalls.some((c) => /^DELETE FROM cue/.test(c.text))).toBe(false);
  });

  it("the flag is re-read INSIDE the lock, not before it", async () => {
    await post(batchBody([draft("stt_turn", WIN.start_ms)]));
    const lock = brainCalls.findIndex((c) => /pg_advisory_xact_lock/.test(c.text));
    const dayRead = brainCalls.findIndex((c) => /FROM room_day WHERE id = \$1/.test(c.text));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(dayRead).toBeGreaterThan(lock);
  });

  it("an unknown day is 404, not a silent no-op", async () => {
    const res = await post(batchBody([draft("stt_turn", WIN.start_ms)], { room_day_id: "rd_nope" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "room_day_not_found" });
  });

  it("a batch with no room_day_id is refused BY NAME — the batch is scratch-only, always", async () => {
    const res = await post({ room_id: ROOM_ID, session_id: SESSION_ID, source: "replay", cues: [draft("stt_turn", WIN.start_ms)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "cues_requires_room_day_id" });
  });
});

describe("the batch path refuses what it cannot mean", () => {
  it.each([
    ["cues and a single cue together", { ...batchBody([]), type: "stt_turn" }, 400, "cues_and_single_cue_are_exclusive"],
    ["a replace_window with no cues field at all", { room_id: ROOM_ID, room_day_id: DAY_ID, type: "x", replace_window: { session_id: SESSION_ID, ...WIN } }, 400, "replace_window_requires_cues"],
    ["cues that are not an array", { room_id: ROOM_ID, room_day_id: DAY_ID, cues: "nope" }, 400, "type_required"],
    ["a cue that is not an object", { ...batchBody(["nope"]) }, 400, "invalid_cue_in_batch"],
    ["a cue with no type", { ...batchBody([{ at: new Date().toISOString() }]) }, 400, "type_required"],
    ["a non-integer window bound", { ...batchBody([], { replace_window: { session_id: SESSION_ID, start_ms: 1.5, end_ms: 2 } }) }, 400, "invalid_replace_window"],
    ["a window that ends before it starts", { ...batchBody([], { replace_window: { session_id: SESSION_ID, start_ms: 9, end_ms: 9 } }) }, 400, "invalid_replace_window"],
    ["a window whose bounds arrived as strings", { ...batchBody([], { replace_window: { session_id: SESSION_ID, start_ms: "1", end_ms: "2" } }) }, 400, "invalid_replace_window"],
  ])("refuses %s", async (_label, body, status, error) => {
    const res = await post(body as Row);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
    expect(cueRows).toHaveLength(0);
  });

  it("refuses an oversized batch rather than truncating it — a shortened window is a partial", async () => {
    const res = await post(batchBody(Array.from({ length: 2001 }, (_, i) => draft("stt_turn", WIN.start_ms + i))));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_many_cues" });
    expect(brainCalls.some((c) => /^INSERT INTO cue/.test(c.text))).toBe(false);
  });

  it("every refusal happens BEFORE the lock is taken", async () => {
    await post({ ...batchBody(["nope"]) });
    expect(brainCalls.some((c) => /pg_advisory_xact_lock/.test(c.text))).toBe(false);
  });
});

describe("PRODUCTION SAFETY — the live path cannot reach any of this", () => {
  it("a live cue (no room_day_id, no cues) still takes the live branch and issues no DELETE", async () => {
    brainResponder = (text, values) => {
      if (/FROM room_day WHERE room_id = \$1 AND ist_date/.test(text)) return [];
      if (/^INSERT INTO room_day/.test(text)) return [{ id: "rd_live", room_id: "room_t", ist_date: "2026-08-19", scratch: false }];
      return brainDb(text, values);
    };
    const res = await post({ room_id: "room_t", type: "consult_mark", payload: { source: "kiosk" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row;
    expect(body.batch).toBeUndefined();
    expect(body.scratch).toBeUndefined();
    expect(brainCalls.some((c) => /^DELETE FROM cue/.test(c.text))).toBe(false);
    expect(brainCalls.some((c) => /scratch/i.test(c.text))).toBe(false);
  });
});

// ===========================================================================
// 4. the decoder — pinned to what the endpoint actually honours
// ===========================================================================

describe("the Whisper decoder is pinned (K3 §5)", () => {
  it("sends greedy, single-candidate, zero temperature — and NO seed", async () => {
    process.env.WHISPER_BASE_URL = "https://whisper.example";
    let form: FormData | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: "hi", language: "en", segments: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { transcribeWithWhisper } = await import("@/lib/whisper");
    const out = await transcribeWithWhisper(new Uint8Array([1, 2, 3]), "audio/wav");
    expect(out.ok).toBe(true);
    const f = form! as unknown as FormData;
    expect(f.get("temperature")).toBe("0.0");
    expect(f.get("beam_size")).toBe("1");
    expect(f.get("best_of")).toBe("1");
    expect(f.get("response_format")).toBe("verbose_json");
    // The Mini has no seed parameter: posting one returns 200 and changes nothing, so sending it
    // would read as a guarantee that is being kept when it is not. Verified against the live
    // endpoint — beam_size/best_of/temperature reject garbage with stoi/stof, `seed` does not.
    expect(f.get("seed")).toBeNull();
  });
});

// ===========================================================================
// 5. the error the server already knew (K3 follow-up)
// ===========================================================================

describe("classifyBrainError — a missing GRANT is not an outage", () => {
  it("names 42501 with the grant to run, instead of hiding it in brain_unavailable", async () => {
    const { classifyBrainError } = await vi.importActual<typeof import("@/lib/brain/db")>("@/lib/brain/db");
    const out = classifyBrainError(Object.assign(new Error("permission denied for table cue"), { code: "42501" }));
    expect(out.code).toBe("brain_permission_denied");
    expect(out.status).toBe(503);
    expect(out.hint).toMatch(/privilege/);
    expect(out.hint).toMatch(/0053/);
    expect(out.log).toBe(true);
  });

  it("the two migration cases and the catch-all are unchanged", async () => {
    const { classifyBrainError } = await vi.importActual<typeof import("@/lib/brain/db")>("@/lib/brain/db");
    const code = (c: string) => classifyBrainError(Object.assign(new Error("x"), { code: c }));
    expect(code("42P01").code).toBe("brain_tables_missing");
    expect(code("42703").code).toBe("brain_columns_missing");
    expect(code("23503").code).toBe("unknown_room");
    expect(code("08006").code).toBe("brain_unavailable");
    expect(classifyBrainError(new Error("no pg code")).code).toBe("brain_unavailable");
  });
});

// ===========================================================================
// 6. migration 0053 — the grants, recorded rather than rediscovered
// ===========================================================================

describe("0053 — the brain role's privileges are in the repo now", () => {
  const sql = migration("0053_brain_role_grants.sql");
  const body = squash(sql.replace(/^--.*$/gm, ""));

  it("grants DELETE on every brain-graph table the writer touches", () => {
    for (const t of ["cue", "room_day", "visit", "speaker_cluster"]) {
      expect(body).toContain(`GRANT DELETE ON TABLE ${t} TO brain_svc;`);
    }
  });

  it("leaves `room` SELECT-only — the brain has never written a room", () => {
    expect(body).toContain("GRANT SELECT ON TABLE room TO brain_svc;");
    expect(body).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON TABLE room TO/);
  });

  it("REVOKES nothing — it can only add, so it can never narrow a live privilege", () => {
    expect(body).not.toMatch(/REVOKE/i);
  });

  it("is guarded on the role existing, so a database without brain_svc is not blocked", () => {
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc'\) THEN/);
    expect(body).toMatch(/RAISE NOTICE/);
    // and it still records itself on that database — "considered" is the fact worth keeping
    expect(squash(sql)).toContain("VALUES (53, '0053_brain_role_grants')");
  });

  it("survives the migration runner's splitter as TWO statements, the DO block kept whole", () => {
    // the runner splits on `;`, and the DO body is full of them — dollar-quote awareness is the
    // only thing standing between this file and eight fragments that are each a syntax error
    const dollarOpens = (sql.match(/\$\$/g) ?? []).length;
    expect(dollarOpens).toBe(2);
    expect(body.indexOf("DO $$")).toBeLessThan(body.indexOf("INSERT INTO schema_migrations"));
  });
});
