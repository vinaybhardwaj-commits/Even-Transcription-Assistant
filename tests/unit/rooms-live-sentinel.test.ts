/** Sentinel S6: the room-sentinel line on the Rooms Live tile — the copy follows the room's device class (the S1 split), TONOR vs webcam. */
import { describe, it, expect } from "vitest";
import React, { createElement } from "react";
(globalThis as { React?: unknown }).React = React; // the .tsx compiles to React.createElement under vitest
import { renderToStaticMarkup } from "react-dom/server";
import { RoomTile } from "@/components/rooms-live/RoomTile";
import type { RoomRow } from "@/lib/rooms-live/snapshot";
import { sentinelCopy, UNPLUGGED_STEP } from "@/lib/rooms-live/present";
import { ROOMS } from "@/lib/rooms-live/rooms";
import { buildSnapshot } from "@/lib/rooms-live/snapshot";
import { SENTINEL_CODES } from "@/lib/sentinel-ingest";
import type { SentinelView } from "@/lib/sentinel-read";

describe("sentinelCopy — device-aware by code", () => {
  it("MIC_MUTED_TONOR: the TONOR room gets the brief's words; a webcam or unknown room gets the neutral line (no mute-button words, the S1 rule)", () => {
    expect(sentinelCopy("MIC_MUTED_TONOR", "tonor")).toBe("Ask the doctor to unmute the TONOR mic.");
    expect(sentinelCopy("MIC_MUTED_TONOR", "webcam")).toBe("The microphone is muted. Ask the doctor to check the microphone.");
    expect(sentinelCopy("MIC_MUTED_TONOR", "unknown")).toBe(sentinelCopy("MIC_MUTED_TONOR", "webcam"));
    expect(sentinelCopy("MIC_MUTED_TONOR")).toBe(sentinelCopy("MIC_MUTED_TONOR", "unknown"));
    expect(/mute button|press the mute/i.test(sentinelCopy("MIC_MUTED_TONOR", "webcam")!)).toBe(false);
  });
  it("MIC_DEAD_WEBCAM is device-aware: the webcam room names the webcam, the TONOR room does not", () => {
    expect(sentinelCopy("MIC_DEAD_WEBCAM", "webcam")).toContain("webcam mic");
    expect(sentinelCopy("MIC_DEAD_WEBCAM", "tonor")).not.toContain("webcam");
    expect(sentinelCopy("MIC_DEAD_WEBCAM", "tonor")).not.toBe(sentinelCopy("MIC_DEAD_WEBCAM", "webcam"));
  });
  it("DEVICE_MISSING reuses the S1 unplugged copy per class", () => {
    expect(sentinelCopy("DEVICE_MISSING", "tonor")).toBe(UNPLUGGED_STEP.tonor);
    expect(sentinelCopy("DEVICE_MISSING", "webcam")).toBe(UNPLUGGED_STEP.webcam);
    expect(sentinelCopy("DEVICE_MISSING", "unknown")).toBe(UNPLUGGED_STEP.unknown);
    expect(sentinelCopy("DEVICE_MISSING")).toBe(UNPLUGGED_STEP.unknown);
  });
  it("every code but OK shows a line for every device class; OK and an unknown code show nothing", () => {
    for (const c of SENTINEL_CODES) {
      if (c === "OK") {
        expect(sentinelCopy(c)).toBeNull();
        continue;
      }
      for (const d of ["webcam", "tonor", "unknown"] as const) expect(sentinelCopy(c, d)).not.toBeNull();
    }
    expect(sentinelCopy("SOME RAW CODE")).toBeNull();
    expect(sentinelCopy("")).toBeNull();
  });
});

describe("RoomTile — the sentinel line (display only)", () => {
  const base: RoomRow = {
    room_id: "room_x", label: "OPD 3", doctor: null, doctor_known: true, state: "muted", state_since: null, detail_code: null,
    level: { rms: 0, zero: 1, at: null, stale: false }, baseline_rms: 0.009, device: { name: null, missing: false }, session: { open: true, since: null, chunk_age_s: 30 },
    steward: null, steward_line: null, steward_log: [], claim: null, ages_s: { listener: 1, heartbeat: 1, ext: 1 },
  };
  const sv = (over: Partial<SentinelView> = {}): SentinelView => ({
    code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.9, peak: 0.0005, last_action: null, last_result: null, mode: "shadow",
    updated_at: "2026-10-17T04:59:00.000Z", age_s: 60, ...over,
  });
  const tile = (sentinel: RoomRow["sentinel"], kind: RoomRow["device"]["kind"]) =>
    renderToStaticMarkup(createElement(RoomTile, { row: { ...base, sentinel, device: { ...base.device, kind } }, nowMs: 0, eng: false, onOpen: () => {} }));

  it("a TONOR room with MIC_MUTED_TONOR says to unmute the TONOR mic", () => {
    const m = tile(sv(), "tonor");
    expect(m).toContain("Ask the doctor to unmute the TONOR mic.");
    expect(m).toContain('data-code="MIC_MUTED_TONOR"');
    expect(m).toContain('data-mode="shadow"');
  });
  it("the same code on a webcam room says the neutral words, not the TONOR's", () => {
    const m = tile(sv(), "webcam");
    expect(m).toContain("Ask the doctor to check the microphone.");
    expect(m).not.toContain("unmute the TONOR mic");
    expect(m).not.toContain("mute button");
  });
  it("OK renders no sentinel line at all (nothing to show is not an alert)", () => {
    const m = tile(sv({ code: "OK" }), "tonor");
    expect(m).not.toContain("sentinel-line");
  });
  it("no sentinel (absent or null) renders no line", () => {
    expect(tile(undefined, "tonor")).not.toContain("sentinel-line");
    expect(tile(null, "tonor")).not.toContain("sentinel-line");
  });
  it("a fault code on a healthy-looking card still shows the line (display only, no actions added)", () => {
    const m = tile(sv({ code: "RECORDER_DOWN" }), "webcam");
    expect(m).toContain("Not recording. It restarts by itself within 5 minutes.");
    expect(m).toContain("How to fix"); // the existing button, unchanged
    expect(m).not.toContain("Restart recording");
  });
});

describe("buildSnapshot — attaches the newest sentinel row per room (S6 fan-out)", () => {
  const NOW = Date.parse("2026-10-16T06:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const sentinelText = "kind = 'sentinel'";
  function fakeDb(sentinelRows: unknown[]) {
    const calls: string[] = [];
    const db = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ");
      if (text.includes(sentinelText)) {
        calls.push("sentinel");
        return sentinelRows;
      }
      calls.push(text.slice(0, 40));
      return [];
    }) as unknown as import("@/lib/rooms-live/read").Db;
    return { db, calls };
  }

  it("a fresh row (<= 600 s) becomes the room's view; the other rooms stay null; no degraded name", async () => {
    const [a, b] = ROOMS as Array<{ room_id: string }>;
    const rows = [
      { room_id: a.room_id, received_at: iso(NOW - 30_000), payload: { code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.99, peak: null, last_action: "restart_app", last_result: "ok", mode: "shadow" }, rn: 1 },
    ];
    const { db, calls } = fakeDb(rows);
    const s = await buildSnapshot({ db: db as never, now: () => NOW, rooms: [a, b] as never });
    expect(s.rooms[0]!.sentinel).toEqual({
      code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.99, peak: null, last_action: "restart_app", last_result: "ok", mode: "shadow",
      updated_at: iso(NOW - 30_000), age_s: 30,
    });
    expect(s.rooms[1]!.sentinel).toBeNull();
    expect(s.degraded).not.toContain("sentinel");
    expect(calls.filter((c) => c === "sentinel")).toHaveLength(1);
  });

  it("a row older than 600 s is no data: the room stays null (the forwarder is down or the room went quiet)", async () => {
    const [a, b] = ROOMS as Array<{ room_id: string }>;
    const rows = [{ room_id: a.room_id, received_at: iso(NOW - 601_000), payload: { code: "RECORDER_DOWN", mic_class: "webcam", zr: null, peak: null, last_action: null, last_result: null, mode: "shadow" }, rn: 1 }];
    const { db } = fakeDb(rows);
    const s = await buildSnapshot({ db: db as never, now: () => NOW, rooms: [a, b] as never });
    expect(s.rooms[0]!.sentinel).toBeNull();
  });

  it("a failed sentinel read leaves every room null and never degrades the snapshot", async () => {
    const [a, b] = ROOMS as Array<{ room_id: string }>;
    const db = (async (strings: TemplateStringsArray, ..._v: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ");
      if (text.includes(sentinelText)) throw new Error("boom with a secret postgres://user:pw@host/db");
      return [];
    }) as unknown as import("@/lib/rooms-live/read").Db;
    const s = await buildSnapshot({ db: db as never, now: () => NOW, rooms: [a, b] as never });
    expect(s.rooms.map((r) => r.sentinel)).toEqual([null, null]);
    expect(s.degraded).not.toContain("sentinel");
  });
});
