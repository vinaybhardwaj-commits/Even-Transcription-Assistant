/**
 * ENDED DISAGREES — the session row says over, the tape says otherwise.
 *
 * THE CASE. bs_g3dwud4p, Home Office, 22–23 August. The day-rollover reaper stamped `ended_at`
 * at 19:00:36. THE KIOSK WAS NEVER TOLD. That tab never reloaded — it held the session id in its
 * own memory — so it carried on writing chunks into the ended session until 00:58:46, six hours
 * later. All 108 of them are present and verified.
 *
 * NO AUDIO WAS LOST. What was lost was the truth: a three-hour session row holding nine hours of
 * audio, and an operator monitor reading NOT RECORDING while the room was still capturing.
 *
 * K4a fixed the specific cause (the reaper no longer reaps a session that is still receiving
 * chunks). This build fixes the general one, and these are the four things it must never get
 * wrong:
 *
 *   1. THE CHUNK IS ACCEPTED. Always, whatever the row says. Those 108 chunks are the argument:
 *      refusing would have turned a bookkeeping fault into six hours of lost recording, which is
 *      a far worse failure than the one being fixed. There is no code path here that refuses.
 *   2. IT IS RECORDED ONCE. A kiosk nobody told uploads every five minutes for hours; 108
 *      identical rows is a log, not a timeline. First detection is arbitrated by Postgres.
 *   3. THE KIOSK IS TOLD, in the chunk response — the only channel that reaches a tab which is
 *      not reloading. A reload was already safe (decideResume rejects an ended session).
 *   4. THE REQUEST PATH IS UNCHANGED. Detection is a field on a row the route already read, and
 *      the event write is in the same after() hook as the window evaluation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// ---- mocks ------------------------------------------------------------------------------------

type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
/** Which calls happened BEFORE the response was returned. after() pushes into `afterCalls`. */
let phase: "request" | "after" = "request";
const afterCalls: Call[] = [];
let insertThrows = false;
/** The one-row-per-session rule, modelled: a second insert conflicts and writes nothing. */
const eventRows: Array<{ session_id: string; kind: string }> = [];

const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  (phase === "after" ? afterCalls : calls).push({ text: text.replace(/\s+/g, " ").trim(), values });
  if (/INSERT INTO bench_event/.test(text)) {
    if (insertThrows) return Promise.reject(new Error("bench_event write failed"));
    const sessionId = values[1] as string;
    const kind = values[2] as string;
    // 0064's partial unique index, in one line.
    const exists = eventRows.some((r) => r.session_id === sessionId && r.kind === "ended_disagrees");
    if (!(kind === "ended_disagrees" && exists)) eventRows.push({ session_id: sessionId, kind });
    return Promise.resolve([]);
  }
  return Promise.resolve([]);
};

let sessionStatus = "recording";
let sessionEndedAt: string | null = null;

vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => (sqlTag as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_test" }) }));
vi.mock("@/lib/r2", () => ({
  headObject: async () => ({ size: 4242 }),
  benchChunkKey: () => "bench/room/2026-08-23/bs_t/0.webm",
}));
vi.mock("@/lib/bench-window", () => ({ evaluateAndWriteWindows: async () => {} }));
vi.mock("@/lib/bench", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    findBenchSession: async () => ({
      id: "bs_t", room_id: "room_test", room_slug: "opd-test", started_at: "2026-08-23T04:00:00.000Z",
      status: sessionStatus, ended_at: sessionEndedAt,
    }),
  };
});
// after() runs INLINE here so the hook's writes are observable — and tagged, so a test can prove
// they were not in the request path.
vi.mock("next/server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    after: (fn: () => unknown) => { phase = "after"; void Promise.resolve(fn()); },
  };
});

const { POST } = await import("@/app/api/bench/chunks/route");
const {
  ENDED_DISAGREES, CHUNK_DISAGREEMENT_FIELD, ENDED_DISAGREES_KIOSK_TITLE, ENDED_DISAGREES_TITLE,
  ENDED_DISAGREES_HINT, ENDED_DISAGREES_SKEW_GRACE_MS, chunkDisagreesWithEnd,
} = await import("@/lib/bench-bus-constants");

const chunkBody = (over: Record<string, unknown> = {}) => ({
  session_id: "bs_t", idx: 7,
  started_at: "2026-08-23T05:00:00.000Z", ended_at: "2026-08-23T05:05:00.000Z",
  duration_ms: 300_000, size_bytes: 4242, gap_before_ms: 0, ...over,
});

const post = async (body: Record<string, unknown> = chunkBody()) => {
  const req = { json: async () => body } as unknown as Parameters<typeof POST>[0];
  const res = await POST(req);
  const json = (await res.json()) as Record<string, unknown>;
  // let the after() microtask settle
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, json };
};

beforeEach(() => {
  calls.length = 0; afterCalls.length = 0; eventRows.length = 0;
  phase = "request"; insertThrows = false;
  sessionStatus = "recording"; sessionEndedAt = null;
});

// ------------------------------------------------------------------------------------------------

describe("THE DISCRIMINATOR — ended alone is not the fault", () => {
  // Learned from a live run on OPD Test, not from reasoning. The kiosk marks the session ended as
  // soon as the recorder stops and only then finishes uploading its flush, so a chunk arriving
  // for an ended session is what EVERY normal end of day looks like:
  //
  //     session bs_jmh9jxmx   ended_at   05:24:09.817
  //     chunk   bc_744vkbng   started_at 05:23:51.705   ended_at 05:24:09.571
  //
  // The first version of this build flagged that, which would have fired in every room every
  // evening. What separates the two is the CAPTURE clock.
  it("a flush chunk — captured before the end, uploaded after it — is NOT a disagreement", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-23T05:24:09.817Z";
    const { json } = await post(chunkBody({ started_at: "2026-08-23T05:23:51.705Z", ended_at: "2026-08-23T05:24:09.571Z" }));
    expect(json.ok).toBe(true);
    expect(json[CHUNK_DISAGREEMENT_FIELD]).toBeUndefined();
    expect(afterCalls.filter((c) => /INSERT INTO bench_event/.test(c.text))).toHaveLength(0);
  });

  it("a chunk that BEGAN after the end is", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-23T05:24:09.817Z";
    const { json } = await post(chunkBody({ started_at: "2026-08-23T05:30:00.000Z", ended_at: "2026-08-23T05:35:00.000Z" }));
    expect(json[CHUNK_DISAGREEMENT_FIELD]).toBe(ENDED_DISAGREES);
  });

  it("the grace covers browser-vs-server clock skew and nothing wider", () => {
    expect(ENDED_DISAGREES_SKEW_GRACE_MS).toBe(60_000);
    const endedAt = "2026-08-23T05:24:09.817Z";
    const at = (offsetMs: number) =>
      chunkDisagreesWithEnd({ status: "ended", sessionEndedAt: endedAt, chunkStartedAtMs: Date.parse(endedAt) + offsetMs });
    expect(at(30_000)).toBe(false);       // a fast browser clock is not a fault
    expect(at(60_000)).toBe(false);       // boundary is exclusive
    expect(at(61_000)).toBe(true);
    // and a genuinely rogue chunk is a WHOLE ROTATION late at minimum, so the grace costs nothing
    expect(at(5 * 60_000)).toBe(true);
  });

  it("a live session and a session with no ended_at are never disagreements", () => {
    expect(chunkDisagreesWithEnd({ status: "recording", sessionEndedAt: null, chunkStartedAtMs: Date.now() })).toBe(false);
    expect(chunkDisagreesWithEnd({ status: "ended", sessionEndedAt: null, chunkStartedAtMs: Date.now() })).toBe(false);
    expect(chunkDisagreesWithEnd({ status: "ended", sessionEndedAt: "not a date", chunkStartedAtMs: Date.now() })).toBe(false);
  });
});

describe("A1 — the chunk is accepted, always", () => {
  it("stores and verifies a chunk for a session that is already ended", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.upload_state).toBe("verified");
    // the row went in exactly as it does on a live session
    const insert = calls.find((c) => /INSERT INTO bench_chunk/.test(c.text));
    expect(insert).toBeTruthy();
    expect(insert!.text).toMatch(/'verified'/);
  });

  it("no code path in the route refuses a chunk for a session's status", () => {
    const src = readFileSync("app/api/bench/chunks/route.ts", "utf8");
    // Every respondError in this file, with the reason it exists. A status check is not among
    // them and must never be: 108 accepted chunks are the reason this rule is absolute.
    const refusals = [...src.matchAll(/respondError\(\s*"([A-Z_]+)"\s*,\s*[`"]?([a-z0-9_$&{}. ]+)/g)].map((m) => m[2]);
    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) expect(r).not.toMatch(/ended|status|closed/);
    // and the status read is explicitly not a guard
    expect(src).toMatch(/const endedDisagrees = chunkDisagreesWithEnd\(\{/);
  });
});

describe("A2 — recorded as an event, once per session", () => {
  it("writes one bench_event on first detection", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    await post();
    const ev = afterCalls.filter((c) => /INSERT INTO bench_event/.test(c.text));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.values).toContain(ENDED_DISAGREES);
    // no brain hop is ever attempted for this row, so 'none' — 'failed' is every other writer's
    // "attempted, not yet succeeded" and would read as a lie.
    expect(ev[0]!.text).toMatch(/'none'/);
    expect(ev[0]!.text).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it("a second, third and hundredth chunk add no further rows", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    for (let i = 0; i < 5; i++) await post(chunkBody({ idx: i }));
    expect(eventRows.filter((r) => r.kind === ENDED_DISAGREES)).toHaveLength(1);
  });

  it("a failed event write costs nothing else — the chunk is already stored and answered", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    insertThrows = true;
    const { status, json } = await post();
    expect(status).toBe(200);
    expect(json[CHUNK_DISAGREEMENT_FIELD]).toBe(ENDED_DISAGREES);
  });
});

describe("A3 — the kiosk is told, in the response", () => {
  it("carries the signal beside the normal success", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    const { json } = await post();
    expect(json[CHUNK_DISAGREEMENT_FIELD]).toBe(ENDED_DISAGREES);
    expect(json.ok).toBe(true); // the UPLOAD succeeded; the SESSION is what is wrong
  });

  it("a normal session's response is byte-for-byte what it was", async () => {
    const { json } = await post();
    expect(json).toEqual({ ok: true, key: "bench/room/2026-08-23/bs_t/0.webm", upload_state: "verified" });
    expect(Object.keys(json)).not.toContain(CHUNK_DISAGREEMENT_FIELD);
  });

  it("a normal session writes no event at all", async () => {
    await post();
    expect(afterCalls.filter((c) => /INSERT INTO bench_event/.test(c.text))).toHaveLength(0);
  });
});

describe("A6 — nothing was added to the request path", () => {
  it("the same queries run before the response whether or not the session disagrees", async () => {
    await post();
    const normal = calls.map((c) => c.text);
    calls.length = 0; afterCalls.length = 0; phase = "request";
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    await post();
    expect(calls.map((c) => c.text)).toEqual(normal);
  });

  it("the event write is in the after() hook, never in front of the response", async () => {
    sessionStatus = "ended";
    sessionEndedAt = "2026-08-22T13:30:36.000Z"; // the reaper's stamp; the chunk below begins hours later
    await post();
    expect(calls.some((c) => /bench_event/.test(c.text))).toBe(false);
    expect(afterCalls.some((c) => /bench_event/.test(c.text))).toBe(true);
  });
});

describe("B — the kiosk stops, says so, and starts nothing", () => {
  const hook = readFileSync("lib/use-room-recorder.ts", "utf8");
  const client = readFileSync("components/room/RoomRecorderClient.tsx", "utf8");

  it("the signal is read only after the upload is known to have succeeded", () => {
    const fn = /const uploadOne = React\.useCallback[\s\S]*?\}, \[\]\);/.exec(hook)?.[0] ?? "";
    expect(fn).toBeTruthy();
    const okCheck = fn.indexOf("chunk_row_failed_");
    const signalRead = fn.indexOf("CHUNK_DISAGREEMENT_FIELD");
    expect(okCheck).toBeGreaterThan(-1);
    expect(signalRead).toBeGreaterThan(okCheck); // a malformed body never turns a stored chunk into a retry
  });

  it("it fires once, not once per remaining chunk", () => {
    expect(hook).toMatch(/endedByServerRef\.current\s*=\s*true;/);
    expect(hook).toMatch(/!endedByServerRef\.current/);
  });

  it("the kiosk flushes through the SAME path the End-day button uses", () => {
    const handler = /endedByServerRef\.current = \(\) => \{[\s\S]*?\};/.exec(client)?.[0] ?? "";
    expect(handler).toBeTruthy();
    expect(handler).toMatch(/onEndDay\(\)/);
    // B3 — and starts nothing. The kiosk's own start path has no guard against a second open
    // session, so self-healing here is how a room ends up with several and nobody notices.
    expect(handler).not.toMatch(/startDay|resumeSession|resumeDay|reload/);
  });

  it("it never PATCHes end — that would overwrite the ended_at that is the evidence", () => {
    expect(client).toMatch(/if \(!closedByServer\) await patchSession\("end"\)/);
  });

  it("the room screen says what happened and what to do, from the one copy source", () => {
    expect(client).toMatch(/ENDED_DISAGREES_KIOSK_TITLE/);
    expect(client).toMatch(/ENDED_DISAGREES_KIOSK_BODY/);
    expect(ENDED_DISAGREES_KIOSK_TITLE).toMatch(/closed by the system/i);
    expect(client).toMatch(/data-testid="closed-by-server"/);
    // and the button offers a new recording rather than taking one
    expect(client).toMatch(/Start a new recording/);
  });
});

describe("C1 — named, in the same shape and vocabulary as paused_disagrees", () => {
  it("lives in the PURE module, which stays import-free", () => {
    const src = readFileSync("lib/bench-bus-constants.ts", "utf8");
    expect(src).not.toMatch(/^import /m); // safe for the kiosk AND the admin browser bundle
    expect(src).toMatch(/export const ENDED_DISAGREES = "ended_disagrees";/);
  });

  it("is NOT folded into the six room states", () => {
    const src = readFileSync("lib/bench-bus-constants.ts", "utf8");
    const stateUnion = /export type RoomState = [^;]+;/.exec(src)?.[0] ?? "";
    expect(stateUnion).toBeTruthy();
    expect(stateUnion).not.toMatch(/ended_disagrees/);
    // roomState() is a first-match-wins chain; this is orthogonal to all six.
    const fn = /export function roomState\([\s\S]*$/.exec(src)?.[0] ?? "";
    expect(fn).not.toMatch(/ended_disagrees|ENDED_DISAGREES/);
  });

  it("the operator copy says the audio is safe before it says anything else", () => {
    expect(`${ENDED_DISAGREES_TITLE} ${ENDED_DISAGREES_HINT}`).toMatch(/safe|saved/i);
    expect(ENDED_DISAGREES_HINT).toMatch(/press start/i);
  });
});

describe("0064 — one event per session is enforced by the database", () => {
  const mig = readFileSync("db/migrations/0064_ended_disagrees.sql", "utf8");
  it("is a PARTIAL unique index, so every other open-set kind stays many-per-session", () => {
    expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS bench_event_ended_disagrees_once_idx/);
    expect(mig).toMatch(/ON bench_event \(session_id\)/);
    expect(mig).toMatch(/WHERE kind = 'ended_disagrees'/);
  });
  it("creates nothing else and drops nothing", () => {
    const ddl = mig.replace(/--[^\n]*/g, "").split(";").map((x) => x.trim())
      .filter((x) => /^(CREATE|ALTER|DROP|DELETE|UPDATE|TRUNCATE)\b/i.test(x));
    expect(ddl).toHaveLength(1);
    expect(mig).not.toMatch(/\bDROP\b/i);
  });
});
