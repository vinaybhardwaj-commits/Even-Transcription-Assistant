/**
 * U1 — replay a finished day (ETA-MCP-UPGRADE PRD §6). The pure shaping behind
 * scribe_replay_session: which events become cues, the total order that makes two runs
 * byte-identical, the session window taken from the first and last piece recorded, and the
 * cap that says so out loud instead of truncating in silence.
 *
 * There is no write path in this build, so there is nothing here to assert about writes
 * beyond the tool's own shape: every function under test is pure, and the handler's only
 * database calls are the three SELECT helpers in lib/bench.
 */
import { describe, it, expect } from "vitest";
import {
  BENCH_TOOLS,
  buildReplayCues,
  REPLAY_DEFAULT_LIMIT,
  REPLAY_DROPPED_PAYLOAD_FIELDS,
  REPLAY_KINDS,
  REPLAY_MAX_LIMIT,
  replayPayload,
  tapeEndMs,
  tapeStartMs,
} from "@/lib/mcp/tools/bench";
import { makeFakeClinician } from "../support/fake-identity";

const FAKE_DOC = makeFakeClinician(7);

const T0 = Date.parse("2026-08-19T04:00:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

const ev = (id: string, kind: string, atMs: number, payload: unknown = {}) => ({ id, kind, at: iso(atMs), payload });
const chunk = (startMs: number, endMs: number, source: "primary" | "backup" = "primary") => ({
  source,
  started_at: iso(startMs),
  ended_at: iso(endMs),
});

describe("1 — time order, and ties that break the same way every run", () => {
  it("cues come back oldest first", () => {
    const out = buildReplayCues([
      ev("be_c", "consult_mark", T0 + min(9)),
      ev("be_a", "mic_primary_lost", T0 + min(2)),
      ev("be_b", "consult_mark", T0 + min(5)),
    ]);
    expect(out.cues.map((c) => c.event_id)).toEqual(["be_a", "be_b", "be_c"]);
    expect(out.cues.map((c) => c.at)).toEqual([iso(T0 + min(2)), iso(T0 + min(5)), iso(T0 + min(9))]);
  });

  it("same instant → kind, then row id; and the input order never leaks into the output", () => {
    // Three rows on the same millisecond: two kinds, and two ids inside one kind.
    const rows = [
      ev("be_z", "mic_primary_lost", T0),
      ev("be_a", "mic_primary_lost", T0),
      ev("be_m", "consult_mark", T0),
    ];
    const expected = ["be_m", "be_a", "be_z"]; // consult_mark < mic_primary_lost; be_a < be_z
    expect(buildReplayCues(rows).cues.map((c) => c.event_id)).toEqual(expected);
    // every permutation of the same rows lands on the same list
    for (const perm of [
      [rows[2]!, rows[1]!, rows[0]!],
      [rows[1]!, rows[0]!, rows[2]!],
      [rows[0]!, rows[2]!, rows[1]!],
    ]) {
      expect(buildReplayCues(perm).cues.map((c) => c.event_id)).toEqual(expected);
    }
  });
});

describe("2 — only the seven listed kinds are emitted", () => {
  it("handover and tab-gone rows are excluded; every listed kind survives", () => {
    const rows = [
      ...REPLAY_KINDS.map((k, i) => ev(`be_${i}`, k, T0 + min(i))),
      ev("be_h", "kiosk_handover_complete", T0 + min(20)),
      ev("be_t", "kiosk_tab_gone", T0 + min(21)),
      ev("be_s", "stt_turn", T0 + min(22)), // a speech turn is a different job — not replayed
      ev("be_l", "live_sink_stats", T0 + min(23)),
    ];
    const out = buildReplayCues(rows);
    expect(out.cues.map((c) => c.type).sort()).toEqual([...REPLAY_KINDS].sort());
    expect(out.total).toBe(REPLAY_KINDS.length);
    for (const excluded of ["kiosk_handover_complete", "kiosk_tab_gone", "stt_turn", "live_sink_stats"]) {
      expect(out.cues.some((c) => c.type === excluded)).toBe(false);
    }
  });

  it("the seven are exactly the marks, the microphone events and the rejoin event", () => {
    expect([...REPLAY_KINDS]).toEqual([
      "consult_mark",
      "mic_primary_lost",
      "mic_primary_restored",
      "mic_backup_unavailable",
      "mic_backup_error",
      "mic_backup_restored",
      "kiosk_remount_resumed",
    ]);
  });
});

describe("3 — every cue carries source 'replay' and its originating row id", () => {
  it("type, at and payload are the row's own; source is replay; event_id traces back", () => {
    const out = buildReplayCues([
      ev("be_1", "mic_primary_lost", T0 + min(4), { reason: "track_ended", idx: 3, source: "kiosk" }),
      ev("be_2", "kiosk_remount_resumed", T0 + min(8), { silence_seconds: 78, next_idx: { primary: 4, backup: 4 } }),
    ]);
    expect(out.cues).toEqual([
      {
        type: "mic_primary_lost",
        at: iso(T0 + min(4)),
        payload: { idx: 3, reason: "track_ended", source: "kiosk" },
        source: "replay",
        event_id: "be_1",
      },
      {
        type: "kiosk_remount_resumed",
        at: iso(T0 + min(8)),
        payload: { next_idx: { primary: 4, backup: 4 }, silence_seconds: 78 },
        source: "replay",
        event_id: "be_2",
      },
    ]);
  });

  it("payload fields that could carry a name are dropped and named; operational fields pass through", () => {
    const out = buildReplayCues([
      ev("be_1", "consult_mark", T0, { source: "mcp", note: `${FAKE_DOC.label}, room 7` }),
      ev("be_2", "mic_backup_error", T0 + min(1), { stage: "start", message: "NotFoundError: device", idx: 2 }),
    ]);
    expect(out.cues[0]!.payload).toEqual({ source: "mcp" });
    expect(out.cues[1]!.payload).toEqual({ idx: 2, stage: "start" });
    expect(out.dropped_payload_fields).toEqual(["message", "note"]);
    // a payload with nothing to drop reports nothing
    expect(buildReplayCues([ev("be_3", "consult_mark", T0, { source: "kiosk" })]).dropped_payload_fields).toEqual([]);
    // and every listed field is filtered, wherever it turns up
    const all = Object.fromEntries(REPLAY_DROPPED_PAYLOAD_FIELDS.map((f) => [f, FAKE_DOC.label]));
    const filtered = replayPayload({ ...all, reason: "silence" });
    expect(filtered.payload).toEqual({ reason: "silence" });
    expect(filtered.dropped.sort()).toEqual([...REPLAY_DROPPED_PAYLOAD_FIELDS].sort());
  });

  it("a null or non-object payload becomes an empty payload, never null", () => {
    expect(replayPayload(null)).toEqual({ payload: {}, dropped: [] });
    expect(replayPayload("string")).toEqual({ payload: {}, dropped: [] });
    expect(replayPayload([1, 2])).toEqual({ payload: {}, dropped: [] });
  });
});

describe("4 — the session window comes from the first and last piece, not the stored end time", () => {
  it("first piece starts the window, last piece ends it, across BOTH microphones", () => {
    const chunks = [
      chunk(T0 + min(2), T0 + min(7), "primary"),
      chunk(T0 + min(7), T0 + min(12), "primary"),
      chunk(T0 + min(1), T0 + min(6), "backup"), // earlier on the backup mic → it starts the window
      chunk(T0 + min(12), T0 + min(17), "backup"), // later on the backup mic → it ends the window
    ];
    expect(tapeStartMs(chunks)).toBe(T0 + min(1));
    expect(tapeEndMs(chunks)).toBe(T0 + min(17));
    // a stored ended_at hours later (bs_j9wgfa33's shape) is nowhere in this window
    expect(tapeEndMs(chunks)).not.toBe(T0 + min(300));
  });

  it("no pieces → both ends null, never invented and never the session row's own times", () => {
    expect(tapeStartMs([])).toBeNull();
    expect(tapeEndMs([])).toBeNull();
  });
});

describe("5 — over the limit the list is cut short, says so, and reports the true total", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ev(`be_${String(i).padStart(4, "0")}`, "consult_mark", T0 + i * 1000));

  it("the first `limit` in time order come back, with truncated true and the real count", () => {
    const out = buildReplayCues(many(12), 5);
    expect(out.emitted).toBe(5);
    expect(out.cues).toHaveLength(5);
    expect(out.total).toBe(12);
    expect(out.truncated).toBe(true);
    expect(out.cues.map((c) => c.event_id)).toEqual(["be_0000", "be_0001", "be_0002", "be_0003", "be_0004"]);
  });

  it("at or under the limit nothing is cut and truncated is false", () => {
    expect(buildReplayCues(many(5), 5)).toMatchObject({ emitted: 5, total: 5, truncated: false });
    expect(buildReplayCues(many(3), 5)).toMatchObject({ emitted: 3, total: 3, truncated: false });
  });

  it("the total counts replayable events only — excluded kinds never inflate it", () => {
    const out = buildReplayCues([...many(4), ev("be_h", "kiosk_handover_complete", T0), ev("be_t", "kiosk_tab_gone", T0)], 2);
    expect(out.total).toBe(4);
    expect(out.truncated).toBe(true);
  });

  it("the default is 500 and the tool's schema caps at 1000", () => {
    expect(REPLAY_DEFAULT_LIMIT).toBe(500);
    expect(REPLAY_MAX_LIMIT).toBe(1000);
    expect(buildReplayCues(many(501)).emitted).toBe(REPLAY_DEFAULT_LIMIT);
    const tool = BENCH_TOOLS.find((t) => t.name === "scribe_replay_session")!;
    const limit = (tool.inputSchema.properties as { limit: { default: number; maximum: number; minimum: number } }).limit;
    expect(limit).toMatchObject({ default: REPLAY_DEFAULT_LIMIT, maximum: REPLAY_MAX_LIMIT, minimum: 1 });
  });
});

describe("6 — the same input twice produces identical output", () => {
  const rows = [
    ev("be_5", "kiosk_remount_resumed", T0 + min(30), { silence_seconds: 12, next_idx: { primary: 7, backup: 7 } }),
    ev("be_1", "consult_mark", T0 + min(2), { source: "kiosk" }),
    ev("be_4", "mic_primary_restored", T0 + min(20), { reason: "audio_resumed", idx: 4 }),
    ev("be_3", "mic_primary_lost", T0 + min(20), { reason: "silence", idx: 4 }),
    ev("be_2", "consult_mark", T0 + min(2), { source: "mcp", note: "drop me" }),
    ev("be_x", "kiosk_tab_gone", T0 + min(40), {}),
  ];

  it("byte-identical JSON on a second run", () => {
    const a = JSON.stringify(buildReplayCues(rows));
    const b = JSON.stringify(buildReplayCues(rows));
    expect(a).toBe(b);
  });

  it("byte-identical even when the rows arrive in a different order or with shuffled payload keys", () => {
    const shuffled = [...rows].reverse().map((r) => ({
      ...r,
      payload: Object.fromEntries(Object.entries(r.payload as Record<string, unknown>).reverse()),
    }));
    expect(JSON.stringify(buildReplayCues(shuffled))).toBe(JSON.stringify(buildReplayCues(rows)));
  });
});

describe("the tool itself — read scope, registered, and no write path", () => {
  it("scribe_replay_session is registered as a read tool", () => {
    const tool = BENCH_TOOLS.find((t) => t.name === "scribe_replay_session");
    expect(tool).toBeDefined();
    expect(tool!.scope).toBe("read");
    expect(tool!.inputSchema.required).toEqual(["session_id"]);
  });

  it("the description states the dry run and the natural key a later writer inherits", () => {
    const d = BENCH_TOOLS.find((t) => t.name === "scribe_replay_session")!.description;
    expect(d).toMatch(/DRY RUN/);
    expect(d).toMatch(/WRITE NOTHING/);
    expect(d).toMatch(/\(session_id, type, at\)/);
  });
});
