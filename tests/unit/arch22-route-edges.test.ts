/**
 * Arch #22 — the two ROUTE edges the level sequence crosses, run through the real route handlers.
 *  Q7: GET /api/bench/commands must parse level_seq / level_at into the pollCommands input.
 *  Q6: GET /api/admin/bench/listeners must carry the stored `seq` through to `levels_stale`.
 * A mutant that hands null to either edge must fail here.
 */
import { describe, it, expect, vi } from "vitest";

type PollInput = { levelSeq?: number | null; levelCapturedAt?: string | null };
let lastPoll: PollInput | null = null;
let levelRows: Array<Record<string, unknown>> = [];
let sqlText = "";

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => { sqlText = strings.join("?"); return levelRows; },
}));
vi.mock("@/lib/bench-commands", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bench-commands")>("@/lib/bench-commands");
  return {
    ...actual,
    pollCommands: async (input: PollInput) => { lastPoll = input; return { now: "2026-10-08T10:00:00.000Z", superseded: false, commands: [] }; },
    listListeners: async () => [{
      room_id: "room_1", slug: "opd1", name: "OPD 1", age_ms: 1000, paused: false, recording_session_id: "bs_x", tab_id: "t",
      last_poll_at: new Date().toISOString(), mic_peak: 0.0125, mic_avg: 0.01, mic_zero_ratio: 0.1, spare_peak: null, spare_avg: null,
      spare_device: false, levels_at: new Date().toISOString(),
    }],
    isListening: () => true,
  };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));
vi.mock("@/lib/bench", () => ({ benchAdminGuard: async () => ({ ok: true }) }));

const commands = await import("@/app/api/bench/commands/route");
const listeners = await import("@/app/api/admin/bench/listeners/route");

const poll = async (query: Record<string, string>) => {
  lastPoll = null;
  const url = new URL("https://www.evenscribe.app/api/bench/commands");
  url.searchParams.set("tab_id", "app_install_test");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await commands.GET({ nextUrl: url } as unknown as Parameters<typeof commands.GET>[0]);
  expect(res.status).toBe(200);
  return lastPoll!;
};

describe("Q7 — /api/bench/commands parses level_seq and level_at into the pollCommands input", () => {
  it("level_seq=12&level_at=...Z reaches pollCommands as 12 and the normalised instant", async () => {
    const got = await poll({ mic_peak: "0.2", mic_avg: "0.1", level_seq: "12", level_at: "2026-10-08T10:00:00.000Z" });
    expect(got.levelSeq).toBe(12);
    expect(got.levelCapturedAt).toBe("2026-10-08T10:00:00.000Z");
  });
  it("an offset instant is normalised to UTC", async () => {
    const got = await poll({ mic_peak: "0.2", mic_avg: "0.1", level_seq: "0", level_at: "2026-10-08T15:30:00+05:30" });
    expect(got.levelSeq).toBe(0);
    expect(got.levelCapturedAt).toBe("2026-10-08T10:00:00.000Z");
  });
  it("absent, negative, fractional or non-numeric sequence is null (never 0); a bad instant is null", async () => {
    for (const bad of [undefined, "-1", "1.5", "abc", "", "1234567890123456"]) {
      const got = await poll({ mic_peak: "0.2", mic_avg: "0.1", ...(bad === undefined ? {} : { level_seq: bad }), level_at: "2026-10-08T10:00:00.000Z" });
      expect(got.levelSeq ?? null, `level_seq=${bad}`).toBeNull();
    }
    const got = await poll({ mic_peak: "0.2", mic_avg: "0.1", level_seq: "5", level_at: "yesterday" });
    expect(got.levelSeq).toBe(5);
    expect(got.levelCapturedAt ?? null).toBeNull();
  });
});

describe("Q6 — /api/admin/bench/listeners carries the stored seq through to levels_stale", () => {
  const NOW = Date.now();
  const row = (ago: number, peak: number, seq: number | null) => ({
    room_id: "room_1", sampled_at: new Date(NOW - ago), peak, avg: 0.01, zero_ratio: 0.1, ...(seq === null ? {} : { seq }),
  });
  const stale = async () => {
    const res = await listeners.GET();
    const body = await res.json();
    return body.listeners[0].levels_stale as boolean | null;
  };

  it("values keep changing but the sequence has stopped: levels_stale is TRUE (needs seq to reach the rule)", async () => {
    levelRows = [10_000, 8_000, 6_000, 4_000, 2_000, 500].map((ago, i) => row(ago, 0.01 + i * 0.002, 7));
    expect(await stale()).toBe(true);
    expect(sqlText).toContain("seq");
  });
  it("identical values but the sequence is advancing: levels_stale is FALSE", async () => {
    levelRows = [10_000, 8_000, 6_000, 4_000, 2_000, 500].map((ago, i) => row(ago, 0.0125, 100 + i));
    expect(await stale()).toBe(false);
  });
  it("the same rows WITHOUT a sequence fall back to the identical-run rule (the first case is then live, the second frozen)", async () => {
    levelRows = [10_000, 8_000, 6_000, 4_000, 2_000, 500].map((ago, i) => row(ago, 0.01 + i * 0.002, null));
    expect(await stale()).toBe(false);
    levelRows = [10_000, 8_000, 6_000, 4_000, 2_000, 500].map((ago) => row(ago, 0.0125, null));
    expect(await stale()).toBe(true);
  });
});
