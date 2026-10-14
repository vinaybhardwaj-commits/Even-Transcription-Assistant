/**
 * Pipe B writer. Plans with document-audit-ingest.ts, then upserts.
 * Unmapped doctors are skipped (physicians.cdmss_doctor_uid, or a recorded alias uid). No fuzzy
 * name match here: linking is done by the mapping tool in lib/cdmss-doctor-mapping.ts.
 *
 * Visibility is PER FINDING (F4). A finding reaches a doctor only when CDMSS marks that finding
 * `routed`, a routed signal for that finding's own type matches it, or an RMO releases it. The
 * audit-level triage_routed_at stamp below is informational for staff and grants nothing.
 *
 * Content is refreshed (F5): when CDMSS changes a finding's content the next run rewrites the
 * content columns of the existing row. Doctor-response columns, status and authorship are never
 * touched by ingest.
 */

import { sql } from "@/lib/db";
import { SYSTEM_AUDIT_AUTHOR } from "@/lib/document-audits";
import {
  EXPORT_MARGIN_S,
  PARTIAL_RUN_MARKER,
  exportTimeoutMs,
  isTimeoutError,
  workDeadlineMs,
} from "@/lib/ingest-timing";
import {
  countSkips,
  formatIngestNote,
  hasAllPlannedFindings,
  isRouteHitCurrent,
  matchRoutedFindings,
  planDocumentAuditIngest,
  shouldProbeAuditPdf,
  type ExistingAuditKey,
  type LocalFindingKey,
  type PlannedAudit,
  type RouteHit,
} from "@/lib/document-audit-ingest";

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
const PDF_PROBE_CAP = 8;
const hospitalCache = new Map<string, string | null>();

const EXPORT_PATH = "/api/governance/document-audits-export";
const NOTE_CLASS_PARAMS = new Set(["ot", "discharge_summary", "progress"]);
const DAY_PARAM = /^\d{4}-\d{2}-\d{2}$/;

/** Optional CDMSS export filters. Unset fields keep the export's own defaults. */
export interface DocumentAuditIngestOpts {
  window?: string | number | null;
  note_class?: string | null;
  from?: string | null;
  to?: string | null;
}

function positiveIntDays(raw: string | number | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

function dayParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return DAY_PARAM.test(v) ? v : null;
}

function noteClassParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return NOTE_CLASS_PARAMS.has(v) ? v : null;
}

/** `${BASE}/api/governance/document-audits-export` plus only provided, valid params. */
export function buildDocumentAuditsExportUrl(
  base: string,
  opts: DocumentAuditIngestOpts = {},
): string {
  const root = base.replace(/\/+$/, "");
  const params = new URLSearchParams();
  const windowDays = positiveIntDays(opts.window);
  if (windowDays) params.set("window", windowDays);
  const noteClass = noteClassParam(opts.note_class);
  if (noteClass) params.set("note_class", noteClass);
  const from = dayParam(opts.from);
  if (from) params.set("from", from);
  const to = dayParam(opts.to);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `${root}${EXPORT_PATH}?${qs}` : `${root}${EXPORT_PATH}`;
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface IngestRunResult {
  ok: true;
  audits: number;
  findings: number;
  unmapped_doctor: number;
  routed: number;
  pdf_stored: number;
  pdf_unavailable: number;
  progress_supported: boolean;
  /** True when the run stopped on its time budget: some audits were NOT processed. */
  partial: boolean;
  note: string;
  skips: ReturnType<typeof countSkips>;
}

async function fetchExport(opts: DocumentAuditIngestOpts = {}): Promise<unknown> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const timeoutMs = exportTimeoutMs();
  let res: Response;
  try {
    res = await fetch(buildDocumentAuditsExportUrl(BASE, opts), {
      headers: { "x-api-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      const secs = Math.round(timeoutMs / 1000);
      const note = `${PARTIAL_RUN_MARKER} export_timeout after ${secs}s (limit is maxDuration minus ${EXPORT_MARGIN_S}s); no audits written`;
      console.error(`[document-audit-ingest] ${note}`);
      try {
        await recordIngestMeta(note, false);
      } catch {
        // Meta row may be missing before migration 030; the thrown error still reports the failure.
      }
      throw new Error(`document-audits-export timed out after ${secs}s`);
    }
    throw e;
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS document-audits-export ${res.status}: ${body}`);
  }
  return res.json();
}

async function probeAuditPdf(auditId: string): Promise<string | null> {
  const key = process.env.GOV_API_KEY;
  if (!key || !auditId) return null;
  const url = `${BASE}/api/governance/audits/${encodeURIComponent(auditId)}/pdf`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": key, Range: "bytes=0-0" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!(res.ok || res.status === 206)) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/json")) return null;
    return url;
  } catch {
    return null;
  }
}

export async function recordIngestMeta(note: string, success: boolean): Promise<void> {
  const text = note.slice(0, 800);
  await sql`
    INSERT INTO document_audit_ingest_meta (id, last_attempt_at, last_success_at, note)
    VALUES (1, now(), CASE WHEN ${success} THEN now() ELSE NULL END, ${text})
    ON CONFLICT (id) DO UPDATE SET
      last_attempt_at = now(),
      last_success_at = CASE
        WHEN ${success} THEN now()
        ELSE document_audit_ingest_meta.last_success_at
      END,
      note = ${text},
      updated_at = now()
  `;
}

async function hospitalId(code: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(code)) return cache.get(code) ?? null;
  const rows = (await sql`
    SELECT id::text AS id FROM hospitals WHERE code = ${code} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id ?? null;
  cache.set(code, id);
  return id;
}

async function physicianId(doctorUid: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(doctorUid)) return cache.get(doctorUid) ?? null;
  // Whoever holds the uid directly owns it. Always the first and strongest answer.
  const direct = (await sql`
    SELECT id::text AS id FROM physicians WHERE cdmss_doctor_uid = ${doctorUid} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  let id: string | null = direct[0]?.id ?? null;
  if (!id) {
    // The export may still carry a retired duplicate uid. The mapping tool records an alias only
    // when it is proven (matching name), so it is trusted here, but only when exactly ONE physician
    // holds it: two holders means the alias is ambiguous and the audit stays unmapped rather than
    // landing on the wrong doctor.
    try {
      const viaAlias = (await sql`
        SELECT id::text AS id FROM physicians WHERE ${doctorUid} = ANY(cdmss_alias_uids) LIMIT 2
      `) as unknown as Array<{ id: string }>;
      id = viaAlias.length === 1 ? viaAlias[0].id : null;
    } catch {
      id = null; // migration 036 not applied yet: no alias lookup
    }
  }
  cache.set(doctorUid, id);
  return id;
}

async function upsertAudit(audit: PlannedAudit, pdfUrl: string | null, physician: string): Promise<string> {
  const hospital = await hospitalId(audit.hospital_code, hospitalCache);
  const rows = (await sql`
    INSERT INTO document_audits (
      external_ref, hospital_id, hospital_code, physician_id, doc_type, note_date,
      last_synced_at, cdmss_pdf_url, source, note_class, source_audit_id, doctor_uid
    ) VALUES (
      ${audit.external_ref},
      ${hospital}::uuid,
      ${audit.hospital_code},
      ${physician}::uuid,
      ${audit.doc_type},
      ${audit.note_date},
      now(),
      ${pdfUrl},
      'cdmss',
      ${audit.note_class},
      ${audit.source_audit_id},
      ${audit.doctor_uid}
    )
    ON CONFLICT (external_ref) DO UPDATE SET
      hospital_id = COALESCE(EXCLUDED.hospital_id, document_audits.hospital_id),
      hospital_code = EXCLUDED.hospital_code,
      physician_id = EXCLUDED.physician_id,
      doc_type = EXCLUDED.doc_type,
      note_date = EXCLUDED.note_date,
      last_synced_at = now(),
      cdmss_pdf_url = COALESCE(EXCLUDED.cdmss_pdf_url, document_audits.cdmss_pdf_url),
      note_class = COALESCE(EXCLUDED.note_class, document_audits.note_class),
      source_audit_id = COALESCE(EXCLUDED.source_audit_id, document_audits.source_audit_id),
      doctor_uid = COALESCE(EXCLUDED.doctor_uid, document_audits.doctor_uid)
    RETURNING id::text AS id
  `) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("audit_upsert_failed");
  return id;
}

/**
 * Insert a finding, or refresh its CDMSS-owned content when it already exists.
 *
 * Content columns (label, body, severity, type/refs, note date, evidence, citations, patient,
 * content_hash, the CDMSS routed verdict) follow CDMSS on every run, whoever the author is: an
 * RMO confirming authorship changes authored_by_*, not the clinical content. NOT touched on
 * conflict: status, doctor_response_*, authored_by_*, response_owner.
 *
 * portal_visible: CDMSS routed=true opens the finding; routed=false closes it only if CDMSS had
 * itself routed it before (an RMO release of a never-routed finding is not undone); no verdict
 * (null) leaves it as is.
 */
async function upsertFinding(auditId: string, physician: string, finding: PlannedAudit["findings"][number]): Promise<void> {
  const citations = JSON.stringify(finding.citations);
  const patient = finding.patient ? JSON.stringify(finding.patient) : null;
  await sql`
    INSERT INTO document_audit_findings (
      audit_id, finding_label, finding_body, severity, status,
      authored_by_name, physician_id, recurrence_count, portal_visible,
      finding_ref, queue_item_ref, signal_reference, signal_type, note_class,
      cdmss_routed, note_date, evidence_excerpt, citations_json, patient_json, content_hash
    ) VALUES (
      ${auditId}::uuid,
      ${finding.finding_label},
      ${finding.finding_body},
      ${finding.severity},
      'open',
      ${SYSTEM_AUDIT_AUTHOR},
      ${physician}::uuid,
      ${finding.recurrence_count},
      ${finding.routed === true},
      ${finding.finding_ref},
      ${finding.queue_item_ref},
      ${finding.signal_reference},
      ${finding.signal_type},
      ${finding.note_class},
      ${finding.routed},
      ${finding.note_date}::date,
      ${finding.evidence_excerpt},
      ${citations}::jsonb,
      ${patient}::jsonb,
      ${finding.content_hash}
    )
    ON CONFLICT (audit_id, finding_ref) WHERE finding_ref IS NOT NULL DO UPDATE SET
      finding_label = EXCLUDED.finding_label,
      finding_body = EXCLUDED.finding_body,
      severity = EXCLUDED.severity,
      queue_item_ref = COALESCE(EXCLUDED.queue_item_ref, document_audit_findings.queue_item_ref),
      signal_reference = COALESCE(EXCLUDED.signal_reference, document_audit_findings.signal_reference),
      signal_type = COALESCE(EXCLUDED.signal_type, document_audit_findings.signal_type),
      note_class = COALESCE(EXCLUDED.note_class, document_audit_findings.note_class),
      recurrence_count = GREATEST(document_audit_findings.recurrence_count, EXCLUDED.recurrence_count),
      note_date = EXCLUDED.note_date,
      evidence_excerpt = EXCLUDED.evidence_excerpt,
      citations_json = EXCLUDED.citations_json,
      patient_json = EXCLUDED.patient_json,
      content_hash = EXCLUDED.content_hash,
      portal_visible = CASE
        WHEN EXCLUDED.cdmss_routed IS TRUE THEN true
        WHEN EXCLUDED.cdmss_routed IS FALSE AND document_audit_findings.cdmss_routed IS TRUE THEN false
        ELSE document_audit_findings.portal_visible END,
      cdmss_routed = COALESCE(EXCLUDED.cdmss_routed, document_audit_findings.cdmss_routed),
      updated_at = now()
  `;
}

interface ExistingAuditRow extends ExistingAuditKey {
  audit_row_id: string;
  source_audit_id: string | null;
  last_synced_at: string | null;
  cdmss_pdf_url: string | null;
}

async function loadExistingAuditKeys(audits: PlannedAudit[]): Promise<Map<string, ExistingAuditRow>> {
  const externalRefs = audits.map((audit) => audit.external_ref);
  if (!externalRefs.length) return new Map();
  const rows = (await sql`
    SELECT
      da.id::text AS audit_row_id,
      da.external_ref,
      da.source_audit_id,
      da.last_synced_at::text AS last_synced_at,
      da.cdmss_pdf_url,
      ARRAY(
        SELECT f.finding_ref
        FROM document_audit_findings f
        WHERE f.audit_id = da.id AND f.finding_ref IS NOT NULL
      ) AS finding_refs,
      COALESCE((
        SELECT jsonb_object_agg(f.finding_ref, f.content_hash)
        FROM document_audit_findings f
        WHERE f.audit_id = da.id AND f.finding_ref IS NOT NULL
      ), '{}'::jsonb) AS finding_hashes
    FROM document_audits da
    WHERE da.external_ref = ANY(${externalRefs}::text[])
  `) as unknown as ExistingAuditRow[];
  return new Map(rows.map((row) => [row.external_ref, row]));
}

async function storeExistingAuditPdf(auditRowId: string, pdfUrl: string): Promise<void> {
  await sql`
    UPDATE document_audits
    SET cdmss_pdf_url = COALESCE(cdmss_pdf_url, ${pdfUrl})
    WHERE id = ${auditRowId}::uuid
  `;
}

async function loadLocalKeys(): Promise<LocalFindingKey[]> {
  const rows = (await sql`
    SELECT
      f.id::text AS finding_id,
      da.id::text AS audit_row_id,
      da.external_ref,
      da.source_audit_id,
      da.doctor_uid,
      COALESCE(f.note_class, da.note_class) AS note_class,
      f.finding_ref,
      f.queue_item_ref,
      f.signal_type,
      f.signal_reference,
      f.cdmss_routed,
      f.portal_visible,
      f.response_owner
    FROM document_audit_findings f
    JOIN document_audits da ON da.id = f.audit_id
  `) as unknown as LocalFindingKey[];
  return rows;
}

async function applyRouteHit(hit: RouteHit): Promise<void> {
  await sql`
    UPDATE document_audit_findings SET
      portal_visible = true,
      response_owner = 'pipe_a',
      signal_reference = COALESCE(${hit.signal_reference}, signal_reference),
      queue_item_ref = COALESCE(${hit.queue_item_ref}, queue_item_ref),
      note_class = COALESCE(${hit.note_class}, note_class),
      signal_type = COALESCE(${hit.signal_type}, signal_type),
      updated_at = now()
    WHERE id = ${hit.finding_id}::uuid
  `;
  const routedAt = isoOrNull(hit.routed_at);
  await sql`
    UPDATE document_audits SET
      triage_routed_at = COALESCE(triage_routed_at, ${routedAt}::timestamptz, now())
    WHERE id = ${hit.audit_row_id}::uuid
  `;
}

export async function runDocumentAuditIngest(
  opts: DocumentAuditIngestOpts = {},
): Promise<IngestRunResult> {
  const startedAt = Date.now();
  const deadline = workDeadlineMs(startedAt);
  hospitalCache.clear();
  const payload = await fetchExport(opts);
  const plan = planDocumentAuditIngest(payload);
  if (!plan.ok) throw new Error(plan.error);

  const physicianCache = new Map<string, string | null>();
  let audits = 0;
  let findings = 0;
  let unmapped = 0;
  let pdfStored = 0;
  let pdfUnavailable = 0;
  let probes = 0;
  let processed = 0;
  let partial = false;

  const existingAudits = await loadExistingAuditKeys(plan.audits);
  for (const audit of plan.audits) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    processed += 1;
    const existing = existingAudits.get(audit.external_ref);
    // Skip only when every planned finding exists AND its stored content hash is unchanged (F5).
    if (hasAllPlannedFindings(audit, existing)) {
      if (!existing?.cdmss_pdf_url) {
        let pdf = audit.pdf_url;
        if (shouldProbeAuditPdf(audit, existing?.cdmss_pdf_url) && probes < PDF_PROBE_CAP) {
          probes += 1;
          pdf = await probeAuditPdf(audit.pdf_probe_id!);
        }
        if (pdf && existing) {
          await storeExistingAuditPdf(existing.audit_row_id, pdf);
          pdfStored += 1;
        } else {
          pdfUnavailable += 1;
        }
      }
      continue;
    }

    const physician = await physicianId(audit.doctor_uid, physicianCache);
    if (!physician) {
      unmapped += 1;
      continue;
    }
    let pdf = audit.pdf_url ?? existing?.cdmss_pdf_url ?? null;
    if (shouldProbeAuditPdf(audit, existing?.cdmss_pdf_url) && probes < PDF_PROBE_CAP) {
      probes += 1;
      pdf = await probeAuditPdf(audit.pdf_probe_id!);
    }
    if (pdf) pdfStored += 1;
    else pdfUnavailable += 1;
    const auditId = await upsertAudit(audit, pdf, physician);
    audits += 1;
    for (const finding of audit.findings) {
      await upsertFinding(auditId, physician, finding);
      findings += 1;
    }
  }

  // Route matching (per finding). Only rows whose routing state would actually change are written.
  const locals = await loadLocalKeys();
  const localById = new Map(locals.map((l) => [l.finding_id, l]));
  const hits = matchRoutedFindings(locals, plan.signals);
  for (const hit of hits) {
    if (isRouteHitCurrent(localById.get(hit.finding_id), hit)) continue;
    await applyRouteHit(hit);
  }

  const skips = countSkips(plan.skips);
  const baseNote = formatIngestNote({
    audits,
    findings,
    unmapped_doctor: unmapped,
    skips,
    routed: hits.length,
    pdf_stored: pdfStored,
    pdf_unavailable: pdfUnavailable,
    progress_supported: plan.progress_supported,
  });
  const note = partial
    ? `${PARTIAL_RUN_MARKER} time_budget processed=${processed}/${plan.audits.length} audits; ${baseNote}`
    : baseNote;
  if (partial) console.error(`[document-audit-ingest] ${note}`);
  // A partial run is recorded as an attempt, not a success: freshness must not read as current.
  await recordIngestMeta(note, !partial);
  return {
    ok: true,
    audits,
    findings,
    unmapped_doctor: unmapped,
    routed: hits.length,
    pdf_stored: pdfStored,
    pdf_unavailable: pdfUnavailable,
    progress_supported: plan.progress_supported,
    partial,
    note,
    skips,
  };
}
