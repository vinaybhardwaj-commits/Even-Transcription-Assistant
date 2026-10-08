/**
 * Arch #21 — a reap is a capture-failure event. One block per acceptance criterion.
 *   AC1 every reaper end alerts (outbox row + event) and surfaces on Bench attention
 *   AC2 a chunk recorded after a REAPED end is never appended to the ended session; real audio is re-homed (F3)
 *   AC3 the kiosk learns the session was reaped (chunk reply, both key spellings; native poll reply)
 *   AC4 reap during clinic hours reads differently from an end-of-day reap
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let notes: string | null = null;
let status = "ended";
let reapedLookup: unknown[] = [];
let existingRehome: unknown[] = [];
let r2Size = 4242;
let endedAt: string | null = "2026-10-07T06:56:31.000Z";   // 12:26:31 IST

let createdHome: string | null = null;
const respond = (text: string, values: unknown[]): unknown[] => {
  if (/SELECT id, ended_at, notes FROM bench_session/.test(text)) return reapedLookup;
  // the re-home transaction: lock, insert-if-none, widen+return
  if (/^INSERT INTO bench_session .* WHERE NOT EXISTS/.test(text)) {
    if (existingRehome.length === 0) createdHome = String(values[0]);
    return [];
  }
  if (/^UPDATE bench_session SET started_at = LEAST/.test(text)) {
    const id = (existingRehome[0] as { id: string } | undefined)?.id ?? createdHome;
    return id ? [{ id }] : [];
  }
  return [];
};
// A lazy query like neon's: it runs when awaited or when handed to sql.transaction, never on construction.
vi.mock("@/lib/db", () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      return {
        text, values,
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          calls.push({ text, values });
          return Promise.resolve(respond(text, values)).then(res, rej);
        },
      };
    },
    {
      transaction: async (qs: Array<{ text: string; values: unknown[] }>) => {
        txs.push(qs.map((q) => q.text));
        return qs.map((q) => { calls.push({ text: q.text, values: q.values }); return respond(q.text, q.values); });
      },
    },
  );
  return { sql };
});
const txs: string[][] = [];
vi.mock("@/lib/room-install", async (orig) => ({ ...((await orig()) as Record<string, unknown>), applyInstallPoll: async () => ({ ok: true, assigned_channel: null }) }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_test" }) }));
vi.mock("@/lib/r2", () => ({ headObject: async () => ({ size: r2Size }), benchChunkKey: () => "bench/room/2026-10-07/bs_t/9.webm" }));
vi.mock("@/lib/bench-window", () => ({ evaluateAndWriteWindows: async () => {}, istDateOf: () => "2026-10-07" }));
vi.mock("@/lib/bench", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findBenchSession: async () => ({
    id: "bs_t", room_id: "room_test", room_slug: "opd-4", started_at: "2026-10-07T03:30:00.000Z",
    status, ended_at: endedAt, notes,
  }),
}));
vi.mock("next/server", async (orig) => ({ ...((await orig()) as Record<string, unknown>), after: (fn: () => unknown) => { void Promise.resolve(fn()); } }));

const { POST } = await import("@/app/api/bench/chunks/route");
const core = await import("@/lib/bench-reaper-core");
const { reapBenchSessions } = await import("@/lib/bench-reaper");
const { computeAttention } = await import("@/lib/fleet-attention");

const post = async (startedAt: string) => {
  const req = { json: async () => ({ session_id: "bs_t", idx: 9, started_at: startedAt, ended_at: startedAt, duration_ms: 300000, size_bytes: 4242, gap_before_ms: 0 }) } as never;
  const res = await POST(req);
  const json = (await res.json()) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, json };
};
beforeEach(() => { existingRehome = []; createdHome = null; txs.length = 0; r2Size = 4242; calls.length = 0; notes = null; status = "ended"; endedAt = "2026-10-07T06:56:31.000Z"; });

describe("AC1 — every reap alerts and surfaces", () => {
  const NOW = Date.parse("2026-10-07T07:30:00.000Z");
  const cand = { id: "bs_wrnpdr4e", status: "recording", started_at: "2026-10-07T03:30:00.000Z", room_id: "room_opd4", room_name: "OPD4", last_primary_at: "2026-10-07T06:56:31.000Z" };
  it("writes an outbox row and a bench_event for the reaped session", async () => {
    const stmts: Call[] = [];
    const run = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join("?").replace(/\s+/g, " ").trim(); stmts.push({ text, values: v });
      if (/^SELECT s\.id/.test(text)) return [cand];
      if (/^UPDATE bench_session/.test(text)) return [{ id: "bs_wrnpdr4e" }];
      return [];
    }) as never;
    const res = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(res.reaped).toHaveLength(1);
    const ob = stmts.find((c) => /INSERT INTO room_alert_outbox/.test(c.text))!;
    expect(ob.values).toContain("session_reaped");
    expect(ob.values).toContain("room_opd4");
    expect(ob.values).toContain("clinic_hours");
    expect(ob.values.join(" ")).toContain("bs_wrnpdr4e");
    expect(ob.values.join(" ")).toContain("12:26 IST");          // last chunk time
    const ev = stmts.find((c) => /INSERT INTO bench_event/.test(c.text))!;
    expect(ev.values).toContain("session_reaped");
  });
  it("a failed alert write does not undo or hide the reap", async () => {
    const run = (async (s: TemplateStringsArray) => {
      const text = s.join("?");
      if (/^\s*SELECT s\.id/.test(text)) return [cand];
      if (/UPDATE bench_session/.test(text)) return [{ id: "bs_wrnpdr4e" }];
      if (/room_alert_outbox|bench_event/.test(text)) throw new Error("boom");
      return [];
    }) as never;
    const res = await reapBenchSessions({ now: new Date(NOW) }, run);
    expect(res.reaped).toHaveLength(1);
  });
  it("migration (placeholder 0199, GATING renumbers) admits the kind", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("db/migrations/0199_room_alert_outbox_session_reaped.sql", "utf8")).toContain("'session_reaped'");
  });
  const room = (reaped: unknown) => ({
    room_id: "room_opd4", room_name: "OPD4", machine: null, ext_events: [], poller: null, recent_activity: null, open_session: null,
    last_session_started_at: "2026-10-07T03:30:00.000Z", samples: [], chunks: [], windows: [], outbox: null, failed_start: null, reaped,
  });
  it("surfaces on Bench attention (red in clinic hours) until a session opens after it", () => {
    const at = "2026-10-07T07:30:00.000Z";
    const items = computeAttention({ now_ms: NOW + 60_000, rooms: [room({ created_at: at, body: "x", phase: "clinic_hours" })] } as never);
    const it0 = items.find((i) => i.kind === "session_reaped")!;
    expect(it0.severity).toBe("red");
    const recovered = computeAttention({ now_ms: NOW + 60_000, rooms: [{ ...room({ created_at: at, body: "x", phase: "clinic_hours" }), last_session_started_at: "2026-10-07T07:40:00.000Z" }] } as never);
    expect(recovered.some((i) => i.kind === "session_reaped")).toBe(false);
  });
});

describe("AC2 — a late chunk is never appended to a reaped session; real audio is re-homed into a DEDICATED session (refute F3, re-check R1-R5)", () => {
  const chunkInserts = () => calls.filter((c) => /INSERT INTO bench_chunk/.test(c.text));
  it("first late chunk: a new ENDED session carrying the exact re-home note is created, and the chunk lands in IT at idx 90 000 + n", async () => {
    notes = core.NOTE_STALL;
    const { status: st, json } = await post("2026-10-07T10:11:00.000Z");   // 15:41 IST, the OPD4 case
    expect(st).toBe(200);
    const mk = calls.find((c) => /^INSERT INTO bench_session/.test(c.text))!;
    expect(mk.text).toMatch(/'ended'/);
    expect(mk.values).toContain("re-homed after reap of bs_t");
    expect(mk.values).toContain("room_test");
    const ins = chunkInserts();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.values).not.toContain("bs_t");
    expect(ins[0]!.values).toContain(90_009);
    expect(ins[0]!.values).toContain("bench/room/2026-10-07/bs_t/9.webm");
    const ev = calls.find((c) => /INSERT INTO bench_event/.test(c.text) && /chunk_rehomed/.test(c.text))!;
    expect(ev).toBeTruthy();
    const payload = JSON.parse(String(ev.values.find((v) => typeof v === "string" && v.startsWith("{"))));
    expect(payload).toMatchObject({ reaped_session_id: "bs_t", original_idx: 9, chunk_source: "primary", r2_key: "bench/room/2026-10-07/bs_t/9.webm" });  // R1: recoverable by hand
    expect(json.upload_state).toBe("rehomed_after_reap");
    expect(json.rehomed_session_id).toBe(createdHome);
  });
  it("a later chunk of the SAME reaped session reuses its home (nothing new is created)", async () => {
    notes = core.NOTE_STALL;
    existingRehome = [{ id: "bs_home" }];
    const { json } = await post("2026-10-07T10:16:00.000Z");
    expect(calls.some((c) => /^INSERT INTO bench_session/.test(c.text) && c.values.includes("re-homed after reap of bs_t") && createdHome)).toBe(false);
    expect(json.rehomed_session_id).toBe("bs_home");
  });
  it("R1/R2: it NEVER re-homes into an open recording session — there is no such lookup any more", async () => {
    const src = readFileSync("app/api/bench/chunks/route.ts", "utf8");
    expect(src).not.toMatch(/status = 'recording'\s*ORDER BY/);
    expect(src).not.toMatch(/SELECT id FROM bench_session WHERE room_id = \$\{a\.roomId\} AND status/);
  });
  it("R4: create-or-get runs as ONE transaction that takes pg_advisory_xact_lock on the reaped session id FIRST, then inserts-if-none, then widens + returns", async () => {
    notes = core.NOTE_STALL;
    await post("2026-10-07T10:11:00.000Z");
    expect(txs).toHaveLength(1);
    expect(txs[0]![0]).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    expect(txs[0]![1]).toMatch(/^INSERT INTO bench_session .* WHERE NOT EXISTS/);
    expect(txs[0]![2]).toMatch(/^UPDATE bench_session SET started_at = LEAST.*RETURNING id/);
    const lock = calls.find((c) => /pg_advisory_xact_lock/.test(c.text))!;
    expect(lock.values).toContain("rehome:bs_t");
  });
  it("R5: every re-homed chunk widens the home's bounds with LEAST / GREATEST over the chunk's own times", async () => {
    notes = core.NOTE_STALL;
    existingRehome = [{ id: "bs_home" }];
    await post("2026-10-07T10:11:00.000Z");
    const up = calls.find((c) => /^UPDATE bench_session SET started_at = LEAST/.test(c.text))!;
    expect(up.text).toMatch(/started_at = LEAST\(started_at, \?::timestamptz\)/);
    expect(up.text).toMatch(/ended_at\s*=\s*GREATEST\(ended_at, \?::timestamptz\)/);
    expect(up.values).toContain("2026-10-07T10:11:00.000Z");
  });
  it("if re-homing is impossible (idx outside the band) it falls back to refusing: no row, event with the R2 key", async () => {
    notes = core.NOTE_STALL;
    const req = { json: async () => ({ session_id: "bs_t", idx: 50_000, started_at: "2026-10-07T10:11:00.000Z", ended_at: "2026-10-07T10:11:00.000Z", duration_ms: 1, size_bytes: 4242, gap_before_ms: 0 }) } as never;
    const json = (await (await POST(req)).json()) as Record<string, unknown>;
    expect(chunkInserts()).toHaveLength(0);
    expect(json.upload_state).toBe("refused_session_reaped");
    expect(calls.find((c) => /INSERT INTO bench_event/.test(c.text))!.text).toContain("chunk_refused_reaped");
  });
  it("an unverified R2 object creates nothing (no session from a bogus claim)", async () => {
    notes = core.NOTE_STALL; r2Size = 1;
    const { json } = await post("2026-10-07T10:11:00.000Z");
    expect(JSON.stringify(json)).toMatch(/r2_size_mismatch/);
    expect(calls.some((c) => /^INSERT INTO bench_session/.test(c.text))).toBe(false);
  });
  it("an OPERATOR-ended session keeps the old rule: chunk accepted into it", async () => {
    notes = null;
    const { json } = await post("2026-10-07T10:11:00.000Z");
    expect(chunkInserts()[0]!.values).toContain("bs_t");
    expect(json.upload_state).toBe("verified");
  });
  it("a flush chunk captured BEFORE the reap's ended_at still registers in the session (not a late chunk)", async () => {
    notes = core.NOTE_STALL;
    const { json } = await post("2026-10-07T06:50:00.000Z");
    expect(json.upload_state).toBe("verified");
    expect(chunkInserts()[0]!.values).toContain("bs_t");
  });
});

describe("AC3 — the kiosk learns", () => {
  it("chunk reply carries `disagreement` (browser) AND `ended_disagrees` (native decodes this key), re-homed or not", async () => {
    notes = core.NOTE_ROLLOVER;
    const { json } = await post("2026-10-07T10:11:00.000Z");
    expect(json.disagreement).toBe("ended_disagrees");
    expect(json.ended_disagrees).toBe("ended_disagrees");
  });
  it("poll reply names the reaped session for a native install reporting it as recording", async () => {
    const { pollCommands } = await import("@/lib/bench-commands");
    const input = { roomId: "room_test", tabId: "t1", prevPollAt: null, recordingSessionId: "bs_t", paused: false, install: { install_id: "ins_1" } } as never;
    reapedLookup = [{ id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z", notes: core.NOTE_STALL }];
    const out = (await pollCommands(input)) as Record<string, unknown>;
    expect(out.session_reaped).toEqual({ session_id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z" });
    reapedLookup = [{ id: "bs_t", ended_at: "2026-10-07T06:56:31.000Z", notes: "operator" }];
    expect(((await pollCommands(input)) as Record<string, unknown>).session_reaped).toBeUndefined();
    reapedLookup = [];
    // the browser kiosk (no install) never gets the key and never pays the lookup
    calls.length = 0;
    expect(((await pollCommands({ ...(input as object), install: undefined } as never)) as Record<string, unknown>).session_reaped).toBeUndefined();
    expect(calls.some((c) => /FROM bench_session/.test(c.text))).toBe(false);
  });
  it("isReaperNote recognises both reaper notes and nothing else", () => {
    expect(core.isReaperNote(core.NOTE_STALL)).toBe(true);
    expect(core.isReaperNote(`x\n${core.NOTE_ROLLOVER}`)).toBe(true);
    expect(core.isReaperNote("operator ended")).toBe(false);
    expect(core.isReaperNote(null)).toBe(false);
  });
});

describe("AC4 — clinic-hours reap vs end-of-day reap", () => {
  it("classifies by the IST time of the last audio", () => {
    expect(core.classifyReap("stall", "2026-10-07T06:56:31.000Z")).toBe("clinic_hours");   // 12:26 IST
    expect(core.classifyReap("stall", "2026-10-07T11:53:00.000Z")).toBe("clinic_hours");   // 17:23 IST (Dietary)
    expect(core.classifyReap("stall", "2026-10-07T14:00:00.000Z")).toBe("clinic_hours");   // 19:30 IST, consults still running
    expect(core.classifyReap("stall", "2026-10-07T15:59:00.000Z")).toBe("clinic_hours");   // 21:29 IST
    expect(core.classifyReap("stall", "2026-10-07T16:00:00.000Z")).toBe("overnight");      // 21:30 IST, day closed
    expect(core.classifyReap("stall", "2026-10-07T16:30:00.000Z")).toBe("overnight");      // 22:00 IST
    expect(core.classifyReap("stall", "2026-10-07T01:59:00.000Z")).toBe("overnight");      // 07:29 IST
    expect(core.classifyReap("stall", "2026-10-07T02:00:00.000Z")).toBe("clinic_hours");   // 07:30 IST
    expect(core.classifyReap("rollover", "2026-10-07T06:56:31.000Z")).toBe("overnight");
  });
  it("the copy differs and the clinic-hours copy says capture FAILED", () => {
    const a = core.reapAlertCopy({ roomName: "OPD4", sessionId: "bs_x", rule: "stall", lastAudioIso: "2026-10-07T06:56:31.000Z" });
    const b = core.reapAlertCopy({ roomName: "OPD4", sessionId: "bs_x", rule: "stall", lastAudioIso: "2026-10-07T16:30:00.000Z" });
    expect(a.body).not.toBe(b.body);
    expect(a.subject).toMatch(/clinic hours/);
    expect(a.body).toMatch(/FAILED/);
    expect(b.body).not.toMatch(/FAILED/);
  });
});

describe("R3 — a re-home container is never a start, never the room's newest session", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("the attention loader, the live monitor and the MCP door all exclude re-home sessions", () => {
    expect(read("lib/fleet-attention.ts")).toMatch(/s\.notes NOT LIKE \$\{REHOME_NOTE_PREFIX/);
    expect(read("lib/admin/rooms-live.ts")).toMatch(/s\.notes NOT LIKE \$\{REHOME_NOTE_PREFIX/);
    expect(read("lib/mcp/tools/bench.ts")).toMatch(/if \(isRehomeNote\(sn\.notes\)\) return acc;/);
  });
  it("the note helper and prefix agree with what the route writes", () => {
    expect(core.rehomeNote("bs_x")).toBe("re-homed after reap of bs_x");
    expect(core.isRehomeNote("re-homed after reap of bs_x")).toBe(true);
    expect(core.isRehomeNote("auto-ended: no chunks >30m (reaper)")).toBe(false);
    expect(core.isRehomeNote(null)).toBe(false);
  });
});
