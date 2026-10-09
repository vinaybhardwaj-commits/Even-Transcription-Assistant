/**
 * tests/unit/nemotron-clip-join.test.ts — Nemotron-only clip cutting.
 *
 * The cutter refuses blind room-days itself, fails closed when it cannot prove a window clear, and
 * the cron route ships dark. Window ids only; no room slugs beyond the fixed blind-set ids.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({
  statements: [] as string[],
  sqlCalls: 0,
  lookup: "clear" as "clear" | "blind" | "null_day" | "no_row" | "throws",
  joinCalls: 0,
  joinRequests: [] as unknown[],
  list: [] as Array<{ window_id: string; transcript_enabled: boolean }>,
  listOpts: [] as unknown[],
  joinOnlyOpts: [] as unknown[],
  joinOnlySteps: {} as Record<string, { ok: boolean; step?: string; joined?: boolean }>,
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    H.statements.push(text);
    H.sqlCalls += 1;
    if (/FROM bench_window w\s+JOIN room_day d/i.test(text) && /SELECT d\.ist_date/i.test(text)) {
      if (H.lookup === "throws") return Promise.reject(new Error("neon down"));
      if (H.lookup === "no_row") return Promise.resolve([]);
      if (H.lookup === "null_day") return Promise.resolve([{ ist_date: null, room_id: null }]);
      if (H.lookup === "blind") return Promise.resolve([{ ist_date: BLIND_ROOM_DAYS[0][0], room_id: BLIND_ROOM_DAYS[0][1] }]);
      return Promise.resolve([{ ist_date: "2026-10-01", room_id: "room_clear" }]);
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/r2", () => ({ deleteObject: async () => {}, getObjectBytes: async () => new Uint8Array([1]) }));
vi.mock("@/lib/bench-join", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    joinServiceConfigured: () => true,
    callJoinService: async (req: unknown) => {
      H.joinCalls += 1; H.joinRequests.push(req);
      return { ok: true, key: "clips/sess_1/w1.webm", bytes: 10, duration_ms: 900_000 };
    },
  };
});

const ARGS = {
  windowId: "w1", sessionId: "sess_1",
  covering: [{ chunk: { idx: 1, r2_key: "chunks/1.webm" }, offset_in_chunk_s: 0, duration_s: 900 }],
  startMs: 0, endMs: 900_000, source: "primary" as const,
};
async function seam() {
  const { joinClipForWindow } = await import("@/lib/stt/room-drain");
  return joinClipForWindow(ARGS as Parameters<typeof joinClipForWindow>[0]);
}
const updates = () => H.statements.filter((s) => /UPDATE/i.test(s));

beforeEach(() => {
  H.statements.length = 0; H.sqlCalls = 0; H.lookup = "clear"; H.joinCalls = 0; H.joinRequests.length = 0;
  H.list = []; H.listOpts.length = 0; H.joinOnlyOpts.length = 0; H.joinOnlySteps = {};
  vi.resetModules();
});

describe("the seam's blind guard", () => {
  it("a. refuses a blind window: no service call, no UPDATE", async () => {
    H.lookup = "blind";
    expect(await seam()).toEqual({ ok: false, error: "blind_room_day" });
    expect(H.joinCalls).toBe(0);
    expect(updates()).toEqual([]);
  });

  it.each(["throws", "null_day", "no_row"] as const)("b. fails closed on %s", async (mode) => {
    H.lookup = mode;
    expect(await seam()).toEqual({ ok: false, error: "room_day_lookup_failed" });
    expect(H.joinCalls).toBe(0);
    expect(updates()).toEqual([]);
  });

  it("c. a clear window joins and writes only the clip key", async () => {
    expect(await seam()).toEqual({ ok: true, key: "clips/sess_1/w1.webm" });
    expect(H.joinCalls).toBe(1);
    expect(updates().length).toBe(1);
    expect(updates()[0]).toMatch(/UPDATE bench_window SET clip_r2_key = \? WHERE id = \?/);
  });
});

describe("the route", () => {
  const SECRET = "s3cret-for-test";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T16:30:00Z"));   // 22:00 IST, outside clinic hours
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("NEMOTRON_CLIP_JOIN_ENABLED", "1");
    vi.stubEnv("DIARIZE_NEMOTRON_SHADOW", "1");
    vi.stubEnv("NEMOTRON_CLIP_JOIN_BATCH", "");
    vi.doMock("@/lib/stt/join-only", async (orig) => ({
      inClinicHours: ((await orig()) as { inClinicHours: (d: Date) => boolean }).inClinicHours,
      listCliplessWindows: async (o: unknown) => { H.listOpts.push(o); return H.list; },
      joinOnlyWindow: async (id: string, o: unknown) => {
        H.joinOnlyOpts.push(o);
        const r = H.joinOnlySteps[id] ?? { ok: true, joined: true };
        return r.ok ? { ok: true, window_id: id, joined: r.joined } : { ok: false, window_id: id, step: r.step };
      },
    }));
  });
  afterEach(() => { vi.useRealTimers(); });
  const call = async (auth?: string) => {
    const { GET } = await import("@/app/api/admin/join-windows/route");
    const { NextRequest } = await import("next/server");
    return GET(new NextRequest("http://localhost/api/admin/join-windows", auth ? { headers: { authorization: auth } } : {}));
  };

  it("d. no or wrong bearer is 401", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).status).toBe(401);
    expect(H.listOpts.length).toBe(0);
  });

  it.each([
    ["NEMOTRON_CLIP_JOIN_ENABLED", "0"],
    ["DIARIZE_NEMOTRON_SHADOW", ""],
  ])("d. flag off (%s=%s) skips and touches nothing", async (name, val) => {
    vi.stubEnv(name, val);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "flag_off" });
    expect(H.sqlCalls).toBe(0);
    expect(H.listOpts.length).toBe(0);
  });

  it("d. flags on: batch respected (default 6, clamped), includeTranscriptDisabled passed", async () => {
    H.list = [{ window_id: "a", transcript_enabled: false }, { window_id: "b", transcript_enabled: false }];
    const body = await (await call(`Bearer ${SECRET}`)).json();
    expect(H.listOpts[0]).toEqual({ limit: 6, includeTranscriptDisabled: true });
    expect(H.joinOnlyOpts).toEqual([{ includeTranscriptDisabled: true }, { includeTranscriptDisabled: true }]);
    expect(body.joined).toBe(2);
    vi.stubEnv("NEMOTRON_CLIP_JOIN_BATCH", "99");
    await call(`Bearer ${SECRET}`);
    expect(H.listOpts[1]).toEqual({ limit: 12, includeTranscriptDisabled: true });
    vi.stubEnv("NEMOTRON_CLIP_JOIN_BATCH", "0");
    await call(`Bearer ${SECRET}`);
    expect((H.listOpts[2] as { limit: number }).limit).toBe(6);
    vi.stubEnv("NEMOTRON_CLIP_JOIN_BATCH", "3");
    await call(`Bearer ${SECRET}`);
    expect((H.listOpts[3] as { limit: number }).limit).toBe(3);
  });

  it.each(["room_recording", "recording_unknown", "join_service_not_configured"])(
    "d. stops the tick at %s", async (step) => {
      H.list = ["a", "b", "c"].map((window_id) => ({ window_id, transcript_enabled: false }));
      H.joinOnlySteps = { b: { ok: false, step } };
      const body = await (await call(`Bearer ${SECRET}`)).json();
      expect(H.joinOnlyOpts.length).toBe(2);   // c never attempted
      expect(body.stopped_at).toBe(step);
      expect(body.joined).toBe(1);
    });

  // IST = UTC+05:30: 07:30 IST is 02:00Z, 21:30 IST is 16:00Z.
  it.each([
    ["07:29 IST runs", "2026-10-09T01:59:00Z", false],
    ["07:30 IST skipped", "2026-10-09T02:00:00Z", true],
    ["21:29 IST skipped", "2026-10-09T15:59:00Z", true],
    ["21:30 IST runs", "2026-10-09T16:00:00Z", false],
  ])("clinic hours: %s", async (_n, iso, skipped) => {
    vi.setSystemTime(new Date(iso));
    H.list = [{ window_id: "a", transcript_enabled: false }];
    const body = await (await call(`Bearer ${SECRET}`)).json();
    if (skipped) {
      expect(body).toEqual({ skipped: "clinic_hours" });
      expect(H.sqlCalls).toBe(0);
      expect(H.listOpts.length).toBe(0);
    } else {
      expect(body.skipped).toBeUndefined();
      expect(H.listOpts.length).toBe(1);
    }
  });

  it("a blind refusal for one window does not stop the tick", async () => {
    H.list = ["a", "b"].map((window_id) => ({ window_id, transcript_enabled: false }));
    H.joinOnlySteps = { a: { ok: false, step: "blind_room_day" } };
    const body = await (await call(`Bearer ${SECRET}`)).json();
    expect(H.joinOnlyOpts.length).toBe(2);
    expect(body.steps).toEqual({ blind_room_day: 1, joined: 1 });
  });
});

describe("e. the listing SQL", () => {
  beforeEach(() => { vi.doUnmock("@/lib/stt/join-only"); });
  it("excludes the blind pairs (from the constant) and requires grid_aligned, oldest first", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 5, includeTranscriptDisabled: true });
    const q = H.statements[0];
    expect(q).toMatch(/w\.grid_aligned = TRUE/);
    expect(q).toMatch(/NOT EXISTS[\s\S]*unnest\(\?::text\[\], \?::text\[\]\)[\s\S]*d\.ist_date::text[\s\S]*d\.room_id/);
    expect(q).toMatch(/ORDER BY w\.start_ms ASC/);
    expect(q).not.toMatch(/room_[a-z0-9]{8}/);   // no hand-copied pair in the text
  });
});

describe("f. no text, no vendor", () => {
  const FORBIDDEN = /sarvam|whisper|stt\/adapters|engine|jobs|turn|cue|transcript-guard/i;
  const specifiers = (file: string) =>
    [...readFileSync(file, "utf8").matchAll(/^\s*import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

  it("the route and join-only import no vendor, engine, job or turn module", () => {
    for (const f of ["app/api/admin/join-windows/route.ts", "lib/stt/join-only.ts"]) {
      const bad = specifiers(f).filter((s) => FORBIDDEN.test(s));
      expect(bad, f).toEqual([]);
    }
  });
});
