/**
 * lib/voice-centroid.ts — read and write voice_centroid (migration 0113, plan §D).
 *
 * One ACTIVE centroid per (clinician_id, domain, embedding_model); a rebuild is a new GENERATION that
 * retires the previous one. Nothing is deleted or rewritten, so any match made yesterday can be
 * replayed against the centroid that made it.
 *
 * THE ONE-ACTIVE RULE LIVES HERE, IN ONE STATEMENT. `writeCentroidGeneration` retires the active
 * row and inserts max(generation)+1 in a single SQL statement, so there is no moment with two active
 * rows or none. Two writers racing on the same key both compute the same next generation; the
 * UNIQUE (clinician_id, domain, embedding_model, generation) constraint rejects the second, and its
 * whole statement (the retire included) rolls back. The loser fails loudly; nothing forks.
 *
 * RETIREMENT CARRIES WHO AND WHY. Every retire path sets retired_by and retired_reason with
 * retired_at (the migration's voice_centroid_retirement_chk refuses one without the others): a
 * superseded row gets the writer's actor and `superseded_by:<new id>`; a revocation names its reason.
 *
 * TWO GUARDS AGAINST LOADING A RETIRED CENTROID. The readers ask for `retired_at IS NULL`, and they
 * also drop any row that comes back with retired_at set, so a regressed clause cannot hand a
 * revoked print to the matcher (Refuter F1, 22 Sep).
 *
 * No routes call this yet. Biometric data: callers must never log an embedding.
 */
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";

export const VOICE_DOMAINS = ["room_primary", "phone", "meet"] as const;
export type VoiceDomain = (typeof VOICE_DOMAINS)[number];

export type VoiceCentroid = {
  id: string;
  clinician_id: string;
  domain: VoiceDomain;
  generation: number;
  embedding: Float32Array;
  embedding_model: string;
  embedding_dim: number;
  n_samples: number;
  source: Record<string, unknown>;
  created_at: string | null;
  retired_at: string | null;
  retired_by: string | null;
  retired_reason: string | null;
};

export type CentroidInput = {
  clinician_id: string;
  domain: VoiceDomain;
  embedding: ArrayLike<number>;
  embedding_model: string;
  n_samples: number;
  /** Provenance: ids, counts, seconds. Never transcript text, never audio. */
  source?: Record<string, unknown>;
  /** Who is writing. Recorded as retired_by on the generation this one supersedes. */
  actor: string;
};

export type InputProblem =
  | "bad_clinician_id"
  | "bad_domain"
  | "empty_embedding"
  | "non_finite_embedding"
  | "zero_embedding"
  | "bad_embedding_model"
  | "bad_n_samples"
  | "bad_source"
  | "bad_actor";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR_RE = /^[A-Za-z0-9._:@-]{1,64}$/;
/** A revocation reason: one line, 1–200 characters. It is provenance, not a note: no free text blocks. */
const REASON_RE = /^[^\n\r]{1,200}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const nano = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 12);

export const newCentroidId = (): string => `vc_${nano()}`;

export const isVoiceDomain = (v: unknown): v is VoiceDomain =>
  typeof v === "string" && (VOICE_DOMAINS as readonly string[]).includes(v);

/** PURE — every problem with an input, empty when it may be written. */
export function checkCentroidInput(input: CentroidInput): InputProblem[] {
  const out: InputProblem[] = [];
  if (typeof input.clinician_id !== "string" || !ID_RE.test(input.clinician_id)) out.push("bad_clinician_id");
  if (!isVoiceDomain(input.domain)) out.push("bad_domain");
  const e = input.embedding;
  if (!e || typeof e.length !== "number" || e.length === 0) out.push("empty_embedding");
  else {
    let finite = true, nonzero = false;
    for (let i = 0; i < e.length; i++) {
      const v = e[i];
      if (typeof v !== "number" || !Number.isFinite(v)) { finite = false; break; }
      if (v !== 0) nonzero = true;
    }
    if (!finite) out.push("non_finite_embedding");
    else if (!nonzero) out.push("zero_embedding"); // no direction: every cosine against it is undefined
  }
  if (typeof input.embedding_model !== "string" || !MODEL_RE.test(input.embedding_model)) out.push("bad_embedding_model");
  if (!Number.isInteger(input.n_samples) || input.n_samples < 1) out.push("bad_n_samples");
  const s = input.source;
  if (s !== undefined && (s === null || typeof s !== "object" || Array.isArray(s))) out.push("bad_source");
  if (typeof input.actor !== "string" || !ACTOR_RE.test(input.actor)) out.push("bad_actor");
  return out;
}

/** PURE — a stored real[] (the driver returns number[] or the Postgres text literal) as Float32Array. */
export function parseEmbedding(raw: unknown, dim: number): Float32Array | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && /^\{.*\}$/s.test(raw.trim())) {
    const body = raw.trim().slice(1, -1).trim();
    arr = body === "" ? [] : body.split(",");
  }
  if (!arr || arr.length === 0 || arr.length !== dim) return null;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const n = typeof arr[i] === "number" ? (arr[i] as number) : Number(String(arr[i]).trim());
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" && v ? new Date(v).toISOString() : null;

type Row = Record<string, unknown>;

/** PURE — one stored row, or null for a row whose embedding does not match its own dimension. */
export function rowToCentroid(r: Row): VoiceCentroid | null {
  const dim = Number(r.embedding_dim);
  if (!Number.isInteger(dim) || dim < 1 || !isVoiceDomain(r.domain)) return null;
  const embedding = parseEmbedding(r.embedding, dim);
  if (!embedding) return null;
  const src = r.source;
  return {
    id: String(r.id),
    clinician_id: String(r.clinician_id),
    domain: r.domain,
    generation: Number(r.generation),
    embedding,
    embedding_model: String(r.embedding_model),
    embedding_dim: dim,
    n_samples: Number(r.n_samples),
    source: src && typeof src === "object" && !Array.isArray(src) ? (src as Record<string, unknown>) : {},
    created_at: iso(r.created_at),
    retired_at: iso(r.retired_at),
    retired_by: typeof r.retired_by === "string" ? r.retired_by : null,
    retired_reason: typeof r.retired_reason === "string" ? r.retired_reason : null,
  };
}

/** PURE — the JS half of the active-only guard: a stored row the matcher may load. */
export const isActive = (c: VoiceCentroid | null): c is VoiceCentroid => c !== null && c.retired_at === null;

/** The active centroid for one clinician, domain and model, or null. */
export async function readActiveCentroid(
  clinicianId: string, domain: VoiceDomain, embeddingModel: string,
): Promise<VoiceCentroid | null> {
  if (!ID_RE.test(clinicianId) || !isVoiceDomain(domain) || !MODEL_RE.test(embeddingModel)) return null;
  const rows = (await sql`
    SELECT id, clinician_id, domain, generation, embedding, embedding_model, embedding_dim, n_samples,
           source, created_at, retired_at, retired_by, retired_reason
      FROM voice_centroid
     WHERE clinician_id = ${clinicianId} AND domain = ${domain} AND embedding_model = ${embeddingModel}
       AND retired_at IS NULL
     ORDER BY generation DESC
     LIMIT 1
  `) as Row[];
  const c = rows[0] ? rowToCentroid(rows[0]) : null;
  return isActive(c) ? c : null;
}

/** Every active centroid in one domain for one model — what a matcher loads. Unreadable rows are skipped. */
export async function listActiveCentroids(domain: VoiceDomain, embeddingModel: string): Promise<VoiceCentroid[]> {
  if (!isVoiceDomain(domain) || !MODEL_RE.test(embeddingModel)) return [];
  const rows = (await sql`
    SELECT id, clinician_id, domain, generation, embedding, embedding_model, embedding_dim, n_samples,
           source, created_at, retired_at, retired_by, retired_reason
      FROM voice_centroid
     WHERE domain = ${domain} AND embedding_model = ${embeddingModel} AND retired_at IS NULL
     ORDER BY clinician_id, generation DESC
  `) as Row[];
  const out: VoiceCentroid[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const c = rowToCentroid(r);
    // A retired row is never loaded, whatever the SQL returned. If two active rows ever exist for
    // one clinician, the newest generation wins.
    if (isActive(c) && !seen.has(c.clinician_id)) { seen.add(c.clinician_id); out.push(c); }
  }
  return out;
}

export type WriteResult =
  | { ok: true; centroid: VoiceCentroid; retired: number }
  | { ok: false; error: "invalid_input"; problems: InputProblem[] };

/**
 * Write a new generation: retire the active row (if any) and insert max(generation)+1, in ONE
 * statement. A concurrent writer for the same key loses on the unique constraint and throws.
 */
export async function writeCentroidGeneration(input: CentroidInput): Promise<WriteResult> {
  const problems = checkCentroidInput(input);
  if (problems.length) return { ok: false, error: "invalid_input", problems };
  const id = newCentroidId();
  const embedding = Array.from(input.embedding, (v) => Math.fround(v));
  const source = JSON.stringify(input.source ?? {});
  const rows = (await sql`
    WITH retired AS (
      UPDATE voice_centroid
         SET retired_at = now(), retired_by = ${input.actor}, retired_reason = ${"superseded_by:" + id}
       WHERE clinician_id = ${input.clinician_id} AND domain = ${input.domain}
         AND embedding_model = ${input.embedding_model} AND retired_at IS NULL
      RETURNING id
    ), next_gen AS (
      SELECT coalesce(max(generation), 0) + 1 AS g
        FROM voice_centroid
       WHERE clinician_id = ${input.clinician_id} AND domain = ${input.domain}
         AND embedding_model = ${input.embedding_model}
    )
    INSERT INTO voice_centroid
      (id, clinician_id, domain, generation, embedding, embedding_model, embedding_dim, n_samples, source)
    SELECT ${id}, ${input.clinician_id}, ${input.domain}, next_gen.g, ${embedding}::real[],
           ${input.embedding_model}, ${embedding.length}, ${input.n_samples}, ${source}::jsonb
      FROM next_gen
    RETURNING id, clinician_id, domain, generation, embedding, embedding_model, embedding_dim, n_samples,
              source, created_at, retired_at, retired_by, retired_reason,
              (SELECT count(*) FROM retired)::int AS retired_count
  `) as Row[];
  const row = rows[0];
  const centroid = row ? rowToCentroid(row) : null;
  if (!centroid) throw new Error("voice_centroid insert returned no readable row");
  return { ok: true, centroid, retired: Number(row!.retired_count ?? 0) };
}

export type RetireResult =
  | { ok: true; retired: boolean }
  | { ok: false; error: "bad_id" | "bad_actor" | "bad_reason" };

/**
 * Retire (revoke) one centroid by id without replacing it, recording who and why. `retired: false`
 * means there was no ACTIVE row with that id: already retired, or absent. An existing retirement's
 * provenance is never overwritten.
 */
export async function retireCentroid(id: string, by: { actor: string; reason: string }): Promise<RetireResult> {
  if (!/^vc_[a-z0-9]{1,32}$/.test(id)) return { ok: false, error: "bad_id" };
  if (typeof by?.actor !== "string" || !ACTOR_RE.test(by.actor)) return { ok: false, error: "bad_actor" };
  if (typeof by?.reason !== "string" || !REASON_RE.test(by.reason) || !by.reason.trim()) return { ok: false, error: "bad_reason" };
  const rows = (await sql`
    UPDATE voice_centroid
       SET retired_at = now(), retired_by = ${by.actor}, retired_reason = ${by.reason.trim()}
     WHERE id = ${id} AND retired_at IS NULL
    RETURNING id
  `) as Row[];
  return { ok: true, retired: rows.length === 1 };
}
