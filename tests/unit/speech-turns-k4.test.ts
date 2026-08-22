/**
 * Speech turns, slice A — kickoff K4, the marker survives the write it reports on.
 *
 * WHAT WENT WRONG. The `complete: false` marker never landed when the hole window failed, and the
 * reason was structural rather than a slip: the fallback marker carried the SAME `replace_window`
 * as the primary write, so it needed the same DELETE, so it died of the same missing grant. The
 * guarantee "a reader can tell we asked and failed from we never asked" was never actually
 * implemented, because its implementation depended on the thing that had just broken.
 *
 * A marker that shares a failure mode with the thing it reports is not a record.
 *
 * Four things are proved here:
 *
 *   1. The window DELETE no longer touches stt_window — two types, not three. That is the change
 *      that makes the rest work, and it is the one that is easy to miss.
 *   2. The marker is an UPSERT: DO UPDATE SET payload, arbitrating on 0052's index (which still
 *      carries stt_window — the index list and the delete list are different lists).
 *   3. The failed path sends a request with NO replace_window, so it issues no DELETE and cannot
 *      fail for the reason the primary write failed. And if even that fails, the answer says the
 *      day holds no record rather than letting a row of zeros imply one.
 *   4. `dropped` means within-write key conflicts and nothing else. A transport failure reports
 *      `failed`, with a reason.
 *
 * NO MIGRATION. 0052 already admits stt_window to cue_turn_natural_key, which is exactly the
 * arbiter this upsert infers on. Every change in this slice is code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;

const brainCalls: Array<{ text: string; values: unknown[] }> = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];
const runSql = (text: string, values: unknown[] = []) => {
  brainCalls.push({ text, values });
  const rows = brainResponder(text, values);
  return { rows, rowCount: rows.length };
};
vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]) }));
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
  SQL_CUE_UPSERT_WINDOW,
  WINDOW_CUE_TYPE,
  WINDOW_DELETED_TYPES,
  TURN_KEYED_TYPES,
  buildTurnBatchInsert,
} from "@/lib/brain/state";
import { failureReason } from "@/lib/mcp/tools/bench";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const migration = (n: string) => readFileSync(join(process.cwd(), "db", "migrations", n), "utf8");

// ===========================================================================
// 1. the delete stops touching the marker
// ===========================================================================

describe("the window delete — two types, and the third one's absence is the slice", () => {
  it("no longer matches stt_window", () => {
    const s = squash(SQL_CUE_DELETE_WINDOW);
    expect(s).toContain("type IN ('stt_turn', 'stt_silence')");
    expect(s).not.toContain("stt_window");
    expect(s).not.toContain("speaker_match");
    expect([...WINDOW_DELETED_TYPES]).toEqual(["stt_turn", "stt_silence"]);
  });

  it("BUT stt_window stays in the KEY — the index list and the delete list are different lists", () => {
    // Removing it from the index would break the marker entirely: that index IS the arbiter the
    // upsert infers on. Only the delete lost the name.
    expect([...TURN_KEYED_TYPES]).toContain("stt_window");
    expect(squash(SQL_CUE_UPSERT_WINDOW)).toContain("'stt_turn', 'stt_silence', 'stt_window', 'speaker_match'");
    expect(squash(buildTurnBatchInsert(1))).toContain("'stt_turn', 'stt_silence', 'stt_window', 'speaker_match'");
    // and 0052, which production already ran, is untouched by this slice
    expect(migration("0052_stt_window_type.sql")).toContain("'stt_turn', 'stt_silence', 'stt_window', 'speaker_match'");
  });
});

// ===========================================================================
// 2. the marker upsert
// ===========================================================================

describe("SQL_CUE_UPSERT_WINDOW — DO UPDATE, and only payload", () => {
  const s = squash(SQL_CUE_UPSERT_WINDOW);

  it("arbitrates on 0052's index, predicate repeated verbatim", () => {
    const fromIndex = squash(migration("0052_stt_window_type.sql").replace(/^--.*$/gm, ""))
      .match(/cue_turn_natural_key ON cue \(source_ref, type\) (WHERE .*?);/)![1]!;
    expect(s).toContain(`ON CONFLICT (source_ref, type) ${fromIndex}`);
  });

  it("SETS PAYLOAD AND NOTHING ELSE — `at` and source_ref cannot drift, created_at keeps the first ask", () => {
    expect(s).toContain("DO UPDATE SET payload = EXCLUDED.payload");
    expect(s).not.toMatch(/SET[^;]*\bat\s*=/);
    expect(s).not.toMatch(/created_at\s*=/);
    expect(s).not.toMatch(/source_ref\s*=\s*EXCLUDED/);
    expect(s).toContain("RETURNING id, at, created_at");
  });

  it("is a SEPARATE statement from the turn batch — two conflict actions cannot share one", () => {
    expect(squash(buildTurnBatchInsert(1))).toContain("DO NOTHING");
    expect(s).toContain("DO UPDATE");
    expect(squash(buildTurnBatchInsert(3))).not.toContain("DO UPDATE");
  });
});

// ===========================================================================
// 3. through the real route
// ===========================================================================

const ROOM_ID = "room_scratch_t";
const DAY_ID = "rd_scratch_t_20260819";
const SESSION_ID = "bs_a";
const WIN = { start_ms: Date.parse("2026-08-19T05:06:00Z"), end_ms: Date.parse("2026-08-19T05:08:00Z") };
const MARKER_REF = `${SESSION_ID}|${WIN.start_ms}|${WIN.end_ms}|window`;

let cueRows: Row[];
let dayScratch: boolean;

const turn = (i: number) => ({
  type: "stt_turn",
  at: new Date(WIN.start_ms + i * 100).toISOString(),
  payload: { window: WIN },
  source_ref: `${SESSION_ID}|${WIN.start_ms + i * 100}|${WIN.start_ms + i * 100 + 50}|-`,
});
const marker = (complete: boolean, extra: Row = {}) => ({
  type: WINDOW_CUE_TYPE,
  at: new Date(WIN.start_ms).toISOString(),
  payload: { window: WIN, complete, ...extra },
  source_ref: MARKER_REF,
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
    // the fake enforces the REAL type list — if the statement ever readmits stt_window this
    // model will start deleting markers and the tests below will say so
    const types = squash(SQL_CUE_DELETE_WINDOW).match(/type IN \(([^)]*)\)/)![1]!.split(",").map((t) => t.trim().replace(/'/g, ""));
    const gone = cueRows.filter((r) => {
      const w = (r.payload as Row | null)?.window as Row | undefined;
      return r.room_day_id === roomDayId && r.session_id === sessionId && r.source === "replay" &&
        types.includes(String(r.type)) && Number(w?.start_ms) === Number(startMs) && Number(w?.end_ms) === Number(endMs);
    });
    cueRows = cueRows.filter((r) => !gone.includes(r));
    return gone.map((r) => ({ id: r.id }));
  }
  if (/^INSERT INTO cue/.test(text) && /DO UPDATE SET payload/.test(text)) {
    const [id, roomDayId, type, payload, at, sessionId, source, sourceRef] = values;
    const existing = cueRows.find((r) => r.source === "replay" && r.source_ref === sourceRef && r.type === type);
    if (existing) {
      // DO UPDATE: payload replaced, created_at UNTOUCHED — the first ask is kept
      existing.payload = payload ? JSON.parse(String(payload)) : null;
      return [{ id: existing.id, at: new Date(String(existing.at)), created_at: existing.created_at }];
    }
    const created = new Date("2026-08-22T07:00:00Z");
    cueRows.push({ id, room_day_id: roomDayId, type, payload: payload ? JSON.parse(String(payload)) : null, at, session_id: sessionId, source, source_ref: sourceRef, created_at: created });
    return [{ id, at: new Date(String(at)), created_at: created }];
  }
  if (/^INSERT INTO cue/.test(text)) {
    const out: Row[] = [];
    for (let i = 0; i + 8 <= values.length; i += 8) {
      const [id, roomDayId, type, payload, at, sessionId, source, sourceRef] = values.slice(i, i + 8);
      if (cueRows.some((r) => r.source === "replay" && r.source_ref === sourceRef && r.type === type)) continue;
      cueRows.push({ id, room_day_id: roomDayId, type, payload: payload ? JSON.parse(String(payload)) : null, at, session_id: sessionId, source, source_ref: sourceRef, created_at: new Date() });
      out.push({ id, at: new Date(String(at)), created_at: new Date() });
    }
    return out;
  }
  return [];
}

const post = async (body: Row) =>
  POST(new Request("https://preview.example/api/brain/cues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));

const base = { room_id: ROOM_ID, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay" };
const replace = { replace_window: { session_id: SESSION_ID, ...WIN } };

beforeEach(() => {
  cueRows = [];
  dayScratch = true;
  brainCalls.length = 0;
  brainResponder = brainDb;
  process.env.BRAIN_SERVICE_TOKEN = "tok";
});

describe("the window delete leaves the marker standing", () => {
  it("THE HEADLINE: a replace removes the turns and does NOT remove the stt_window for the same pair", async () => {
    // an earlier run left three turns and a marker, all with the same payload.window
    cueRows.push(
      { id: "t1", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "a", payload: { window: WIN } },
      { id: "t2", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_silence", source_ref: "b", payload: { window: WIN } },
      { id: "m1", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: WINDOW_CUE_TYPE, source_ref: MARKER_REF, at: new Date(WIN.start_ms), payload: { window: WIN, complete: false }, created_at: new Date("2026-08-22T06:00:00Z") },
    );
    const res = await post({ ...base, ...replace, cues: [turn(0), marker(true)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 2, ok: true });
    // the marker row still exists — and it is the SAME row, updated, not a replacement
    const markers = cueRows.filter((r) => r.type === WINDOW_CUE_TYPE);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.id).toBe("m1");
  });

  it("a marker upsert on an existing key REPLACES payload and KEEPS created_at", async () => {
    const firstAsk = new Date("2026-08-22T06:00:00Z");
    cueRows.push({ id: "m1", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: WINDOW_CUE_TYPE, source_ref: MARKER_REF, at: new Date(WIN.start_ms), payload: { window: WIN, complete: false, stopped_early: "boom" }, created_at: firstAsk });
    await post({ ...base, cues: [marker(true, { segment_count: 165 })] });
    const m = cueRows.find((r) => r.type === WINDOW_CUE_TYPE)!;
    expect((m.payload as Row).complete).toBe(true);
    expect((m.payload as Row).segment_count).toBe(165);
    // the earlier failure's reason is gone with the payload it belonged to
    expect((m.payload as Row).stopped_early).toBeUndefined();
    // created_at keeps the FIRST ask — "when did we first look at this window" has one answer
    expect(m.created_at).toBe(firstAsk);
  });

  it("the successful path issues TWO insert statements — DO NOTHING for turns, DO UPDATE for the marker", async () => {
    await post({ ...base, ...replace, cues: [turn(0), turn(1), marker(true)] });
    const inserts = brainCalls.filter((c) => /^INSERT INTO cue/.test(c.text));
    expect(inserts).toHaveLength(2);
    expect(inserts.filter((c) => /DO NOTHING/.test(c.text))).toHaveLength(1);
    expect(inserts.filter((c) => /DO UPDATE SET payload/.test(c.text))).toHaveLength(1);
    // the marker was NOT folded into the batch: the DO NOTHING statement carries two rows, not three
    expect(inserts.find((c) => /DO NOTHING/.test(c.text))!.values).toHaveLength(16);
    // …and both ran inside the one transaction
    const commit = brainCalls.findIndex((c) => /^COMMIT/.test(c.text));
    for (const ins of inserts) expect(brainCalls.indexOf(ins)).toBeLessThan(commit);
  });
});

describe("the marker request needs no DELETE", () => {
  it("a batch with NO replace_window issues no DELETE at all — confirmed, not assumed", async () => {
    cueRows.push({ id: "keep", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: "a", payload: { window: WIN } });
    const res = await post({ ...base, cues: [marker(false, { stopped_early: "brain_permission_denied", segment_count: 162 })] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 0, written: 1 });
    expect(brainCalls.some((c) => /^DELETE FROM cue/.test(c.text))).toBe(false);
    // the earlier turn is untouched: this request claims nothing about the turns
    expect(cueRows.some((r) => r.id === "keep")).toBe(true);
    const m = cueRows.find((r) => r.type === WINDOW_CUE_TYPE)!;
    expect((m.payload as Row)).toMatchObject({ complete: false, stopped_early: "brain_permission_denied", segment_count: 162 });
  });

  it("the marker still lands on a day where every turn row was left behind by a failed delete", async () => {
    // the exact production shape: the DELETE verb is unavailable, so the primary write died
    for (let i = 0; i < 144; i++) {
      cueRows.push({ id: `stale${i}`, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: `s${i}`, payload: { window: WIN } });
    }
    const res = await post({ ...base, cues: [marker(false, { stopped_early: "brain_permission_denied", segment_count: 162 })] });
    expect(res.status).toBe(200);
    expect(cueRows.filter((r) => r.type === WINDOW_CUE_TYPE)).toHaveLength(1);
  });
});

// ===========================================================================
// 4. dropped vs failed
// ===========================================================================

describe("failureReason — the three kinds that call for different action", () => {
  it("names permission, transport and incomplete_write", () => {
    expect(failureReason("brain_permission_denied")).toBe("permission");
    for (const e of ["brain_timeout", "brain_unreachable", "service_token_not_configured"]) {
      expect(failureReason(e)).toBe("transport");
    }
    for (const e of ["not_a_scratch_day", "brain_500", "anything_else"]) {
      expect(failureReason(e)).toBe("incomplete_write");
    }
  });
});

describe("`dropped` counts key conflicts and nothing else", () => {
  it("a clean window reports dropped 0", async () => {
    const res = await post({ ...base, ...replace, cues: [turn(0), turn(1), marker(true)] });
    expect(await res.json()).toMatchObject({ dropped: 0, already_existed: 0, written: 3 });
  });

  it("a duplicate key INSIDE the batch is a drop, and it is the only thing that is", async () => {
    const dup = turn(0);
    const res = await post({ ...base, ...replace, cues: [turn(0), dup, turn(1), marker(true)] });
    // 3 turn rows attempted, 2 land, 1 collided with its own sibling
    expect(await res.json()).toMatchObject({ dropped: 1, already_existed: 0 });
  });

  it("a row that SURVIVED the delete is already_existed, not a drop — the two are different bugs", async () => {
    // a turn whose payload.window does not match, so the delete cannot reach it, but whose key
    // collides with one of the incoming rows
    cueRows.push({ id: "ghost", room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay", type: "stt_turn", source_ref: turn(0).source_ref, payload: { window: { start_ms: 1, end_ms: 2 } } });
    const res = await post({ ...base, ...replace, cues: [turn(0), turn(1), marker(true)] });
    expect(await res.json()).toMatchObject({ dropped: 0, already_existed: 1 });
  });
});
