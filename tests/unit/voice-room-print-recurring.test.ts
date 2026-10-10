/**
 * The recurring-voice finder (lib/voice-room-print/recurring.ts). Every vector is built here by hand: a voice is a
 * fixed unit direction plus a small per-window wobble, so the expected cosines are known without calling the code
 * under test. Window ids, labels and days are fake.
 */
import { describe, it, expect } from "vitest";
import { makeFakeClinician } from "../support/fake-identity";
import {
  AMBIGUITY_RATIO, MIN_DAYS, MIN_SPEECH_MS, MIN_SUPPORT, MIN_WINDOWS, SAME_VOICE,
  nearestClinician, recurringVoice, type Unit,
} from "@/lib/voice-room-print/recurring";

const DIM = 16;
/** Axis-aligned voices: voice k is e_k, so two different voices have cosine 0. */
const axis = (k: number) => { const v = new Float32Array(DIM); v[k] = 1; return v; };
/** voice k with a wobble on axis DIM-1 (cosine to e_k = 1/sqrt(1+w^2)); w = 0.3 → 0.958. */
const wob = (k: number, w = 0.3) => { const v = axis(k); v[DIM - 1] = w; return v; };

const DOC = 0, NURSE = 1;
let patient = 2; // each patient is a fresh axis, heard once (reset per test case by clinic())
const sp = (label: string, v: Float32Array, speech_ms = 60_000) => ({ label, speech_ms, embedding: v });
const win = (i: number, day: string, speakers: Unit["speakers"]): Unit => ({ window_id: `bw_fake_${String(i).padStart(3, "0")}`, day, speakers });
const freshPatient = () => { if (patient > DIM - 2) throw new Error("fixture ran out of patient axes"); return axis(patient++); };

/** n windows over the days given (round robin); the doctor in each, plus one new patient. */
function clinic(n: number, days: string[], extra: (i: number) => Unit["speakers"] = () => []): Unit[] {
  patient = 2;
  return Array.from({ length: n }, (_, i) => win(i, days[i % days.length]!, [sp("spk0", wob(DOC, i % 2 ? 0.3 : -0.3)), sp("spk1", freshPatient()), ...extra(i)]));
}

describe("the pinned thresholds", () => {
  it("are the provisional values the report states", () => {
    expect([SAME_VOICE, MIN_SPEECH_MS, MIN_WINDOWS, MIN_DAYS, MIN_SUPPORT, AMBIGUITY_RATIO]).toEqual([0.55, 3000, 4, 2, 0.5, 0.7]);
  });
});

describe("recurringVoice", () => {
  it("finds the doctor who recurs across windows and days, and leaves every patient out", () => {
    const r = recurringVoice(clinic(8, ["2026-10-03", "2026-10-05"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.n_windows).toBe(8);
    expect(r.n_days).toBe(2);
    expect(r.support).toBe(1);
    expect(r.members.every((m) => m.label === "spk0")).toBe(true);
    // the wobbles cancel: the centroid is the doctor's axis
    expect(r.centroid[DOC]).toBeCloseTo(1, 5);
    expect(r.runner_up_windows).toBe(0);
  });

  it("does not care which label the doctor has in each window", () => {
    const units = clinic(6, ["2026-10-03", "2026-10-04"]).map((u, i) => (i % 2 ? { ...u, speakers: [...u.speakers].reverse().map((s, j) => ({ ...s, label: `spk${j}` })) } : u));
    const r = recurringVoice(units);
    expect(r.ok && r.n_windows).toBe(6);
  });

  it("refuses a nurse case: a second voice in as many windows makes it ambiguous", () => {
    const r = recurringVoice(clinic(8, ["2026-10-03", "2026-10-05"], () => [sp("spk2", wob(NURSE), 50_000)]));
    expect(r).toMatchObject({ ok: false, reason: "ambiguous_recurring_voice", n_windows: 8, runner_up_windows: 8 });
  });

  it("keeps the doctor when the second voice is in under 70% of the doctor's windows", () => {
    // nurse in 5 of 8 = 0.625 < 0.7
    const r = recurringVoice(clinic(8, ["2026-10-03", "2026-10-05"], (i) => (i < 5 ? [sp("spk2", wob(NURSE), 50_000)] : [])));
    expect(r).toMatchObject({ ok: true, n_windows: 8, runner_up_windows: 5 });
  });

  it("refuses at 70% exactly (the runner-up bound is inclusive)", () => {
    // 10 windows, nurse in 7 = 0.7
    const r = recurringVoice(clinic(10, ["2026-10-03", "2026-10-05"], (i) => (i < 7 ? [sp("spk2", wob(NURSE), 50_000)] : [])));
    expect(r).toMatchObject({ ok: false, reason: "ambiguous_recurring_voice", runner_up_windows: 7 });
  });

  it("refuses one day, however many windows", () => {
    expect(recurringVoice(clinic(9, ["2026-10-03"]))).toMatchObject({ ok: false, reason: "too_few_days", n_windows: 9, n_days: 1 });
  });

  it("refuses fewer than 4 windows offered, before any work", () => {
    expect(recurringVoice(clinic(3, ["2026-10-03", "2026-10-04"]))).toMatchObject({ ok: false, reason: "too_few_windows", windows_offered: 3, n_windows: 0 });
  });

  it("refuses when the doctor is heard in fewer than half the windows", () => {
    // 4 windows with the doctor, 5 with only a fresh patient each
    const units = [...clinic(4, ["2026-10-03", "2026-10-04"]), ...Array.from({ length: 5 }, (_, i) => win(100 + i, "2026-10-04", [sp("spk0", freshPatient())]))];
    expect(recurringVoice(units)).toMatchObject({ ok: false, reason: "low_support", n_windows: 4, windows_offered: 9 });
  });

  it("refuses when no voice comes back at all", () => {
    patient = 2;
    const units = Array.from({ length: 6 }, (_, i) => win(i, i % 2 ? "2026-10-03" : "2026-10-04", [sp("spk0", freshPatient())]));
    expect(recurringVoice(units)).toMatchObject({ ok: false, reason: "no_recurring_voice" });
  });

  it("ignores a speaker under 3 s of speech, and accepts one at exactly 3 s", () => {
    const short = clinic(6, ["2026-10-03", "2026-10-04"]).map((u) => ({ ...u, speakers: u.speakers.map((s) => (s.label === "spk0" ? { ...s, speech_ms: 2_999 } : s)) }));
    expect(recurringVoice(short).ok).toBe(false);
    const edge = clinic(6, ["2026-10-03", "2026-10-04"]).map((u) => ({ ...u, speakers: u.speakers.map((s) => (s.label === "spk0" ? { ...s, speech_ms: 3_000 } : s)) }));
    expect(recurringVoice(edge)).toMatchObject({ ok: true, n_windows: 6 });
  });

  it("joins two windows at a pairwise cosine just over 0.55, and not just under", () => {
    // +w and -w wobbles meet at cosine (1-w^2)/(1+w^2): w = 0.5373 gives 0.5520, w = 0.5404 gives 0.5479
    const pair = (w: number) => Array.from({ length: 6 }, (_, i) => win(i, i % 2 ? "2026-10-03" : "2026-10-04", [sp("spk0", wob(DOC, i % 2 ? w : -w))]));
    expect(recurringVoice(pair(0.5373))).toMatchObject({ ok: true, n_windows: 6 });
    // under: each sign is its own voice of 3 identical windows on one day, under MIN_WINDOWS
    expect(recurringVoice(pair(0.5404))).toMatchObject({ ok: false, reason: "too_few_windows", n_windows: 3 });
  });

  it("is deterministic under input order", () => {
    const units = clinic(8, ["2026-10-03", "2026-10-05"], (i) => (i < 4 ? [sp("spk2", wob(NURSE), 50_000)] : []));
    const a = recurringVoice(units), b = recurringVoice([...units].reverse());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.members).toEqual(a.members);
      expect(Array.from(b.centroid)).toEqual(Array.from(a.centroid));
    }
  });
});

describe("nearestClinician", () => {
  it("returns the closest print with its score, skips a wrong-length print, and is null with none", () => {
    const [a, b, c] = [1, 2, 3].map((n) => makeFakeClinician(n).id);
    const prints = [{ clinician_id: a!, v: axis(NURSE) }, { clinician_id: b!, v: wob(DOC, 1) }, { clinician_id: c!, v: new Float32Array(4) }];
    const r = nearestClinician(axis(DOC), prints)!;
    expect(r.clinician_id).toBe(b);
    expect(r.score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(nearestClinician(axis(DOC), [])).toBeNull();
  });
});
