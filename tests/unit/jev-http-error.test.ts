/**
 * lib/jev/types.ts's JevHttpError — ETA-NOTE-SAFETY-SHADOW-REFUTER-VERDICT-23-SEP-2026.md finding
 * 1, Fable's ruling: `.message` is status + the provider's own error CODE only, never the raw
 * body — a 400 that echoes the offending input is the ordinary shape of a validation error, and
 * note-safety-shadow.ts is the first caller whose input can be a note sentence or a transcript
 * excerpt.
 */
import { describe, it, expect } from "vitest";
import { JevHttpError } from "@/lib/jev/types";

const SYNTHETIC_NOTE_TEXT = "Invented finding: chest pain not mentioned by the patient anywhere.";

describe("JevHttpError — .message never contains the raw body", () => {
  it("a body that echoes the request's own text does NOT appear in .message, even though it is a plausible provider response shape", () => {
    const body = JSON.stringify({ error: `validation failed: unexpected content "${SYNTHETIC_NOTE_TEXT}"` });
    const e = new JevHttpError(400, body);
    expect(e.message).not.toContain(SYNTHETIC_NOTE_TEXT);
    expect(e.message).not.toContain("unexpected content");
  });

  it("a plain-text (non-JSON) body carrying the same text does not appear in .message either", () => {
    const e = new JevHttpError(400, `Bad request: ${SYNTHETIC_NOTE_TEXT}`);
    expect(e.message).not.toContain(SYNTHETIC_NOTE_TEXT);
  });

  it("a JSON body WITH a `code` field surfaces that code, bounded, and nothing else from the body", () => {
    const e = new JevHttpError(422, JSON.stringify({ code: "invalid_question_shape", detail: SYNTHETIC_NOTE_TEXT }));
    expect(e.message).toBe("jev http 422: invalid_question_shape");
    expect(e.message).not.toContain(SYNTHETIC_NOTE_TEXT);
  });

  it("a JSON body with no `code` field (or a non-string one) falls back to status only", () => {
    expect(new JevHttpError(500, JSON.stringify({ detail: SYNTHETIC_NOTE_TEXT })).message).toBe("jev http 500");
    expect(new JevHttpError(500, JSON.stringify({ code: 12345 })).message).toBe("jev http 500");
  });

  it("an unparseable body falls back to status only, never throwing from inside the error constructor itself", () => {
    expect(() => new JevHttpError(429, "not json at all { broken")).not.toThrow();
    expect(new JevHttpError(429, "not json at all { broken").message).toBe("jev http 429");
  });

  it("a very long code is bounded, not carried in full", () => {
    const longCode = "x".repeat(500);
    const e = new JevHttpError(400, JSON.stringify({ code: longCode }));
    expect(e.message.length).toBeLessThan(100);
  });

  it(".body still carries the raw text — a separate field, not deleted, for a caller that explicitly wants it", () => {
    const body = JSON.stringify({ code: "invalid", detail: SYNTHETIC_NOTE_TEXT });
    const e = new JevHttpError(400, body);
    expect(e.body).toBe(body); // the raw text IS still here — on purpose, just not on .message
  });

  it("the status is always present and correct, for every constructor path", () => {
    expect(new JevHttpError(429, "").status).toBe(429);
    expect(new JevHttpError(429, JSON.stringify({ code: "rate_limited" })).status).toBe(429);
  });
});
