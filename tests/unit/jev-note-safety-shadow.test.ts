/**
 * lib/jev/note-safety-shadow.ts — U4 + U8 fire-and-forget wiring (order NOTE-SAFETY-SHADOW.md).
 *
 * lib/jev/ask.ts is mocked as a black box here — its own behaviour (fan-out, persistence,
 * confidence bands) is tests/unit/jev-ask.test.ts's job. This file tests note-safety-shadow's OWN
 * logic: does it read the right row, split the note correctly, group by excerpt, and — the
 * required cases — never touch either when its flag is off, and parse that flag strictly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
const dbCalls: Array<{ text: string; values: unknown[] }> = [];
let dbResponder: () => Row[] = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    dbCalls.push({ text: strings.raw.join("?"), values });
    return Promise.resolve(dbResponder());
  };
  return { sql };
});

const askJevMock = vi.fn(async (_state: unknown, _asks: Row[], _opts?: Row) => ({ model: "jev-x", latencyMs: 10, results: {}, persisted: { ok: true, written: 0 } }));
vi.mock("@/lib/jev/ask", () => ({ askJev: (state: unknown, asks: Row[], opts?: Row) => askJevMock(state, asks, opts) }));

const ENV = "JEV_NOTE_FAITHFULNESS";
let savedEnv: string | undefined;

beforeEach(() => {
  dbCalls.length = 0;
  dbResponder = () => [];
  askJevMock.mockClear();
  savedEnv = process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

import { runNoteSafetyShadow, runNoteSafetyShadowAsync } from "@/lib/jev/note-safety-shadow";
import { FlagValueError } from "@/lib/flags";
import { JevHttpError } from "@/lib/jev/types";

describe("runNoteSafetyShadowAsync — flag off => zero Jev calls, zero DB reads", () => {
  it("flag unset: returns {ran:false}, never touches sql or askJev", async () => {
    delete process.env[ENV];
    const r = await runNoteSafetyShadowAsync("enc_1");
    expect(r).toEqual({ ran: false, u4Sentences: 0, u8Questions: 0 });
    expect(dbCalls).toHaveLength(0);
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("JEV_NOTE_FAITHFULNESS=off: same as unset — the falsy half of the flag convention", async () => {
    process.env[ENV] = "off";
    const r = await runNoteSafetyShadowAsync("enc_1");
    expect(r).toEqual({ ran: false, u4Sentences: 0, u8Questions: 0 });
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("JEV_NOTE_FAITHFULNESS=false and =0 also disable it, despite being non-empty JS-truthy strings", async () => {
    for (const v of ["false", "0"]) {
      process.env[ENV] = v;
      const r = await runNoteSafetyShadowAsync("enc_1");
      expect(r.ran, `JEV_NOTE_FAITHFULNESS=${v}`).toBe(false);
    }
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("a malformed value THROWS FlagValueError rather than enabling it", async () => {
    process.env[ENV] = "maybe";
    await expect(runNoteSafetyShadowAsync("enc_1")).rejects.toBeInstanceOf(FlagValueError);
    expect(askJevMock).not.toHaveBeenCalled();
  });
});

describe("runNoteSafetyShadowAsync — flag on: reads the row, splits the note, asks U4 + U8", () => {
  beforeEach(() => {
    process.env[ENV] = "on";
  });

  it("no encounter row, or a row missing note_json/transcript_clean: returns {ran:false}, no Jev call", async () => {
    dbResponder = () => [];
    expect(await runNoteSafetyShadowAsync("enc_missing")).toEqual({ ran: false, u4Sentences: 0, u8Questions: 0 });
    dbResponder = () => [{ id: "enc_1", note_json: null, transcript_clean: "hello" }];
    expect(await runNoteSafetyShadowAsync("enc_1")).toEqual({ ran: false, u4Sentences: 0, u8Questions: 0 });
    dbResponder = () => [{ id: "enc_1", note_json: { chief_complaint: "fever" }, transcript_clean: null }];
    expect(await runNoteSafetyShadowAsync("enc_1")).toEqual({ ran: false, u4Sentences: 0, u8Questions: 0 });
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("splits the note into sentences and asks U4 (one askJev call per excerpt group) plus U8 (one call)", async () => {
    dbResponder = () => [{ id: "enc_1", note_json: { chief_complaint: "Fever for 3 days. No cough." }, transcript_clean: "patient reports fever" }];
    const r = await runNoteSafetyShadowAsync("enc_1");
    expect(r.ran).toBe(true);
    expect(r.u4Sentences).toBe(2); // "Fever for 3 days." and "No cough."
    expect(r.u8Questions).toBe(4); // the four completeness questions
    expect(askJevMock).toHaveBeenCalledTimes(2); // one U4 group call (short transcript -> one group) + one U8 call
  });

  it("each U4 ask's subjectId is encounterId:path — NEVER the sentence text itself", async () => {
    dbResponder = () => [{ id: "enc_1", note_json: { chief_complaint: "Invented finding not in transcript." }, transcript_clean: "short" }];
    await runNoteSafetyShadowAsync("enc_9");
    const u4Call = askJevMock.mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as Row[])[0]?.questionId === "note_sentence_supported");
    expect(u4Call).toBeDefined();
    const asks = u4Call![1] as Row[];
    for (const ask of asks) {
      expect(ask.subjectId).toBe("enc_9:chief_complaint");
      expect(String(ask.subjectId)).not.toContain("Invented finding");
    }
  });

  it("U4's shared state carries the transcript excerpt; U8's state carries the note and an excerpt", async () => {
    dbResponder = () => [{ id: "enc_1", note_json: { chief_complaint: "Fever." }, transcript_clean: "the real transcript" }];
    await runNoteSafetyShadowAsync("enc_1");
    const [u4State] = askJevMock.mock.calls[0]!;
    const [u8State, u8Asks] = askJevMock.mock.calls[1]!;
    expect(u4State).toEqual({ transcript_excerpt: "the real transcript" });
    expect((u8Asks as Row[]).every((a) => a.subjectType === "encounter")).toBe(true);
    expect(u8State).toMatchObject({ transcript_excerpt: "the real transcript" });
  });

  it("a note with no checkable text (all empty/numeric fields) asks U8 only, U4 is skipped with 0 sentences", async () => {
    dbResponder = () => [{ id: "enc_1", note_json: { estimated_blood_loss_ml: 0, counts_correct: true }, transcript_clean: "transcript" }];
    const r = await runNoteSafetyShadowAsync("enc_1");
    expect(r.u4Sentences).toBe(0);
    expect(askJevMock).toHaveBeenCalledTimes(1); // U8 only
  });
});

describe("runNoteSafetyShadow — the fire-and-forget wrapper", () => {
  it("never throws, even when the async half rejects (a malformed flag)", () => {
    process.env[ENV] = "maybe";
    expect(() => runNoteSafetyShadow("enc_1")).not.toThrow();
  });

  it("logs a warning (metadata only — encounter id and error string, never note/transcript text) when the async half fails", async () => {
    process.env[ENV] = "on";
    dbResponder = () => {
      throw new Error("db unreachable");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runNoteSafetyShadow("enc_secret_patient_context");
    await new Promise((r) => setTimeout(r, 0)); // let the un-awaited promise settle
    expect(warn).toHaveBeenCalled();
    const [, payload] = warn.mock.calls[0]!;
    expect(String(payload)).toContain("enc_secret_patient_context");
    expect(String(payload)).toContain("jev_error: Error"); // W27.7(a): class name only; "db unreachable" must NOT appear
    expect(String(payload)).not.toContain("db unreachable");
    warn.mockRestore();
  });

  // ETA-NOTE-SAFETY-SHADOW-REFUTER-VERDICT-23-SEP-2026.md finding 1, Fable's ruling: the test
  // above only ever asserted what SHOULD be present in the log, never what should be ABSENT — a
  // test with that shape stayed green when the Refuter swapped the injected error for one
  // carrying synthetic note text. THIS test asserts absence, the only shape that can actually
  // fail for a leak, against the REAL failure mode: a Jev HTTP error whose body echoes the
  // caller's own input (the ordinary shape of a 400 validation error) — exactly what a note
  // sentence or transcript excerpt sent as Jev state can trigger.
  it("a JevHttpError whose body echoes SYNTHETIC note text does NOT put that text in the logged warning", async () => {
    process.env[ENV] = "on";
    const SYNTHETIC_NOTE_TEXT = "Invented finding: chest pain not mentioned by the patient anywhere.";
    dbResponder = () => [{ id: "enc_1", note_json: { chief_complaint: "Fever." }, transcript_clean: "the transcript" }];
    askJevMock.mockRejectedValueOnce(
      new JevHttpError(400, JSON.stringify({ error: `validation failed: unexpected content "${SYNTHETIC_NOTE_TEXT}"` })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runNoteSafetyShadow("enc_1");
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    const [, payload] = warn.mock.calls[0]!;
    expect(String(payload)).not.toContain(SYNTHETIC_NOTE_TEXT);
    expect(String(payload)).not.toContain("unexpected content");
    expect(String(payload)).toContain("enc_1"); // the encounter id is still there — only the text is gone
    warn.mockRestore();
  });
});
