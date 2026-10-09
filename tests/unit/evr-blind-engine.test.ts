/**
 * S7-2-R2 R2 — the engine-level held-out guards pinned ON THEIR OWN. The readers that would also refuse (consult_text, pulse_record) are STUBBED to succeed, so a test here fails when only
 * the guard in engines/index.ts is removed: evaluateEvrPerturbUnit (bench) and the llm-unit guard (rubric_run / bench of a consult).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const calls = { text: 0, record: 0, chat: 0 };
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    const t = strings.join("?");
    return /AS ist_date/.test(t) && /WHERE consult_key/.test(t) ? [{ room_id: BR, ist_date: BD }] : [];
  },
}));
vi.mock("@/lib/rubrics/readers/consult-text", async (orig) => ({
  ...((await orig()) as object),
  readConsultText: async () => { calls.text++; return { ok: true, data: { consult_key: "k", source: "database", span_ms: 1000, lines: [{ t_ms: 0, speaker: "doctor", speaker_idx: 0, text: "hello" }], chars: 5, truncated: false, turns: [] } }; },
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

describe("engine guards on their own", () => {
  it("evaluateEvrPerturbUnit: a held-out consult returns blind_room_day with 0 text reads, 0 record reads, 0 model calls (readers stubbed to succeed)", async () => {
    expect(await evaluateEvrPerturbUnit(evr, "enc_x@m1", 5)).toMatchObject({ ok: false, reason: "blind_room_day", calls: 0 });
    expect(calls).toEqual({ text: 0, record: 0, chat: 0 });
  });
  it("the llm-unit guard: evaluateUnit of an llm rubric on a held-out consult is skipped blind_room_day with 0 text reads and 0 model calls (readers stubbed to succeed)", async () => {
    for (const r of [evr, affect]) {
      expect(await evaluateUnit(r, "consult", "enc_x@m1"), r.id).toMatchObject({ status: "skipped", reason: "blind_room_day" });
    }
    expect(calls).toEqual({ text: 0, record: 0, chat: 0 });
  });
});
