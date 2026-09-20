/**
 * tests/unit/voice-enrolment-retention.test.ts — the three enrolment defects (lx survey, 20 Sep).
 *
 * 1. RETENTION. Six of seven live voiceprints keep no audio, so no centroid can ever be recomputed
 *    with a better model. `storeEnrollmentSession` uploads audio but swallows the failure and
 *    stores the sample with a NULL key — an irreversible enrolment, silently.
 * 2. DURATION. The gate is `ok.length < 3`, a COUNT. Three one-second clips enrol as readily as
 *    three good ones; nothing in the repo has ever measured a clip.
 * 3. ATOMICITY. The inserts and the centroid recompute are separate statements, so a crash between
 *    the last insert and the recompute leaves a centroid that does not match its samples.
 *
 * No clinician names, no audio, no PINs. Ids and counts only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { webmDurationMs } from "@/lib/audio-duration";

// ── fixtures: real WebM byte layouts, built here so the tests need no ffmpeg ───────────────────
function vint(n: number): Buffer {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  return Buffer.from([0x40 | (n >> 8), n & 0xff]);
}
function el(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), vint(payload.length), payload]);
}
/** A finalised WebM: EBML header + Segment > Info{TimecodeScale, Duration}. */
export function webmWithDuration(ms: number): Buffer {
  const scale = el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])); // 1_000_000 ns
  const dur = Buffer.alloc(8);
  dur.writeDoubleBE(ms);
  const info = el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([scale, el([0x44, 0x89], dur)]));
  const segment = el([0x18, 0x53, 0x80, 0x67], info);
  const header = el([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x86, 0x81, 0x01]));
  return Buffer.concat([header, segment]);
}

const CLIP = (ms: number) => ({ buf: webmWithDuration(ms), contentType: "audio/webm;codecs=opus" });

// ── the module under test, with its three collaborators mocked ─────────────────────────────────
const H = vi.hoisted(() => ({
  /** Statements actually AWAITED on their own — i.e. executed outside any batch. */
  executed: [] as string[],
  /** Statements passed to `transaction()` as one batch. */
  batched: [] as string[],
  transactions: [] as number[],
  uploads: [] as string[],
  deletes: [] as string[],
  /** Rows the CAS upsert returns: empty means another enrolment moved the count under us. */
  casReturns: [[{ doctor_id: "doc_test" }]] as unknown[][],
  /** Rows the prior-samples SELECT returns — the mock's stand-in for what is already in the table. */
  priorSamples: [] as Array<{ emb: string }>,
  uploadThrows: false,
  txThrows: false,
}));

vi.mock("@/lib/db", () => {
  // The real driver's tagged call BUILDS a query; only awaiting it, or handing it to
  // `transaction()`, runs anything. The mock keeps that distinction, otherwise a statement that
  // was merely assembled for a batch looks identical to one issued on its own.
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      return {
        __text: text,
        then(res: (v: unknown[]) => unknown) {
          H.executed.push(text);
          const rows = /encode\(embedding/i.test(text) ? H.priorSamples : [];
          return Promise.resolve(rows as unknown[]).then(res);
        },
      };
    },
    {
      transaction: (queries: Array<{ __text?: string }>) => {
        H.transactions.push(queries.length);
        for (const q of queries) H.batched.push(q.__text ?? "");
        if (H.txThrows) return Promise.reject(new Error("tx failed"));
        // the sample inserts in this batch have now landed, so a re-read would see them
        const inserted = queries.filter((q) => /INSERT INTO voice_sample/i.test(q.__text ?? "")).length;
        for (let i = 0; i < inserted; i++) H.priorSamples.push({ emb: Buffer.alloc(768).toString("base64") });
        // last statement is the centroid upsert; its RETURNING rows say whether the CAS held
        const cas = H.casReturns.shift() ?? [{ doctor_id: "doc_test" }];
        return Promise.resolve(queries.map((_, i) => (i === queries.length - 1 ? cas : [])));
      },
    },
  );
  return { sql };
});
vi.mock("@/lib/enroll", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runEnroll: async () => ({ ok: true, embeddingBase64: Buffer.alloc(768).toString("base64") }),
  };
});
vi.mock("@/lib/r2", () => ({
  putObjectBytes: async (key: string) => {
    if (H.uploadThrows) throw new Error("r2 down");
    H.uploads.push(key);
  },
  deleteObject: async (key: string) => { H.deletes.push(key); },
}));

async function store(clips: { buf: Buffer; contentType: string }[]) {
  const { storeEnrollmentSession } = await import("@/lib/voice-samples");
  return storeEnrollmentSession({ clinicianId: "doc_test", clips });
}

beforeEach(() => {
  H.executed.length = 0; H.batched.length = 0; H.transactions.length = 0; H.uploads.length = 0;
  H.deletes.length = 0; H.casReturns = [[{ doctor_id: "doc_test" }]]; H.priorSamples = [];
  H.uploadThrows = false; H.txThrows = false;
  vi.resetModules();
});

describe("the duration parser reads a clip's own bytes", () => {
  it("reads a finalised WebM's Duration element", () => {
    expect(webmDurationMs(webmWithDuration(4200))).toEqual({ ms: 4200, basis: "duration_element" });
  });
  it("returns null for anything it cannot parse — never a guess", () => {
    expect(webmDurationMs(Buffer.from("this is not a webm"))).toBeNull();
    expect(webmDurationMs(Buffer.alloc(0))).toBeNull();
  });
});

describe("DEFECT 2 — the gate measures duration, not just a count", () => {
  it("refuses three clips that are too short, though the COUNT is satisfied", async () => {
    const r = await store([CLIP(1000), CLIP(1000), CLIP(1000)]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/short|duration/i);
    expect(H.transactions).toEqual([]); // and nothing was written
  });

  it("refuses a clip whose duration cannot be read at all", async () => {
    const r = await store([
      { buf: Buffer.from("not a webm"), contentType: "audio/webm" },
      CLIP(12000), CLIP(12000),
    ]);
    expect(r.ok).toBe(false);
  });

  it("accepts three clips that clear the floor", async () => {
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    expect((r as { stored: number }).stored).toBe(3);
  });

  it("refuses when the clips clear the per-clip floor but the session total does not", async () => {
    const r = await store([CLIP(3100), CLIP(3100), CLIP(3100)]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/total/i);
  });
});

describe("DEFECT 1 — enrolment audio is retained, or the enrolment does not happen", () => {
  it("stores the audio key and the measured duration on every sample", async () => {
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    expect(H.uploads.length).toBe(3);
    // every sample row carries BOTH the audio key and the measured duration
    const inserts = H.batched.filter((t) => /INSERT INTO voice_sample/i.test(t));
    expect(inserts.length).toBe(3);
    for (const t of inserts) expect(t).toMatch(/audio_r2_key[\s\S]*duration_ms/i);
  });

  it("REFUSES the session when the audio cannot be retained — no silent null key", async () => {
    H.uploadThrows = true;
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/audio|retain|r2/i);
    // and nothing was written: an embedding without its audio is the irreversible row we are ending
    expect(H.transactions).toEqual([]);
  });
});

describe("DEFECT 3 — samples and centroid land together or not at all", () => {
  it("writes every insert and the centroid in ONE transaction", async () => {
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    // 3 sample inserts + 1 centroid upsert, in a single batch
    expect(H.transactions).toEqual([4]);
  });

  it("writes no centroid when the batch fails", async () => {
    H.txThrows = true;
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/write|transaction|atomic/i);
    // the centroid upsert was only ever inside the batch, never issued on its own
    expect(H.batched.join(" ")).toMatch(/INSERT INTO voice_print/i);
    expect(H.executed.join(" ")).not.toMatch(/INSERT INTO voice_print/i);
  });
});

describe("REFUTER 1 — a concurrent enrolment cannot silently lose samples", () => {
  it("guards the centroid write on the sample count it was computed from", async () => {
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    const upsert = H.batched.find((t) => /INSERT INTO voice_print/i.test(t))!;
    // the write states the count it assumes, so a racing enrolment makes it match no row
    expect(upsert).toMatch(/count\(\*\)/i);
  });

  it("retries when the count moved under it, and lands on the second attempt", async () => {
    H.casReturns = [[], [{ doctor_id: "doc_test" }]]; // first CAS loses the race, second holds
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    expect(H.transactions.length).toBeGreaterThan(1);
    // the retry must NOT insert the samples a second time
    const inserts = H.batched.filter((t) => /INSERT INTO voice_sample/i.test(t));
    expect(inserts.length).toBe(3);
  });

  it("gives up by name rather than writing a centroid it cannot vouch for", async () => {
    H.casReturns = [[], [], [], []];
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/concurrent|contention|retr/i);
  });
});

describe("REFUTER 2 — a failed batch leaves no orphaned audio", () => {
  it("deletes every uploaded object when the batch fails", async () => {
    H.txThrows = true;
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(false);
    expect(H.uploads.length).toBe(3);
    expect(H.deletes.sort()).toEqual(H.uploads.sort()); // every byte we put, we took back
  });

  it("keeps the audio when the batch succeeds", async () => {
    const r = await store([CLIP(12000), CLIP(12000), CLIP(12000)]);
    expect(r.ok).toBe(true);
    expect(H.deletes).toEqual([]);
  });
});
