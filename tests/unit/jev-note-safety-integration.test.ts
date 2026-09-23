/**
 * lib/jev/note-safety-shadow.ts, END TO END through the REAL lib/jev/ask.ts (unlike
 * jev-note-safety-shadow.test.ts, which mocks askJev as a black box). Only `sql` (the encounter
 * read AND the jev_decision write) and getJevClient (the actual network boundary) are mocked —
 * everything in between is the real fan-out/registry/persistence code. This is what actually
 * proves the order's "no text column written" requirement: the real INSERT payload is inspected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const dbCalls: Array<{ text: string; values: unknown[] }> = [];
let encounterRow: Row | null = null;
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    dbCalls.push({ text, values });
    if (text.includes("FROM encounter")) return Promise.resolve(encounterRow ? [encounterRow] : []);
    if (text.includes("INSERT INTO jev_decision")) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  return { sql };
});

const SENSITIVE_SENTENCE = "Invented finding: chest pain not mentioned by the patient anywhere.";
const SENSITIVE_TRANSCRIPT = "the actual transcript prose that must never leak into a decision row";

const systemOneMock = vi.fn(async (req: { questions: Record<string, unknown> }) => ({
  model: "jev-x",
  usage: { input_tokens: 40, output_tokens: 5 },
  latency_ms: 30,
  // Answer every fanned-out question with a fixed noul, regardless of wording — this test cares
  // about what gets WRITTEN, not about scoring accuracy.
  answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", noul: 0.08 }])),
}));
vi.mock("@/lib/jev/client", () => ({ getJevClient: () => ({ systemOne: systemOneMock }) }));

import { runNoteSafetyShadowAsync } from "@/lib/jev/note-safety-shadow";

beforeEach(() => {
  dbCalls.length = 0;
  encounterRow = null;
  systemOneMock.mockClear();
  process.env.JEV_NOTE_FAITHFULNESS = "on";
});

describe("note-safety shadow, end to end through the real ask.ts — no text column written", () => {
  it("the jev_decision INSERT payload never contains the note sentence or the transcript, anywhere", async () => {
    encounterRow = {
      id: "enc_1",
      note_json: { chief_complaint: SENSITIVE_SENTENCE },
      transcript_clean: SENSITIVE_TRANSCRIPT,
    };
    await runNoteSafetyShadowAsync("enc_1");

    const insertCalls = dbCalls.filter((c) => c.text.includes("INSERT INTO jev_decision"));
    expect(insertCalls.length).toBeGreaterThan(0);
    for (const call of insertCalls) {
      // The whole batch crosses as one JSON parameter (lib/jev/decision-store.ts) — stringify
      // every value the call carries and search the WHOLE thing, not just one column.
      const wholeCall = JSON.stringify(call.values);
      expect(wholeCall).not.toContain(SENSITIVE_SENTENCE);
      expect(wholeCall).not.toContain(SENSITIVE_TRANSCRIPT);
      // Nor any substring of the transcript long enough to be identifying.
      expect(wholeCall).not.toContain("actual transcript prose");
    }
  });

  it("systemOne itself DOES receive the transcript excerpt (it must, to judge faithfulness) — the guarantee is about what is PERSISTED, not what is SENT", async () => {
    encounterRow = { id: "enc_1", note_json: { chief_complaint: "Fever." }, transcript_clean: SENSITIVE_TRANSCRIPT };
    await runNoteSafetyShadowAsync("enc_1");
    const sentStates = systemOneMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(sentStates.some((s) => s.includes(SENSITIVE_TRANSCRIPT))).toBe(true);
  });

  it("the persisted answer is the structured JevAnswer only (type + noul), never re-wrapping the sentence text", async () => {
    encounterRow = { id: "enc_1", note_json: { chief_complaint: SENSITIVE_SENTENCE }, transcript_clean: "t" };
    await runNoteSafetyShadowAsync("enc_1");
    const insertCall = dbCalls.find((c) => c.text.includes("INSERT INTO jev_decision"))!;
    const payload = JSON.parse(insertCall.values[0] as string) as Row[];
    for (const row of payload) {
      expect(row.answer).toEqual({ type: "noul", noul: 0.08 });
      expect(Object.keys(row)).not.toContain("text");
      expect(Object.keys(row)).not.toContain("sentence");
      expect(Object.keys(row)).not.toContain("transcript");
    }
  });
});
