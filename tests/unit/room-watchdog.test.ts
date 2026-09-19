/**
 * lib/room-watchdog.ts — behaviour tests, not coverage tests (ORB3, 19 Sep 2026).
 *
 * Everything here drives `planWatchdogRun` and the two senders directly with plain objects and a
 * stubbed `fetch` — no database, no real Resend or WaSender call, per the kickoff. The DB-touching
 * orchestrator (`runWatchdog`, `setRoomMute`) is not exercised here: there is no live database in
 * this sandbox, and every SQL string it runs is INFERRED and listed in the build report instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  planWatchdogRun,
  computeRoomStatus,
  offlineMessage,
  degradedMessage,
  recoveryMessage,
  fleetOutageMessage,
  dispatch,
  sendEmailAlert,
  sendWhatsAppAlert,
  OFFLINE_AFTER_MS,
  type RoomRunInput,
  type RoomPollFacts,
} from "@/lib/room-watchdog";

const NOW = new Date("2026-09-19T10:00:00.000Z").getTime();
const nowIso = new Date(NOW).toISOString();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const okFacts = (over: Partial<RoomPollFacts> = {}): RoomPollFacts => ({
  last_seen_at: minutesAgo(0.1),
  tape_advancing: true,
  session_open: true,
  disk_free_bytes: 50_000_000_000,
  state_flags: [],
  open_session: null,
  ...over,
});

const offlineFacts = (): RoomPollFacts => okFacts({ last_seen_at: minutesAgo(10) });
const degradedFacts = (): RoomPollFacts => okFacts({ state_flags: ["DEVICE_MISSING"] });
// ETA-DELIVERY-EVIDENCE: a 'recording' session whose newest chunk is stale (isBenchStalled's own
// STALLED_BADGE_MINUTES is 10) — the notDelivering signal, independent of anything the poll says.
const notDeliveringFacts = (): RoomPollFacts =>
  okFacts({ open_session: { status: "recording", started_at: minutesAgo(30), last_any_chunk_at: minutesAgo(15) } });

// ---------------------------------------------------------------------------
// computeRoomStatus — the primitive everything else is built on
// ---------------------------------------------------------------------------

describe("computeRoomStatus (D4, D7, and notDelivering per V's 19 Sep ruling)", () => {
  it("reads offline past OFFLINE_AFTER_MS, and ok just under it", () => {
    expect(computeRoomStatus(okFacts({ last_seen_at: minutesAgo(6) }), NOW).status).toBe("offline");
    expect(OFFLINE_AFTER_MS).toBe(5 * 60_000);
    expect(computeRoomStatus(okFacts({ last_seen_at: new Date(NOW - OFFLINE_AFTER_MS + 1000).toISOString() }), NOW).status).toBe("ok");
  });

  it("reads offline on a never-seen room (null last_seen_at)", () => {
    expect(computeRoomStatus(okFacts({ last_seen_at: null }), NOW).status).toBe("offline");
  });

  it("reads degraded on a Tier 1 §2 degradation flag, tape stalled while open, or critical disk", () => {
    expect(computeRoomStatus(degradedFacts(), NOW)).toEqual({ status: "degraded", reasons: ["device_missing"] });
    expect(computeRoomStatus(okFacts({ tape_advancing: false, session_open: true }), NOW)).toEqual({
      status: "degraded",
      reasons: ["tape_stalled"],
    });
    expect(computeRoomStatus(okFacts({ disk_free_bytes: 1_000_000_000 }), NOW)).toEqual({
      status: "degraded",
      reasons: ["disk_critical"],
    });
  });

  it("does not read degraded on an information-only flag or tape stalled with no open session", () => {
    expect(computeRoomStatus(okFacts({ state_flags: ["DISK_LOW"] }), NOW).status).toBe("ok");
    expect(computeRoomStatus(okFacts({ tape_advancing: false, session_open: false }), NOW).status).toBe("ok");
  });

  it("reads degraded on notDelivering alone — a Mac polling a clean state_flags: [] but not uploading", () => {
    expect(computeRoomStatus(notDeliveringFacts(), NOW)).toEqual({ status: "degraded", reasons: ["not_delivering"] });
  });

  it("does not read not_delivering on a session that is merely paused, or one whose newest chunk is recent", () => {
    expect(computeRoomStatus(okFacts({ open_session: { status: "paused", started_at: minutesAgo(30), last_any_chunk_at: minutesAgo(20) } }), NOW).status).toBe("ok");
    expect(computeRoomStatus(okFacts({ open_session: { status: "recording", started_at: minutesAgo(30), last_any_chunk_at: minutesAgo(2) } }), NOW).status).toBe("ok");
  });

  it("carries BOTH reasons when the classifier and notDelivering fire together — the OR keeps both facts alive", () => {
    const both = computeRoomStatus({ ...degradedFacts(), open_session: notDeliveringFacts().open_session }, NOW);
    expect(both.status).toBe("degraded");
    expect(both.reasons).toEqual(["device_missing", "not_delivering"]);
  });

  it("offline outranks degraded and drops all reasons — a Mac that isn't polling cannot be judged", () => {
    const stale = { ...degradedFacts(), open_session: notDeliveringFacts().open_session, last_seen_at: minutesAgo(10) };
    expect(computeRoomStatus(stale, NOW)).toEqual({ status: "offline", reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// planWatchdogRun — D1, D2, D3, D5, D9
// ---------------------------------------------------------------------------

describe("planWatchdogRun", () => {
  it("a room going offline alerts once, and a second run while still offline alerts zero times", () => {
    const first: RoomRunInput = {
      room_id: "room_1",
      room_name: "OPD 3",
      facts: offlineFacts(),
      prior: { status: "ok", since: minutesAgo(60) },
      muted: false,
    };
    const plan1 = planWatchdogRun([first], NOW);
    expect(plan1.messages).toHaveLength(1);
    expect(plan1.messages[0]!.subject).toBe("EvenScribe watchdog: OPD 3 is offline");
    expect(plan1.writes).toEqual([{ room_id: "room_1", status: "offline", since: nowIso }]);

    const second: RoomRunInput = { ...first, prior: { status: "offline", since: nowIso } };
    const plan2 = planWatchdogRun([second], NOW + 60_000);
    expect(plan2.messages).toHaveLength(0);
    expect(plan2.writes).toHaveLength(0);
  });

  it("the seeding run sends nothing at all, with several rooms already in a bad state", () => {
    const inputs: RoomRunInput[] = [
      { room_id: "r1", room_name: "OPD 1", facts: offlineFacts(), prior: null, muted: false },
      { room_id: "r2", room_name: "OPD 4", facts: degradedFacts(), prior: null, muted: false },
      { room_id: "r3", room_name: "Room 4.1", facts: degradedFacts(), prior: null, muted: false },
      { room_id: "r4", room_name: "OPD 2", facts: okFacts(), prior: null, muted: false },
    ];
    const plan = planWatchdogRun(inputs, NOW);
    expect(plan.messages).toHaveLength(0);
    expect(plan.writes).toEqual([
      { room_id: "r1", status: "offline", since: nowIso },
      { room_id: "r2", status: "degraded", since: nowIso },
      { room_id: "r3", status: "degraded", since: nowIso },
      { room_id: "r4", status: "ok", since: nowIso },
    ]);
  });

  it("recovery sends, and names the duration", () => {
    const input: RoomRunInput = {
      room_id: "r1",
      room_name: "OPD 3",
      facts: okFacts(),
      prior: { status: "offline", since: minutesAgo(47) },
      muted: false,
    };
    const plan = planWatchdogRun([input], NOW);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.subject).toBe("EvenScribe watchdog: OPD 3 is back");
    expect(plan.messages[0]!.text).toMatch(/recovered after being offline for 47 min/);
    expect(plan.writes).toEqual([{ room_id: "r1", status: "ok", since: nowIso }]);
  });

  it("more than half the fleet offline in one run sends exactly one message, not N", () => {
    const bad: RoomRunInput = {
      room_id: "",
      room_name: "",
      facts: offlineFacts(),
      prior: { status: "ok", since: minutesAgo(60) },
      muted: false,
    };
    const inputs: RoomRunInput[] = [
      { ...bad, room_id: "r1", room_name: "OPD 1" },
      { ...bad, room_id: "r2", room_name: "OPD 2" },
      { ...bad, room_id: "r3", room_name: "OPD 3" },
      { room_id: "r4", room_name: "OPD 4", facts: okFacts(), prior: { status: "ok", since: minutesAgo(60) }, muted: false },
    ];
    const plan = planWatchdogRun(inputs, NOW);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.subject).toBe("EvenScribe watchdog: 3 rooms went offline at once");
    expect(plan.messages[0]!.text).toMatch(/3 of 4 enabled rooms/);
    // Every real transition is still written, bundled message or not.
    expect(plan.writes).toHaveLength(3);
  });

  it("exactly half the fleet offline does NOT bundle — that is not 'more than half'", () => {
    const bad: RoomRunInput = {
      room_id: "",
      room_name: "",
      facts: offlineFacts(),
      prior: { status: "ok", since: minutesAgo(60) },
      muted: false,
    };
    const inputs: RoomRunInput[] = [
      { ...bad, room_id: "r1", room_name: "OPD 1" },
      { ...bad, room_id: "r2", room_name: "OPD 2" },
      { room_id: "r3", room_name: "OPD 3", facts: okFacts(), prior: { status: "ok", since: minutesAgo(60) }, muted: false },
      { room_id: "r4", room_name: "OPD 4", facts: okFacts(), prior: { status: "ok", since: minutesAgo(60) }, muted: false },
    ];
    const plan = planWatchdogRun(inputs, NOW);
    expect(plan.messages).toHaveLength(2);
    expect(plan.messages.map((m) => m.subject)).toEqual([
      "EvenScribe watchdog: OPD 1 is offline",
      "EvenScribe watchdog: OPD 2 is offline",
    ]);
  });

  it("a muted room sends nothing and still records its state", () => {
    const input: RoomRunInput = {
      room_id: "r1",
      room_name: "OPD 6",
      facts: offlineFacts(),
      prior: { status: "ok", since: minutesAgo(60) },
      muted: true,
    };
    const plan = planWatchdogRun([input], NOW);
    expect(plan.messages).toHaveLength(0);
    expect(plan.writes).toEqual([{ room_id: "r1", status: "offline", since: nowIso }]);
  });

  // V's ruling, 19 Sep 2026: prove the fleet-wide guard holds under the OR of both degradation
  // signals too, not just against the one (offline) signal it was originally found against. A
  // single muted room carrying BOTH the classifier's reason and notDelivering at once is still
  // just one room, and must not be able to fire ANY message — individual (muted) or fleet-wide
  // (there is no fleet-wide mechanism for `degraded` at all, by design: D3 names offline only).
  it("a lone muted room degraded through BOTH signals at once sends nothing, on either path", () => {
    const input: RoomRunInput = {
      room_id: "r1",
      room_name: "OPD 6",
      facts: { ...degradedFacts(), open_session: notDeliveringFacts().open_session },
      prior: { status: "ok", since: minutesAgo(60) },
      muted: true,
    };
    const plan = planWatchdogRun([input], NOW);
    expect(plan.messages).toHaveLength(0);
    expect(plan.writes).toEqual([{ room_id: "r1", status: "degraded", since: nowIso }]);
  });

  it("a muted room does not inflate the fleet-wide bundle's individual messages, but still counts toward it", () => {
    const bad: RoomRunInput = {
      room_id: "",
      room_name: "",
      facts: offlineFacts(),
      prior: { status: "ok", since: minutesAgo(60) },
      muted: false,
    };
    const inputs: RoomRunInput[] = [
      { ...bad, room_id: "r1", room_name: "OPD 1" },
      { ...bad, room_id: "r2", room_name: "OPD 2", muted: true },
      { ...bad, room_id: "r3", room_name: "OPD 3" },
      { room_id: "r4", room_name: "OPD 4", facts: okFacts(), prior: { status: "ok", since: minutesAgo(60) }, muted: false },
    ];
    const plan = planWatchdogRun(inputs, NOW);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.text).toMatch(/3 of 4 enabled rooms/);
  });
});

// ---------------------------------------------------------------------------
// The message shapes themselves
// ---------------------------------------------------------------------------

describe("message shapes", () => {
  it("offline and fleet-wide render the room name / counts", () => {
    expect(offlineMessage("OPD 3", nowIso).text).toContain("OPD 3 has not polled in over 5 minutes");
    expect(fleetOutageMessage(5, 8, nowIso).text).toContain("5 of 8 enabled rooms went offline");
  });

  it("recovery names whichever prior status it left, offline or degraded", () => {
    expect(recoveryMessage("OPD 3", "offline", 5 * 60_000, nowIso).text).toMatch(/being offline for 5 min/);
    expect(recoveryMessage("OPD 3", "degraded", 90 * 60_000, nowIso).text).toMatch(/being degraded for 1 h 30 min/);
  });

  // V's ruling, 19 Sep 2026: "the message has to say WHICH signal tripped — notDelivering, the
  // classifier, or both. A watchdog that says 'degraded' without saying why sends someone to look
  // at the wrong thing."
  it("degraded names the classifier's own reason when only the classifier fired", () => {
    const msg = degradedMessage("OPD 3", ["device_missing"], nowIso);
    expect(msg.text).toContain("a missing input device");
    expect(msg.text).not.toContain("reaching storage");
  });

  it("degraded names not_delivering, distinctly, when only that fired", () => {
    const msg = degradedMessage("OPD 3", ["not_delivering"], nowIso);
    expect(msg.text).toContain("no audio reaching storage, independent of what the Mac itself reports");
  });

  it("degraded names BOTH when both fired, so neither signal is masked by the other", () => {
    const msg = degradedMessage("OPD 3", ["device_missing", "not_delivering"], nowIso);
    expect(msg.text).toContain("a missing input device");
    expect(msg.text).toContain("no audio reaching storage");
    expect(msg.text).toMatch(/a missing input device and no audio reaching storage/);
  });
});

// ---------------------------------------------------------------------------
// D8 — two channels, independent, and fail-safe on a missing secret
// ---------------------------------------------------------------------------

describe("dispatch — two channels, independent (D8)", () => {
  const ENV_KEYS = [
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "WATCHDOG_ALERT_EMAIL_TO",
    "WASENDER_API_KEY",
    "WASENDER_BASE_URL",
    "WASENDER_ALERT_TO",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.RESEND_API_KEY = "key_test";
    process.env.RESEND_FROM_EMAIL = "alerts@example.com";
    process.env.WATCHDOG_ALERT_EMAIL_TO = "v@example.com";
    process.env.WASENDER_API_KEY = "wa_key";
    process.env.WASENDER_BASE_URL = "https://wasender.example.com";
    process.env.WASENDER_ALERT_TO = "+911234567890";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a sender throwing does not fail the run and does not stop the other sender", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("resend.com")) throw new Error("econnreset");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const results = await dispatch(offlineMessage("OPD 3", nowIso));
    expect(results).toHaveLength(2);
    const email = results.find((r) => r.channel === "email")!;
    const whatsapp = results.find((r) => r.channel === "whatsapp")!;
    expect(email.ok).toBe(false);
    expect(email.detail).toBe("threw");
    expect(whatsapp.ok).toBe(true);
  });

  it("a missing secret logs by name and does not crash, and never calls fetch", async () => {
    delete process.env.WATCHDOG_ALERT_EMAIL_TO;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendEmailAlert(offlineMessage("OPD 3", nowIso));

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not_configured:WATCHDOG_ALERT_EMAIL_TO");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("WATCHDOG_ALERT_EMAIL_TO"));
  });

  it("a missing WhatsApp secret logs by name and does not crash, and never calls fetch", async () => {
    delete process.env.WASENDER_BASE_URL;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendWhatsAppAlert(offlineMessage("OPD 3", nowIso));

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not_configured:WASENDER_BASE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("WASENDER_BASE_URL"));
  });
});
