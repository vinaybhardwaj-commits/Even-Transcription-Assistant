/**
 * Build 1 §D — the nightly tuning-fork canary.
 *
 * The clip may not exist yet: freezing it is an operator action (PRD §6 E2) and this build ships
 * before it. An absent clip must be a CLEAN NO-OP — not an error, not an alarm, and above all
 * not a stored reference of the empty string, which would make the first real clip look like
 * drift on the day it arrives.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runTuningFork,
  forkHash,
  normalizeForkText,
  TUNING_FORK_R2_KEY,
  ALARM_KIND_REFERENCE,
  ALARM_KIND_DRIFT,
} from "@/lib/stt/tuning-fork";

const CLIP = new Uint8Array([1, 2, 3, 4]);

function io(over: Partial<Parameters<typeof runTuningFork>[0]> = {}) {
  const alarms: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const base = {
    fetchClip: async () => CLIP,
    transcribe: async () => ({ ok: true, transcript: "the patient reports chest pain" }),
    readReference: async () => null,
    writeAlarm: async (kind: string, detail: Record<string, unknown>) => { alarms.push({ kind, detail }); },
    log: (m: string) => { logs.push(m); },
  };
  return { io: { ...base, ...over }, alarms, logs };
}

describe("the clip may not exist yet", () => {
  it("an absent clip is a clean no-op with a log line — no alarm, no reference", async () => {
    const { io: i, alarms, logs } = io({ fetchClip: async () => null });
    const r = await runTuningFork(i);
    expect(r).toEqual({ kind: "absent" });
    expect(alarms).toHaveLength(0);
    expect(logs.join(" ")).toContain(TUNING_FORK_R2_KEY);
  });

  it("an absent clip never stores a reference of the empty string", async () => {
    const { io: i, alarms } = io({ fetchClip: async () => null });
    await runTuningFork(i);
    expect(alarms.find((a) => a.kind === ALARM_KIND_REFERENCE)).toBeUndefined();
  });

  it("a zero-byte object is treated as absent, not as a silent fork", async () => {
    const { io: i, alarms } = io({ fetchClip: async () => new Uint8Array(0) });
    expect(await runTuningFork(i)).toEqual({ kind: "absent" });
    expect(alarms).toHaveLength(0);
  });

  it("an absent clip costs no inference", async () => {
    const transcribe = vi.fn();
    const { io: i } = io({ fetchClip: async () => null, transcribe: transcribe as never });
    await runTuningFork(i);
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("first run stores the reference; later runs compare against it", () => {
  it("the first run stores, and does not alarm against itself", async () => {
    const { io: i, alarms } = io({ readReference: async () => null });
    const r = await runTuningFork(i);
    expect(r.kind).toBe("reference_stored");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.kind).toBe(ALARM_KIND_REFERENCE);
    expect(alarms[0]!.detail.sha256).toBe(forkHash("the patient reports chest pain"));
  });

  it("a matching hash writes NOTHING — a nightly all-clear would bury the alarms", async () => {
    const ref = forkHash("the patient reports chest pain");
    const { io: i, alarms } = io({ readReference: async () => ref });
    const r = await runTuningFork(i);
    expect(r).toEqual({ kind: "match", sha256: ref });
    expect(alarms).toHaveLength(0);
  });

  it("a changed transcript raises TUNING_FORK_DRIFT with both hashes", async () => {
    const ref = forkHash("the patient reports chest pain");
    const { io: i, alarms } = io({
      readReference: async () => ref,
      transcribe: async () => ({ ok: true, transcript: "the patient reports chest pain and nausea" }),
    });
    const r = await runTuningFork(i);
    expect(r.kind).toBe("drift");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.kind).toBe(ALARM_KIND_DRIFT);
    expect(alarms[0]!.detail.reference_sha256).toBe(ref);
    expect(alarms[0]!.detail.sha256).not.toBe(ref);
  });
});

describe("an outage is not drift", () => {
  it("Whisper failing is reported, never alarmed — they are different facts", async () => {
    const { io: i, alarms } = io({ transcribe: async () => ({ ok: false, error: "network: down" }) });
    const r = await runTuningFork(i);
    expect(r).toEqual({ kind: "unavailable", error: "network: down" });
    expect(alarms).toHaveLength(0);
  });
});

describe("the hash is stable against what does not matter", () => {
  it("punctuation and casing do not move it — a canary that fires on a comma gets silenced", () => {
    expect(forkHash("The patient reports chest pain."))
      .toBe(forkHash("the  patient, reports chest pain"));
  });

  it("a real word change DOES move it", () => {
    expect(forkHash("chest pain")).not.toBe(forkHash("chest pains"));
  });

  it("normalizeForkText keeps letters and numbers across scripts", () => {
    expect(normalizeForkText("  Hello,  World! 42 ")).toBe("hello world 42");
    expect(normalizeForkText("रोगी को दर्द है")).toBe("रोगी को दर्द है");
    expect(normalizeForkText(null)).toBe("");
  });

  it("the same clip twice is the same hash — the canary must not be its own noise source", async () => {
    const a = await runTuningFork(io().io);
    const b = await runTuningFork(io().io);
    expect(a).toEqual(b);
  });
});
