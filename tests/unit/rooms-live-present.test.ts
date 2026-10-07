/** lib/rooms-live/present.ts — the copy word for word, the grouping, the counts. */
import { describe, it, expect } from "vitest";
import { COLORS, DAY_LEGEND, DEGRADED_NOTE, LOGIN_PATH, STILL_NOT_WORKING, WORD, barFraction, counts, forMinutes, groupOf, headline, segmentColor, segmentWord, SEGMENT_WORD, showNoDoctorNote, stepsFor } from "@/lib/rooms-live/present";
import { ROOMS, ROOM_IDS } from "@/lib/rooms-live/rooms";

describe("copy, exactly", () => {
  it("headlines", () => {
    expect(headline({ state: "listening", detail_code: null })).toBe("The mic is hearing the room");
    expect(headline({ state: "quiet", detail_code: null })).toBe("Recording. Nobody is talking right now");
    expect(headline({ state: "notrec", detail_code: "restarting" })).toBe("Recording is restarting by itself.");
  });
  it("FIX-1 F3: Mic silent (the webcams have no mute button)", () => {
    expect(WORD.muted).toBe("Mic silent");
    expect(headline({ state: "muted", detail_code: null })).toBe("The mic is sending only silence");
    expect(stepsFor("muted")).toEqual(["Check the webcam's USB cable is pushed firmly into the back of the room computer. If it does not clear in 5 minutes, tell IT."]);
  });
  it("Mic unplugged note, then the escalation line; not recording and computer off end with the escalation line, never a phone number", () => {
    expect(STILL_NOT_WORKING).toBe("Still not working? This card turns darker red the longer it stays, so everyone can see it.");
    expect(stepsFor("unplugged")).toEqual([
      "The computer cannot find the webcam mic. Push the webcam's USB cable firmly into the back of the room computer.",
      "Wait 30 seconds. The card clears by itself.",
      STILL_NOT_WORKING,
    ]);
    expect(stepsFor("notrec")).toEqual(["Recording restarts by itself within 5 minutes.", STILL_NOT_WORKING]);
    expect(stepsFor("off")).toEqual(["Check the room computer is switched on.", "Check its power cable and network cable.", STILL_NOT_WORKING]);
  });
  it("FIX-1 F6: unknown state note", () => {
    expect(WORD.unknown).toBe("Can't tell");
    expect(stepsFor("unknown")).toEqual(["No live sound reading from this room. Check the room computer is on."]);
  });
  it("no 'mute button' / 'on mute' wording anywhere a member of staff can read it (copy, tiles, detail, legend, login)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["lib/rooms-live/present.ts", ...readdirSync(join(process.cwd(), "components/rooms-live")).map((x) => `components/rooms-live/${x}`)]) {
      expect(/mute button|on mute|press the mute|unmute/i.test(readFileSync(join(process.cwd(), f), "utf8")), f).toBe(false);
    }
  });
  it("FIX-1 F5: staff-facing words — the degraded banner, the day-strip legend and its plain segment words; no snake_case reaches a tooltip", () => {
    expect(DEGRADED_NOTE).toBe("Some live readings are delayed. This screen may be a few minutes behind.");
    expect(DAY_LEGEND.map((l) => l.word)).toEqual(["Recording", "Quiet", "Mic silent", "Mic unplugged", "Not recording", "Computer off", "Unknown"]);
    for (const code of Object.keys(SEGMENT_WORD)) expect(DAY_LEGEND.map((l) => l.word), code).toContain(segmentWord(code));
    expect(segmentWord("something_new")).toBe("Unknown");   // FIX-2 N4: never guessed as Quiet
    expect(segmentWord("device_missing")).toBe("Mic unplugged");
    expect(segmentWord("device_dead")).toBe("Mic unplugged");
    expect(segmentColor("something_new")).toBe("#8A8E96");
    expect(/_/.test(DAY_LEGEND.map((l) => l.word).join(" "))).toBe(false);
  });
  it("open access (8 Oct 2026): a 401 no longer redirects anywhere; the screen never sends people to /admin", async () => {
    expect(LOGIN_PATH).toBe("/rooms-live");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "components/rooms-live/RoomsLiveClient.tsx"), "utf8");
    expect(src).not.toContain("window.location.assign");
    expect(src).not.toMatch(/["']\/admin["']/);
  });
  it("no support phone anywhere: no 'Call ETA support', no ROOMS_LIVE_SUPPORT_PHONE, no config.ts", async () => {
    const all = (["muted", "unplugged", "notrec", "off", "unknown", "listening", "quiet"] as const).flatMap((s) => stepsFor(s)).join("\n");
    expect(/call eta support|support number|support on/i.test(all)).toBe(false);
    const { readFileSync, existsSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(process.cwd(), "lib/rooms-live/config.ts"))).toBe(false);
    for (const d of ["lib/rooms-live", "components/rooms-live", "app/rooms-live", "app/api/rooms-live"]) {
      const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]));
      for (const f of walk(join(process.cwd(), d))) expect(/ROOMS_LIVE_SUPPORT_PHONE|support_phone|supportPhone/.test(readFileSync(f, "utf8")), f).toBe(false);
    }
  });
  it("listening and quiet have no fix steps; every problem state does", () => {
    expect(stepsFor("listening")).toEqual([]);
    expect(stepsFor("quiet")).toEqual([]);
    for (const s of ["muted", "unplugged", "notrec", "off"] as const) expect(stepsFor(s).length).toBeGreaterThan(0);
  });
  it("status is never colour alone: every state has a word, an icon and two colours; the palette is the spec's", () => {
    expect(COLORS.listening).toEqual({ fg: "#1D6B57", bg: "#E2F0EA" });
    expect(COLORS.quiet).toEqual({ fg: "#4F535A", bg: "#ECEBE6" });
    expect(COLORS.muted).toEqual({ fg: "#A84A06", bg: "#FBE9D6" });
    expect(COLORS.unplugged).toEqual({ fg: "#9E2A1E", bg: "#F9E1DC" });
    expect(COLORS.notrec).toEqual(COLORS.unplugged);
    expect(COLORS.off).toEqual({ fg: "#2F343B", bg: "#E4E5E7" });
    expect(Object.values(WORD).every((w) => w.length > 2)).toBe(true);
  });
});

describe("grouping and counts", () => {
  const doc = { display: "Clinician A", activity: "Signed in" as const };
  it("doctor + problem = needs attention; doctor + listening/quiet = fine; no doctor (known) = calm group whatever the state", () => {
    for (const s of ["muted", "unplugged", "notrec", "off"] as const) expect(groupOf({ doctor: doc, state: s })).toBe("attention");
    for (const s of ["listening", "quiet"] as const) expect(groupOf({ doctor: doc, state: s })).toBe("fine");
    for (const s of ["muted", "listening", "off", "unknown"] as const) expect(groupOf({ doctor: null, state: s, doctor_known: true })).toBe("nodoctor");
  });
  it("FIX-1 F6: a room whose tile shows a doctor is never counted under No doctor — unknown state + doctor -> Needs attention", () => {
    expect(groupOf({ doctor: doc, state: "unknown" })).toBe("attention");
  });
  it("FIX-1 F1: an UNKNOWN doctor is not 'no doctor': a problem stays in Needs attention, listening/quiet stays Fine, an unreadable calm room stays quiet", () => {
    for (const s of ["muted", "unplugged", "notrec", "off"] as const) expect(groupOf({ doctor: null, state: s, doctor_known: false })).toBe("attention");
    expect(groupOf({ doctor: null, state: "listening", doctor_known: false })).toBe("fine");
    expect(groupOf({ doctor: null, state: "unknown", doctor_known: false })).toBe("nodoctor");
  });
  it("counts: need you / fine / no doctor", () => {
    expect(counts([{ doctor: doc, state: "muted" }, { doctor: doc, state: "listening" }, { doctor: null, state: "off", doctor_known: true }, { doctor: doc, state: "quiet" }, { doctor: doc, state: "unknown" }])).toEqual({ need: 2, fine: 2, nodoctor: 1 });
  });
});

describe("FIX-2", () => {
  it("N1: 'Check before the next doctor arrives' only when the doctor is KNOWN to be absent", () => {
    expect(showNoDoctorNote({ state: "muted", doctor: null, doctor_known: true })).toBe(true);
    expect(showNoDoctorNote({ state: "muted", doctor: null })).toBe(true);                  // doctor_known absent = known (older rows)
    expect(showNoDoctorNote({ state: "muted", doctor: null, doctor_known: false })).toBe(false);
    expect(showNoDoctorNote({ state: "muted", doctor: { display: "C", activity: "Signed in" }, doctor_known: true })).toBe(false);
    expect(showNoDoctorNote({ state: "listening", doctor: null, doctor_known: true })).toBe(false);
  });
  it("N2: no note says 'stays red'; Mic silent says 'does not clear in 5 minutes'", () => {
    const all = (["muted", "unplugged", "notrec", "off", "unknown"] as const).flatMap((s) => stepsFor(s)).join("\n");
    expect(/stays red/i.test(all)).toBe(false);
    expect(stepsFor("muted")[0]).toContain("If it does not clear in 5 minutes, tell IT.");
  });
  it("N4: every known segment code maps to a legend word; an unknown code is 'Unknown'", () => {
    const words = DAY_LEGEND.map((l) => l.word);
    for (const code of Object.keys(SEGMENT_WORD)) expect(words, code).toContain(segmentWord(code));
    for (const code of ["", "nonsense", "AUDIO_PRESENT"]) expect(segmentWord(code)).toBe("Unknown");
  });
});

describe("small helpers", () => {
  it("forMinutes", () => {
    const now = Date.parse("2026-10-07T10:00:00Z");
    expect(forMinutes(null, now)).toBeNull();
    expect(forMinutes("2026-10-07T09:59:40Z", now)).toBe("For under a minute");
    expect(forMinutes("2026-10-07T09:55:00Z", now)).toBe("For 5 min");
    expect(forMinutes("2026-10-07T07:30:00Z", now)).toBe("For 2 h 30 min");
    expect(forMinutes("2026-10-07T10:05:00Z", now)).toBeNull();
  });
  it("barFraction: log scale, 0 at 0.001, 1 at 0.1", () => {
    expect(barFraction(null)).toBe(0);
    expect(barFraction(0)).toBe(0);
    expect(barFraction(0.001)).toBeCloseTo(0, 5);
    expect(barFraction(0.1)).toBeCloseTo(1, 5);
    expect(barFraction(0.01)).toBeCloseTo(0.5, 5);
    expect(barFraction(5)).toBe(1);
  });
  it("the allow-list is the eight rooms, in order, with the spec's labels", () => {
    expect(ROOMS.map((r) => r.label)).toEqual(["OPD 1", "OPD 3", "OPD 4 Ortho", "OPD 5", "OPD 6", "OPD 7", "Dietary", "Cardiology"]);
    expect(new Set(ROOM_IDS).size).toBe(8);
    for (const out of ["room_d74hhmc4", "room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy"]) expect(ROOM_IDS, out).not.toContain(out); // Audiometry (testbed), ORB2, ORB3, Home Office
    expect(ROOM_IDS).not.toContain("room_jwyrr4dc");
    expect(ROOM_IDS).not.toContain("room_2qe955hy");
  });
});
