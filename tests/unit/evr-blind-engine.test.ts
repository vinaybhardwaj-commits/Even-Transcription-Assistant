/**
 * S7-2-R2 R2 — held-out rule LIFTED by V 10 Oct 2026: a formerly held-out consult is now PROCESSED like any other (the guards in engines/index.ts are no-ops on the empty set). Originally: the engine-level guards pinned ON THEIR OWN. The readers that would also refuse (consult_text, pulse_record) are STUBBED to succeed, so a test here fails when only
 * the guard in engines/index.ts is removed: evaluateEvrPerturbUnit (bench) and the llm-unit guard (rubric_run / bench of a consult).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FORMER_BLIND_PAIRS } from "../support/former-blind-pairs";

const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const calls = { text: 0, record: 0, chat: 0 };
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    const t = strings.join("?");
    return /AS ist_date/.test(t) && /WHERE consult_key/.test(t) ? [{ room_id: BR, ist_date: BD }] : [];
  },
}));
vi.mock("@/lib/rubrics/readers/consult-text", async (orig) => ({
  ...((await orig()) as object),
  readConsultText: async () => { calls.text++; return { ok: true, data: { consult_key: "k", source: "window_english", span_ms: 1000, lines: [{ t_ms: 0, speaker: "doctor", speaker_idx: 0, text: "hello" }], chars: 5, truncated: false, turns: [] } }; },
}));
vi.mock("@/lib/rubrics/readers/pulse-record", () => ({
  readPulseRecord: async () => { calls.record++; return { ok: false, reason: "no_data" }; },
}));
const { evaluateEvrPerturbUnit, evaluateUnit } = await import("@/lib/rubrics/engines");
const L = await import("@/lib/rubrics/llm");
const { getRubric } = await import("@/lib/rubrics/registry");
const evr = getRubric("encounter_vs_record")!;
const affect = getRubric("consult_chair_affect")!;

beforeEach(() => { calls.text = calls.record = calls.chat = 0; L.setRubricChatForTests(async () => { calls.chat++; return { content: "{}", model: "m", latency_ms: 1 }; }); });

describe("engine guards are no-ops now: a formerly held-out consult is processed", () => {
  it("the held-out set is empty and the former pair is not blind", async () => {
    const B = await import("@/lib/rubrics/blind-room-days");
    expect(B.BLIND_ROOM_DAYS).toHaveLength(0);
    expect(B.isBlindRoomDay(BD, BR)).toBe(false);
  });
  it("evaluateEvrPerturbUnit: a formerly held-out consult is NOT refused blind_room_day; the record reader is reached", async () => {
    const out = await evaluateEvrPerturbUnit(evr, "enc_x@m1", 5);
    expect(out).not.toMatchObject({ reason: "blind_room_day" });
    expect(calls.record).toBeGreaterThan(0);
  });
  it("evaluateUnit of an llm rubric on a formerly held-out consult is not skipped blind_room_day; its text is read", async () => {
    for (const r of [evr, affect]) {
      expect(await evaluateUnit(r, "consult", "enc_x@m1"), r.id).not.toMatchObject({ reason: "blind_room_day" });
    }
    expect(calls.text).toBeGreaterThan(0);
  });
});
