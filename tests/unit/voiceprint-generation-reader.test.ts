/**
 * tests/unit/voiceprint-generation-reader.test.ts — versioning needed a reader, not a migration.
 *
 * Migration 0108 `voice_print_generation` has been live in production since 19 Sep with 7 rows and
 * nothing has ever read it: the matcher still loads the flat `voice_print` row. This is the reader,
 * and it is OFF by default because changing which table the matcher trusts changes identity itself.
 *
 * Ids only. No names, no audio, no transcript text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  queries: [] as string[],
  prints: [] as Array<{ clinician_id: string; full_name: string | null; centroid_base64: string | null }>,
  generations: [] as Array<{ clinician_id: string; generation: number; origin: string; centroid_base64: string | null }>,
}));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    H.queries.push(text);
    if (/FROM voice_print_generation/i.test(text)) return Promise.resolve(H.generations);
    if (/FROM voice_print\b/i.test(text)) return Promise.resolve(H.prints);
    return Promise.resolve([]);
  },
}));

const PRINT_B64 = Buffer.alloc(768, 1).toString("base64");
const GEN_B64 = Buffer.alloc(768, 2).toString("base64");

async function load(flag: string | undefined) {
  if (flag === undefined) delete process.env.VOICEPRINT_GENERATION_READER;
  else process.env.VOICEPRINT_GENERATION_READER = flag;
  vi.resetModules();
  const { loadClinicianCentroids } = await import("@/lib/stt/diarize-window");
  return loadClinicianCentroids();
}

beforeEach(() => {
  H.queries.length = 0;
  H.prints = [
    { clinician_id: "doc_a", full_name: null, centroid_base64: PRINT_B64 },
    { clinician_id: "doc_b", full_name: null, centroid_base64: PRINT_B64 },
  ];
  H.generations = [{ clinician_id: "doc_a", generation: 2, origin: "room_audio", centroid_base64: GEN_B64 }];
});

describe("the flag decides which table the matcher trusts", () => {
  it("is OFF by default: the generation table is not even queried", async () => {
    const out = await load(undefined);
    expect(H.queries.join(" ")).not.toMatch(/voice_print_generation/i);
    expect(out.map((c) => c.centroid_base64)).toEqual([PRINT_B64, PRINT_B64]);
  });

  it("stays off for an explicit falsy value", async () => {
    await load("0");
    expect(H.queries.join(" ")).not.toMatch(/voice_print_generation/i);
  });

  it("refuses to guess at an unrecognised value", async () => {
    await expect(load("maybe")).rejects.toThrow();
  });
});

describe("with the flag on, the newest generation wins — per clinician", () => {
  it("prefers the newest generation where one exists", async () => {
    const out = await load("1");
    const a = out.find((c) => c.clinician_id === "doc_a")!;
    expect(a.centroid_base64).toBe(GEN_B64);
  });

  it("leaves a clinician with no generation row on their existing print", async () => {
    const out = await load("1");
    const b = out.find((c) => c.clinician_id === "doc_b")!;
    expect(b.centroid_base64).toBe(PRINT_B64);
    // turning this on can ADD versioned reads; it must never drop a clinician from matching
    expect(out.length).toBe(2);
  });

  it("takes the highest generation, not the first row", async () => {
    H.generations = [
      { clinician_id: "doc_a", generation: 3, origin: "room_audio", centroid_base64: GEN_B64 },
    ];
    const out = await load("1");
    expect(out.find((c) => c.clinician_id === "doc_a")!.centroid_base64).toBe(GEN_B64);
    expect(H.queries.join(" ")).toMatch(/ORDER BY[\s\S]*generation DESC/i);
  });

  it("ignores a generation row whose centroid is missing", async () => {
    H.generations = [{ clinician_id: "doc_a", generation: 2, origin: "room_audio", centroid_base64: null }];
    const out = await load("1");
    expect(out.find((c) => c.clinician_id === "doc_a")!.centroid_base64).toBe(PRINT_B64);
  });
});
