/**
 * Room Bench dual-mic (Kickoff K-B) — pure helpers the kiosk hook leans on:
 * lockstep pause/end with backup isolation, source-tagged uploads, watchdog trip/clear,
 * naming (IndexedDB + R2), default backup device pick.
 */
import { describe, it, expect, vi } from "vitest";
import {
  chunkBasename,
  idbChunkKey,
  pickDefaultBackupDevice,
  rmsOfBytes,
  runLockstep,
  SILENCE_TRIP_MS,
  SILENCE_TRIP_SAMPLES,
  SilenceWatchdog,
  type WatchdogEvent,
  uploadBodies,
} from "../../lib/bench-dual";

describe("naming — primary byte-identical, backup segmented", () => {
  it("IndexedDB keys", () => {
    expect(idbChunkKey("bs_a", 3)).toBe("bs_a:3");
    expect(idbChunkKey("bs_a", 3, "primary")).toBe("bs_a:3");
    expect(idbChunkKey("bs_a", 3, "backup")).toBe("bs_a:backup:3");
  });
  it("R2 basenames", () => {
    expect(chunkBasename(7)).toBe("chunk_00007.webm");
    expect(chunkBasename(7, "backup")).toBe("backup_chunk_00007.webm");
  });
});

describe("uploadBodies — source tagging", () => {
  const meta = {
    session_id: "bs_a",
    idx: 2,
    content_type: "audio/webm",
    started_at: 1_000,
    ended_at: 301_000,
    duration_ms: 300_000,
    gap_before_ms: 0,
    size_bytes: 12345,
  };
  it("primary bodies carry NO source field (today's wire format)", () => {
    const b = uploadBodies({ ...meta, source: "primary" });
    expect(b.presign).toEqual({ session_id: "bs_a", idx: 2, content_type: "audio/webm" });
    expect("source" in b.row).toBe(false);
    expect(b.row).toMatchObject({ session_id: "bs_a", idx: 2, size_bytes: 12345, gap_before_ms: 0 });
  });
  it("backup bodies carry source:'backup' on presign AND row", () => {
    const b = uploadBodies({ ...meta, source: "backup" });
    expect(b.presign).toEqual({ session_id: "bs_a", idx: 2, content_type: "audio/webm", source: "backup" });
    expect(b.row).toMatchObject({ source: "backup", idx: 2 });
  });
});

describe("SilenceWatchdog — trip after ~60 s of RMS≈0, clear when audio returns", () => {
  /**
   * BUILD 2 §2.3 — FED AT THE REAL CADENCE, which is the whole point of the change.
   *
   * These tests used to feed samples thirty seconds apart and expect a trip, because the old
   * watchdog compared two wall-clock moments and never asked how many samples it had actually
   * taken. That is the bug: sixty seconds of NOT LOOKING counted as sixty seconds of silence, so
   * a throttled timer or a long pause could convict a microphone that was working throughout.
   * The watchdog is fed once a second in the room, so the tests feed it once a second too.
   */
  const feedQuiet = (wd: SilenceWatchdog, from: number, samples: number): WatchdogEvent => {
    let last: WatchdogEvent = null;
    for (let i = 0; i < samples; i++) last = wd.feed(0, from + i * 1_000);
    return last;
  };

  it("does not trip on short silence, trips once at the threshold, clears once on audio", () => {
    const wd = new SilenceWatchdog();
    const t0 = 1_000_000;
    // 59 consecutive quiet samples: not yet.
    expect(feedQuiet(wd, t0, SILENCE_TRIP_SAMPLES - 1)).toBeNull();
    // the 60th trips, exactly once
    expect(wd.feed(0, t0 + (SILENCE_TRIP_SAMPLES - 1) * 1_000)).toBe("trip");
    expect(wd.isTripped).toBe(true);
    expect(wd.feed(0, t0 + SILENCE_TRIP_SAMPLES * 1_000)).toBeNull(); // no double trip
    expect(wd.feed(0.05, t0 + (SILENCE_TRIP_SAMPLES + 1) * 1_000)).toBe("clear");
    expect(wd.isTripped).toBe(false);
    expect(wd.feed(0.05, t0 + (SILENCE_TRIP_SAMPLES + 2) * 1_000)).toBeNull(); // no double clear
  });

  it("audio in between resets the run", () => {
    const wd = new SilenceWatchdog({ tripAfterMs: 10_000 }); // 10 samples
    expect(feedQuiet(wd, 0, 9)).toBeNull();
    expect(wd.feed(0.02, 9_000)).toBeNull(); // speech — the run goes back to zero
    expect(wd.run).toBe(0);
    expect(feedQuiet(wd, 10_000, 9)).toBeNull(); // nine more is still not ten
    expect(wd.feed(0, 19_000)).toBe("trip");
  });

  /**
   * THE FALSE ALARM THIS REMOVES, in one test.
   *
   * A minute of wall clock with only two samples taken in it is not a minute of observed silence.
   * The old class tripped here; this one counts two samples and reports nothing.
   */
  it("§2.3 — A SKIPPED SAMPLE RESETS THE RUN: sixty seconds of not looking is not silence", () => {
    const wd = new SilenceWatchdog();
    expect(wd.feed(0, 0)).toBeNull();
    // the timer was throttled for a minute — one sample, a long way after the last
    expect(wd.feed(0, 60_000)).toBeNull();
    expect(wd.run).toBe(0);
    // and it takes a full run of real samples from here, not one more
    expect(feedQuiet(wd, 61_000, SILENCE_TRIP_SAMPLES - 1)).toBeNull();
    expect(wd.feed(0, 61_000 + (SILENCE_TRIP_SAMPLES - 1) * 1_000)).toBe("trip");
  });

  it("§2.3 — a gap cannot CLEAR a tripped watchdog either; it is evidence of nothing", () => {
    const wd = new SilenceWatchdog({ tripAfterMs: 3_000 });
    expect(feedQuiet(wd, 0, 2)).toBeNull();
    expect(wd.feed(0, 2_000)).toBe("trip");
    expect(wd.feed(0.5, 90_000)).toBeNull(); // loud, but after a gap — no clear
    expect(wd.isTripped).toBe(true);
    expect(wd.feed(0.5, 91_000)).toBe("clear"); // the next real sample clears it
  });

  it("room noise (RMS well above the floor) never trips; reset() clears state", () => {
    const wd = new SilenceWatchdog();
    for (let t = 0; t < 10 * SILENCE_TRIP_MS; t += 1_000) expect(wd.feed(0.01, t)).toBeNull();
    wd.feed(0, 0);
    wd.reset();
    expect(wd.feed(0, SILENCE_TRIP_MS - 1)).toBeNull();
  });
  it("rmsOfBytes: flat 128 is 0, full swing is ~1", () => {
    expect(rmsOfBytes(new Uint8Array(64).fill(128))).toBe(0);
    const loud = new Uint8Array(64);
    for (let i = 0; i < 64; i++) loud[i] = i % 2 ? 255 : 1;
    expect(rmsOfBytes(loud)).toBeGreaterThan(0.98);
  });
});

describe("runLockstep — pause/end run both lanes; backup errors are isolated", () => {
  it("runs primary then backup and reports both ok", async () => {
    const order: string[] = [];
    const r = await runLockstep("pause", {
      primary: async () => {
        order.push("primary");
      },
      backup: async () => {
        order.push("backup");
      },
    });
    expect(order).toEqual(["primary", "backup"]);
    expect(r).toEqual({ primary: { ok: true }, backup: { ok: true } });
  });
  it("a backup failure is reported, never thrown, and the primary result stands", async () => {
    const onErr = vi.fn();
    const r = await runLockstep(
      "end",
      {
        primary: async () => undefined,
        backup: async () => {
          throw new Error("backup_track_ended");
        },
      },
      onErr,
    );
    expect(r.primary).toEqual({ ok: true });
    expect(r.backup).toEqual({ ok: false, error: "backup_track_ended" });
    expect(onErr).toHaveBeenCalledWith("end", "backup_track_ended");
  });
  it("a throwing backup-error reporter cannot hurt the lanes", async () => {
    const r = await runLockstep(
      "rotate",
      { primary: async () => undefined, backup: async () => { throw new Error("x"); } },
      () => {
        throw new Error("reporter exploded");
      },
    );
    expect(r.primary).toEqual({ ok: true });
  });
  it("a primary failure still gives the backup its turn, then propagates", async () => {
    const backup = vi.fn(async () => undefined);
    await expect(
      runLockstep("pause", {
        primary: async () => {
          throw new Error("primary_failed");
        },
        backup,
      }),
    ).rejects.toThrow("primary_failed");
    expect(backup).toHaveBeenCalledTimes(1);
  });
  it("no backup device → skipped, never an error", async () => {
    const r = await runLockstep("resume", { primary: async () => undefined, backup: null });
    expect(r.backup).toEqual({ skipped: true });
  });
});

describe("pickDefaultBackupDevice", () => {
  const devs = [
    { deviceId: "default", label: "Default - USB Conference Mic" },
    { deviceId: "usb1", label: "Jabra Speak 410 USB" },
    { deviceId: "bi1", label: "MacBook Pro Microphone (Built-in)" },
    { deviceId: "x2", label: "Other Input" },
  ];
  it("prefers a built-in mic that is not the primary", () => {
    expect(pickDefaultBackupDevice(devs, "usb1")).toBe("bi1");
  });
  it("falls back to any non-primary input, never the primary or 'default'", () => {
    expect(pickDefaultBackupDevice([devs[0]!, devs[1]!, devs[3]!], "usb1")).toBe("x2");
    expect(pickDefaultBackupDevice([devs[0]!, devs[1]!], "usb1")).toBeNull();
  });
});
