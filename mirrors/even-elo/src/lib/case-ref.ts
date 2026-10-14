import { sql } from "./db";

/**
 * Atomic case_ref generator + INSERT.
 *
 * case_ref format: `SG-YYYY-MM-NNNN` (zero-padded sequence within the
 * surgery_date's year+month).
 *
 * Concurrency strategy: chained CTE selects MAX(seq) for the prefix and
 * inserts in a single statement. Two concurrent calls can still both
 * compute the same MAX, in which case the second hits the UNIQUE
 * constraint on `case_ref`. We retry up to 5 times with a tiny jitter.
 *
 * For v1 committee-tool concurrency this is fine (handful of cases per
 * day, never simultaneous from two principals). If concurrency ever
 * spikes, swap to `pg_advisory_xact_lock(hashtext('case_ref_gen'))`
 * inside a `sql.transaction([...])`.
 */

export interface CaseRow {
  id: string;
  vc_id: string;
  case_ref: string;
  patient_name: string | null;
  patient_mrn: string | null;
  surgery_date: string;
  procedure_label: string | null;
  los_days: number | null;
  case_status: "completed" | "cancelled" | "voided";
  source: "continuous" | "catchup_upload";
  entered_by_position: string;
  entered_at: string;
  notes: string | null;
  created_at: string;
}

export interface InsertCaseInput {
  vc_id: string;
  surgery_date: string; // 'YYYY-MM-DD'
  procedure_label?: string | null;
  patient_name?: string | null;
  patient_mrn?: string | null;
  notes?: string | null;
  source: "continuous" | "catchup_upload";
  entered_by_position: string;
}

const MAX_RETRIES = 5;
const UNIQUE_VIOLATION_PATTERN = /(duplicate key|unique constraint|23505)/i;

export async function insertCaseAtomic(input: InsertCaseInput): Promise<CaseRow> {
  // Surgery_date is YYYY-MM-DD. Slice gives "YYYY-MM".
  const yyyymm = input.surgery_date.substring(0, 7);
  if (!/^\d{4}-\d{2}$/.test(yyyymm)) {
    throw new Error(`Invalid surgery_date '${input.surgery_date}', expected YYYY-MM-DD`);
  }
  const prefix = `SG-${yyyymm}`;
  const likePattern = `${prefix}-%`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const rows = (await sql`
        WITH next_seq AS (
          SELECT COALESCE(MAX(CAST(SPLIT_PART(case_ref, '-', 4) AS INTEGER)), 0) + 1 AS s
          FROM surgical_cases
          WHERE case_ref LIKE ${likePattern}
        )
        INSERT INTO surgical_cases (
          vc_id, case_ref, surgery_date, procedure_label,
          patient_name, patient_mrn, notes, source, entered_by_position
        )
        SELECT
          ${input.vc_id}::uuid,
          ${prefix} || '-' || lpad((SELECT s FROM next_seq)::text, 4, '0'),
          ${input.surgery_date}::date,
          ${input.procedure_label ?? null},
          ${input.patient_name ?? null},
          ${input.patient_mrn ?? null},
          ${input.notes ?? null},
          ${input.source},
          ${input.entered_by_position}
        RETURNING *
      `) as CaseRow[];
      return rows[0];
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (UNIQUE_VIOLATION_PATTERN.test(msg)) {
        // Tiny backoff before retry: 8–32ms.
        await new Promise((r) => setTimeout(r, 8 + Math.random() * 24));
        continue;
      }
      throw e;
    }
  }

  throw new Error(
    `case_ref generation collided ${MAX_RETRIES} times — unusual concurrency. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
