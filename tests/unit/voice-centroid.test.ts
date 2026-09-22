/**
 * voice-centroid.test.ts — migration 0113 and lib/voice-centroid.ts. Unit level: the migration's text,
 * the pure checks, and the SQL each helper sends (db mocked). The real-database proof ran on a Neon
 * test branch (see the build report). All values synthetic.
 */
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db: { calls: Array<{ q: string; vals: unknown[] }>; rows: unknown[] } = { calls: [], rows: [] };
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => {
    db.calls.push({ q: strings.join("?").replace(/\s+/g, " ").trim(), vals });
    return Promise.resolve(db.rows);
  },
}));

import {
  checkCentroidInput,
  isActive,
  isVoiceDomain,
  listActiveCentroids,
  newCentroidId,
  parseEmbedding,
  readActiveCentroid,
  retireCentroid,
  rowToCentroid,
  writeCentroidGeneration,
  type CentroidInput,
} from "@/lib/voice-centroid";

const DOC = "doc_fake0001";
const vec = (n: number, f = (i: number) => (i % 7) - 3 + 0.5) => Array.from({ length: n }, (_, i) => f(i));
const input = (over: Partial<CentroidInput> = {}): CentroidInput => ({
  clinician_id: DOC, domain: "phone", embedding: vec(192), embedding_model: "ecapa-voxceleb", n_samples: 4,
  source: { sessions: 3, seconds: 74.5 }, actor: "operator-v1", ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: "vc_abc", clinician_id: DOC, domain: "phone", generation: 2, embedding: vec(192),
  embedding_model: "ecapa-voxceleb", embedding_dim: 192, n_samples: 4, source: { sessions: 3 },
  created_at: new Date("2026-09-22T16:00:00Z"), retired_at: null, ...over,
});

beforeEach(() => {
  db.calls.length = 0;
  db.rows = [];
});

describe("migration 0113", () => {
  const m = readFileSync("db/migrations/0113_voice_centroid.sql", "utf8");
  const code = m.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("creates the settled table, idempotently", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS voice_centroid/);
    for (const col of [
      /id\s+text PRIMARY KEY/, /clinician_id\s+text NOT NULL/, /domain\s+text NOT NULL/,
      /generation\s+integer NOT NULL DEFAULT 1/, /embedding\s+real\[\] NOT NULL/, /embedding_model text NOT NULL/,
      /embedding_dim\s+integer NOT NULL/, /n_samples\s+integer NOT NULL/, /source\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
      /created_at\s+timestamptz DEFAULT now\(\)/, /retired_at\s+timestamptz/,
    ]) expect(code).toMatch(col);
    expect(code).toMatch(/CHECK \(domain IN \('room_primary', 'phone', 'meet'\)\)/);
    expect(code).toMatch(/UNIQUE \(clinician_id, domain, embedding_model, generation\)/);
    expect(code).toMatch(/retired_by\s+text,\s+retired_reason\s+text,/);
    // A retired row always says who and why (Refuter F2).
    expect(code).toMatch(/CONSTRAINT voice_centroid_retirement_chk CHECK \(\s*retired_at IS NULL OR \(retired_by IS NOT NULL AND retired_reason IS NOT NULL\)\)/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS voice_centroid_active_idx\s+ON voice_centroid \(clinician_id, domain\)\s+WHERE retired_at IS NULL/);
  });

  it("records itself as 113 and touches no other table", () => {
    expect(code).toMatch(/VALUES \(113, '0113_voice_centroid'\)\s+ON CONFLICT DO NOTHING/);
    expect(code).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(code).not.toMatch(/\bGRANT\b/); // app-owned, like 0107 and 0112
  });

  it("113 is the only migration with that number", () => {
    expect(readdirSync("db/migrations").filter((f) => f.startsWith("0113_"))).toEqual(["0113_voice_centroid.sql"]);
  });
});

describe("pure checks", () => {
  it("a good input has no problems", () => {
    expect(checkCentroidInput(input())).toEqual([]);
  });

  it("names every problem", () => {
    expect(checkCentroidInput(input({ clinician_id: "doc x" }))).toEqual(["bad_clinician_id"]);
    expect(checkCentroidInput(input({ domain: "room" as never }))).toEqual(["bad_domain"]);
    expect(checkCentroidInput(input({ embedding: [] }))).toEqual(["empty_embedding"]);
    expect(checkCentroidInput(input({ embedding: [0.1, Number.NaN] }))).toEqual(["non_finite_embedding"]);
    expect(checkCentroidInput(input({ embedding: [0, 0, 0] }))).toEqual(["zero_embedding"]);
    expect(checkCentroidInput(input({ embedding_model: "" }))).toEqual(["bad_embedding_model"]);
    expect(checkCentroidInput(input({ n_samples: 0 }))).toEqual(["bad_n_samples"]);
    expect(checkCentroidInput(input({ n_samples: 1.5 }))).toEqual(["bad_n_samples"]);
    expect(checkCentroidInput(input({ source: [] as never }))).toEqual(["bad_source"]);
    expect(checkCentroidInput(input({ actor: "" }))).toEqual(["bad_actor"]);
    expect(checkCentroidInput(input({ actor: "a b" }))).toEqual(["bad_actor"]);
  });

  it("the domain set is exactly the migration's", () => {
    for (const d of ["room_primary", "phone", "meet"]) expect(isVoiceDomain(d)).toBe(true);
    for (const d of ["room", "tonor", "", null]) expect(isVoiceDomain(d)).toBe(false);
  });

  it("ids are vc_ + 12", () => {
    expect(newCentroidId()).toMatch(/^vc_[a-z0-9]{12}$/);
    expect(newCentroidId()).not.toBe(newCentroidId());
  });

  it("parses a stored real[] as an array or as the text literal, and refuses a wrong length", () => {
    expect(Array.from(parseEmbedding([0.5, -1, 2], 3)!)).toEqual([0.5, -1, 2]);
    expect(Array.from(parseEmbedding("{0.5,-1,2}", 3)!)).toEqual([0.5, -1, 2]);
    expect(parseEmbedding([0.5, -1], 3)).toBeNull();
    expect(parseEmbedding("{0.5,NaN,2}", 3)).toBeNull();
    expect(parseEmbedding(null, 3)).toBeNull();
    expect(parseEmbedding("{}", 0)).toBeNull();
  });

  it("a row whose embedding disagrees with its own dim is unreadable", () => {
    expect(rowToCentroid(row())).toMatchObject({ id: "vc_abc", generation: 2, embedding_dim: 192, retired_at: null });
    expect(rowToCentroid(row({ embedding_dim: 191 }))).toBeNull();
    expect(rowToCentroid(row({ domain: "room" }))).toBeNull();
  });

  it("a stored row carries its retirement provenance, and isActive is retired_at === null", () => {
    const retired = rowToCentroid(row({ retired_at: "2026-09-22T18:00:00Z", retired_by: "operator-v1", retired_reason: "revoked: wrong speaker" }));
    expect(retired).toMatchObject({ retired_by: "operator-v1", retired_reason: "revoked: wrong speaker" });
    expect(isActive(retired)).toBe(false);
    expect(isActive(rowToCentroid(row()))).toBe(true);
    expect(isActive(null)).toBe(false);
  });
});

describe("reads", () => {
  it("readActiveCentroid asks for the active row of one key, newest generation", async () => {
    db.rows = [row()];
    const c = await readActiveCentroid(DOC, "phone", "ecapa-voxceleb");
    expect(c?.id).toBe("vc_abc");
    const q = db.calls[0]!;
    expect(q.q).toMatch(/WHERE clinician_id = \? AND domain = \? AND embedding_model = \? AND retired_at IS NULL ORDER BY generation DESC LIMIT 1/);
    expect(q.vals).toEqual([DOC, "phone", "ecapa-voxceleb"]);
  });

  it("readActiveCentroid refuses a bad key without a query", async () => {
    expect(await readActiveCentroid("doc x", "phone", "m")).toBeNull();
    expect(await readActiveCentroid(DOC, "room" as never, "m")).toBeNull();
    expect(await readActiveCentroid(DOC, "phone", "bad model name")).toBeNull();
    expect(await listActiveCentroids("phone", "bad model name")).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  // --- Refuter F1: the guard against loading a revoked centroid, both halves. ---
  it("listActiveCentroids asks the database for active rows only", async () => {
    await listActiveCentroids("phone", "ecapa-voxceleb");
    expect(db.calls[0]!.q).toMatch(/WHERE domain = \? AND embedding_model = \? AND retired_at IS NULL ORDER BY clinician_id, generation DESC/);
  });

  it("a retired row the database hands back anyway is never loaded (list and read)", async () => {
    const revoked = row({ id: "vc_revoked", retired_at: "2026-09-22T16:00:00Z", retired_by: "operator-v1", retired_reason: "revoked" });
    db.rows = [revoked, row({ id: "vc_two", clinician_id: "doc_fake0002" })];
    expect((await listActiveCentroids("phone", "ecapa-voxceleb")).map((c) => c.id)).toEqual(["vc_two"]);
    db.rows = [revoked];
    expect(await readActiveCentroid(DOC, "phone", "ecapa-voxceleb")).toBeNull();
  });

  it("a revoked newest generation does not let an older one through", async () => {
    // Only active rows are candidates; the revoked gen 3 is dropped, not replaced by gen 2 from the same answer.
    db.rows = [row({ id: "vc_g3", generation: 3, retired_at: "2026-09-22T16:00:00Z", retired_by: "a", retired_reason: "r" }),
      row({ id: "vc_g2", generation: 2 })];
    expect((await listActiveCentroids("phone", "ecapa-voxceleb")).map((c) => c.id)).toEqual(["vc_g2"]);
  });

  it("listActiveCentroids keeps the newest generation per clinician and skips unreadable rows", async () => {
    db.rows = [row({ id: "vc_new", generation: 3 }), row({ id: "vc_old", generation: 2 }),
      row({ id: "vc_bad", clinician_id: "doc_fake0002", embedding_dim: 7 }), row({ id: "vc_two", clinician_id: "doc_fake0002" })];
    const out = await listActiveCentroids("phone", "ecapa-voxceleb");
    expect(out.map((c) => c.id)).toEqual(["vc_new", "vc_two"]);
  });
});

describe("writes", () => {
  it("an invalid input writes nothing", async () => {
    const r = await writeCentroidGeneration(input({ domain: "tonor" as never, n_samples: 0 }));
    expect(r).toEqual({ ok: false, error: "invalid_input", problems: ["bad_domain", "bad_n_samples"] });
    expect(db.calls).toHaveLength(0);
  });

  it("a generation is ONE statement: retire the active row, insert max+1", async () => {
    db.rows = [{ ...row({ generation: 3 }), retired_count: 1 }];
    const r = await writeCentroidGeneration(input());
    expect(r).toMatchObject({ ok: true, retired: 1, centroid: { generation: 3 } });
    expect(db.calls).toHaveLength(1);
    const q = db.calls[0]!.q;
    // retired_at never moves without retired_by and retired_reason (the helper's half of the CHECK).
    expect(q).toMatch(/^WITH retired AS \( UPDATE voice_centroid SET retired_at = now\(\), retired_by = \?, retired_reason = \?/);
    expect(q).toMatch(/AND retired_at IS NULL RETURNING id \), next_gen AS \( SELECT coalesce\(max\(generation\), 0\) \+ 1 AS g/);
    expect(q).toMatch(/INSERT INTO voice_centroid/);
    expect(q).toMatch(/\?::real\[\]/);
    const vals = db.calls[0]!.vals;
    const emb = vals.find((v) => Array.isArray(v)) as number[];
    expect(emb).toHaveLength(192);
    expect(vals).toContain(192); // embedding_dim is the embedding's own length, never a separate claim
    expect(vals).toContain(JSON.stringify({ sessions: 3, seconds: 74.5 }));
    expect(vals[0]).toBe("operator-v1");
    const newId = vals.find((v) => typeof v === "string" && /^vc_[a-z0-9]{12}$/.test(v)) as string;
    expect(vals[1]).toBe(`superseded_by:${newId}`);
  });

  it("an empty answer from the insert is a loud error, not a quiet success", async () => {
    db.rows = [];
    await expect(writeCentroidGeneration(input())).rejects.toThrow(/no readable row/);
  });

  it("retireCentroid records who and why with the timestamp, and retires only an active row", async () => {
    db.rows = [{ id: "vc_abc" }];
    expect(await retireCentroid("vc_abc", { actor: "operator-v1", reason: "revoked: enrolment was another speaker" }))
      .toEqual({ ok: true, retired: true });
    const c = db.calls[0]!;
    expect(c.q).toMatch(/SET retired_at = now\(\), retired_by = \?, retired_reason = \? WHERE id = \? AND retired_at IS NULL/);
    expect(c.vals.slice(0, 2)).toEqual(["operator-v1", "revoked: enrolment was another speaker"]);
    db.rows = [];
    expect(await retireCentroid("vc_abc", { actor: "operator-v1", reason: "again" })).toEqual({ ok: true, retired: false });
  });

  it("retireCentroid refuses without who or why, and sends nothing", async () => {
    expect(await retireCentroid("x; DROP", { actor: "a", reason: "r" })).toEqual({ ok: false, error: "bad_id" });
    expect(await retireCentroid("vc_abc", { actor: "", reason: "r" })).toEqual({ ok: false, error: "bad_actor" });
    expect(await retireCentroid("vc_abc", { actor: "a", reason: "" })).toEqual({ ok: false, error: "bad_reason" });
    expect(await retireCentroid("vc_abc", { actor: "a", reason: "   " })).toEqual({ ok: false, error: "bad_reason" });
    expect(await retireCentroid("vc_abc", { actor: "a", reason: "two\nlines" })).toEqual({ ok: false, error: "bad_reason" });
    expect(db.calls).toHaveLength(0);
  });
});
