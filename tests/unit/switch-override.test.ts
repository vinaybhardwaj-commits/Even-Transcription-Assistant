/**
 * V's ruling, 21 Sep 2026 — the backlog run may write a room whose own Transcript switch is OFF,
 * and the room's setting is not touched to allow it.
 *
 * The override is ONE REQUEST's fact: `switch_override: true` in the body of a `replay` batch to
 * /api/brain/cues. These drive the REAL route handler against a fake Postgres (the same approach as
 * speech-turns-k3) and the real room-switch reader, so what is asserted is what the guard DOES —
 * including the two things that make this safe to have added: an off room is still refused when the
 * override is absent, and one request's override leaves nothing behind for the next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;

// ── the app handle: this is where lib/room-switches reads `room` ─────────────────────────────────
const appCalls: Array<{ text: string; values: unknown[] }> = [];
let roomTranscriptOn = false;
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    appCalls.push({ text, values });
    if (/SELECT transcript_enabled, visits_enabled FROM room WHERE id/.test(text)) {
      return Promise.resolve([{ transcript_enabled: roomTranscriptOn, visits_enabled: false }]);
    }
    return Promise.resolve([]);
  },
}));

// ── the brain handle: the cue route's own transaction ────────────────────────────────────────────
const brainCalls: Array<{ text: string; values: unknown[] }> = [];
const runSql = (text: string, values: unknown[] = []) => {
  brainCalls.push({ text, values });
  const rows = brainDb(text, values);
  return { rows, rowCount: rows.length };
};
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    brainLog: (lvl: string, msg: string, extra: Row = {}) => { logged.push({ lvl, msg, extra }); },
    getPool: () => ({ connect: async () => ({ query: async (t: string, v?: unknown[]) => runSql(t, v ?? []), release: () => {} }) }),
    query: async (t: string, v?: unknown[]) => runSql(t, v ?? []),
  };
});

import { POST } from "@/app/api/brain/cues/route";
import { __resetRoomSwitchCache } from "@/lib/room-switches";
import { WINDOW_CUE_TYPE } from "@/lib/brain/state";

const ROOM_ID = "room_off_t";
const DAY_ID = "rd_off_t_20260819";
const SESSION_ID = "bs_a";
const WIN = { start_ms: Date.parse("2026-08-19T05:06:00Z"), end_ms: Date.parse("2026-08-19T05:08:00Z") };

let cueRows: Row[];
let dayScratch: boolean;
const logged: Array<{ lvl: string; msg: string; extra: Row }> = [];

const draft = (type: string, atMs: number) => ({
  type,
  at: new Date(atMs).toISOString(),
  payload: { window: WIN, session_id: SESSION_ID },
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
  if (/^DELETE FROM cue/.test(text)) return [];
  if (/^INSERT INTO cue/.test(text)) {
    const out: Row[] = [];
    for (let i = 0; i + 8 <= values.length; i += 8) {
      const [id, roomDayId, type, payload, at, sessionId, source, sourceRef] = values.slice(i, i + 8);
      cueRows.push({ id, room_day_id: roomDayId, type, payload: payload ? JSON.parse(String(payload)) : null, at, session_id: sessionId, source, source_ref: sourceRef });
      out.push({ id, at: new Date(String(at)), created_at: new Date() });
    }
    return out;
  }
  return [];
}

const post = (body: Row) =>
  POST(new Request("https://preview.example/api/brain/cues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  }));

const batchBody = (cues: unknown[], over: Row = {}) => ({
  room_id: ROOM_ID, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay",
  replace_window: { session_id: SESSION_ID, ...WIN }, cues, ...over,
});
const turns = () => [draft("stt_turn", WIN.start_ms + 1000), draft(WINDOW_CUE_TYPE, WIN.start_ms)];
const json = async (r: Response) => (await r.json()) as Row;

beforeEach(() => {
  cueRows = [];
  dayScratch = false;          // a LIVE day: the case the guard exists for
  roomTranscriptOn = false;    // the room's own switch is OFF
  brainCalls.length = 0;
  appCalls.length = 0;
  logged.length = 0;
  __resetRoomSwitchCache();
  process.env.BRAIN_SERVICE_TOKEN = "tok";
});

// ===========================================================================
// 1. the route
// ===========================================================================
describe("the route — the guard is unchanged for a request that does not carry the override", () => {
  it("an OFF room's live day is refused 409 not_a_scratch_day, and nothing is written", async () => {
    const res = await post(batchBody(turns()));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("not_a_scratch_day");
    expect(cueRows, "no cue landed").toHaveLength(0);
  });

  it("an ON room's live day is written, and the response has NO switch_override_used key — the shape is what it was", async () => {
    roomTranscriptOn = true;
    const res = await post(batchBody(turns()));
    expect(res.status).toBe(200);
    expect(Object.keys(await json(res))).not.toContain("switch_override_used");
    expect(cueRows.length).toBeGreaterThan(0);
  });
});

describe("the route — switch_override on a replay batch", () => {
  it("writes an OFF room's live day, says the override was USED, and logs it", async () => {
    const res = await post(batchBody(turns(), { switch_override: true }));
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.ok).toBe(true);
    expect(j.switch_override_used).toBe(true);
    expect(cueRows.length, "the turns and the marker landed").toBeGreaterThan(0);
    const line = logged.find((l) => l.msg === "switch_override_used");
    expect(line, "an override that was needed is logged").toBeTruthy();
    expect(line!.extra).toMatchObject({ room_id: ROOM_ID, room_day_id: DAY_ID, deleted: expect.any(Number), written: expect.any(Number) });
  });

  it("does NOT change the room's own switch — no UPDATE of `room` is issued by either handle", async () => {
    await post(batchBody(turns(), { switch_override: true }));
    const all = [...appCalls, ...brainCalls].map((c) => c.text);
    expect(all.filter((t) => /UPDATE room\b/i.test(t)), "the room row is never written").toHaveLength(0);
  });

  it("is per REQUEST: the next request without it is refused again — nothing was left open", async () => {
    expect((await post(batchBody(turns(), { switch_override: true }))).status).toBe(200);
    __resetRoomSwitchCache();
    const again = await post(batchBody(turns()));
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe("not_a_scratch_day");
  });

  it("on a room whose switch is ON it is sent but not needed: 200, used=false, and nothing is logged as an override", async () => {
    roomTranscriptOn = true;
    const j = await json(await post(batchBody(turns(), { switch_override: true })));
    expect(j.ok).toBe(true);
    expect(j.switch_override_used).toBe(false);
    expect(logged.some((l) => l.msg === "switch_override_used")).toBe(false);
  });

  it("on a SCRATCH day it is likewise not needed, and not used", async () => {
    dayScratch = true;
    const j = await json(await post(batchBody(turns(), { switch_override: true })));
    expect(j.ok).toBe(true);
    expect(j.switch_override_used).toBe(false);
  });

  it("the failure MARKER request (no replace_window) carries it too, so a failed window still records itself on an off room", async () => {
    const res = await post(batchBody([draft(WINDOW_CUE_TYPE, WIN.start_ms)], { replace_window: undefined, switch_override: true }));
    expect(res.status).toBe(200);
    expect((await json(res)).switch_override_used).toBe(true);
  });
});

describe("the route — a malformed override is REFUSED BY NAME, before any lock, never ignored", () => {
  for (const bad of [false, "true", 1, 0, null, [], {}]) {
    it(`switch_override=${JSON.stringify(bad)} → 400 invalid_switch_override, no lock, no write`, async () => {
      const res = await post(batchBody(turns(), { switch_override: bad }));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_switch_override");
      expect(brainCalls, "refused before the lock is taken").toHaveLength(0);
      expect(cueRows).toHaveLength(0);
    });
  }

  it("the DELETE-ONLY shape (`cues: []` + replace_window) with the override → 400 switch_override_requires_cues, nothing deleted (Reviewer finding C)", async () => {
    const res = await post(batchBody([], { switch_override: true }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("switch_override_requires_cues");
    expect(brainCalls, "refused before the lock, so no DELETE was issued").toHaveLength(0);
  });

  it("…while the same delete-only call WITHOUT the override is untouched on a room whose switch is on (K3 §7's cleanup still works)", async () => {
    roomTranscriptOn = true;
    const res = await post(batchBody([]));
    expect(res.status).toBe(200);
  });

  it("a batch whose source is not 'replay' → 400 switch_override_requires_replay_batch", async () => {
    const res = await post(batchBody(turns(), { source: "live_room", switch_override: true }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("switch_override_requires_replay_batch");
    expect(brainCalls).toHaveLength(0);
  });

  it("a SINGLE-cue request (no `cues`) → 400 switch_override_requires_replay_batch — the single-cue paths get no hole", async () => {
    const res = await post({
      room_id: ROOM_ID, room_day_id: DAY_ID, session_id: SESSION_ID, source: "replay",
      type: "stt_turn", payload: {}, switch_override: true,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("switch_override_requires_replay_batch");
    expect(brainCalls).toHaveLength(0);
  });

  it("a LIVE cue (no room_day_id at all) carrying it is refused too", async () => {
    const res = await post({ room_id: ROOM_ID, type: "note", payload: {}, switch_override: true });
    expect(res.status).toBe(400);
    expect(brainCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 2. the writer that sends it
// ===========================================================================
describe("writeWindowCues — the override is on the wire only when asked for", () => {
  const origFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>>;
  let respond: (n: number) => { status: number; body: Record<string, unknown> };

  beforeEach(() => {
    sent = [];
    respond = () => ({ status: 200, body: { ok: true, deleted: 0, written: 2, already_existed: 0, dropped: 0, attempted: 2 } });
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const r = respond(sent.length);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  const call = async (opts?: { switchOverride?: boolean }) => {
    const { writeWindowCues, buildWindowCue } = await import("@/lib/mcp/tools/bench");
    return writeWindowCues(
      "https://x.test", ROOM_ID, DAY_ID, SESSION_ID, { startMs: WIN.start_ms, endMs: WIN.end_ms }, [],
      (complete, stoppedEarly) => buildWindowCue({
        engine: "whisper", sessionId: SESSION_ID, windowStartMs: WIN.start_ms, windowEndMs: WIN.end_ms,
        complete, segmentCount: 0, language: null, sourceUsed: "primary", stoppedEarly,
      }),
      ...(opts === undefined ? [] : [opts]),
    );
  };

  it("with no option the body has NO switch_override key — byte-identical to before", async () => {
    await call();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!)).not.toContain("switch_override");
    await call({});
    await call({ switchOverride: false });
    for (const b of sent) expect(Object.keys(b)).not.toContain("switch_override");
  });

  it("with { switchOverride: true } the whole-window request carries switch_override:true", async () => {
    await call({ switchOverride: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.switch_override).toBe(true);
    expect(sent[0]!.source).toBe("replay");
    expect(sent[0]!.replace_window, "still one request replacing the window").toBeTruthy();
  });

  it("when the whole write fails, the follow-up MARKER request carries it as well", async () => {
    respond = (n) => (n === 1 ? { status: 500, body: { ok: false, error: "brain_500" } } : { status: 200, body: { ok: true, deleted: 0, written: 1, already_existed: 0, dropped: 0, attempted: 1 } });
    await call({ switchOverride: true });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.switch_override).toBe(true);
    expect(sent[1]!.switch_override).toBe(true);
    expect(sent[1]!.replace_window, "the marker request still issues no delete").toBeUndefined();
  });

  it("only the literal true counts — a truthy non-boolean is not sent", async () => {
    await call({ switchOverride: "yes" as unknown as boolean });
    expect(Object.keys(sent[0]!)).not.toContain("switch_override");
  });
});
