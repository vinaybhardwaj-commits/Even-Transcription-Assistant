/**
 * Pipe B ingest planning for Stage 4 document audits.
 *
 * Reads Even-CDMSS `GET /api/governance/document-audits-export` (x-api-key).
 * Does not mint `opd_gov_signal`. OT write-mint stays off until a separate Vinay GO;
 * this module only mirrors routed signals the export already contains.
 *
 * Export shape (tolerant of a few aliases):
 * {
 *   ok?: true,
 *   supports?: { ot?: boolean, discharge?: boolean, progress?: boolean },
 *   audits: [{
 *     external_ref?, audit_id?, id?, doc_type, note_class?,
 *     doctor_uid, map_status?, note_date? | note_day? | discharged_at?,
 *     hospital_code?, pdf_url?, pdf_kind?: "audit_findings"|"source_document",
 *     pdf_available?: boolean,
 *     findings: [{ finding_ref?, stable_ref?, subject?, rationale?, verdict?,
 *       importance?, severity?, signal_type?, queue_item_ref?, reference? }]
 *   }],
 *   routed_signals: [{
 *     note_class, doctor_uid, signal_type, queue_item_ref?,
 *     audit_id?, finding_ref?, reference?, routed_at?, status?
 *   }]
 * }
 *
 * Preserved keys: note_class, queue_item_ref = note_class|doctor_uid|signal_type,
 * audit_id, finding_ref, reference EHRC-AUD-YYYY-NNNN.
 */

import { createHash } from "node:crypto";
import { normalizeDocType, normalizeSeverity, type DocType, type FindingSeverity } from "@/lib/document-audits";

export const AUDIT_REF_RE = /^[A-Z]{2,8}-AUD-\d{4}-\d{3,6}$/;

const LIVE_ROUTE = new Set(["routed", "responded", "escalated", "ruled", "closed"]);

export type SkipReason =
  | "ot_not_mapped"
  | "discharge_no_doctor"
  | "progress_unsupported"
  | "progress_no_doctor"
  | "missing_ref"
  | "unknown_doc_type"
  | "opd_not_stage4";

/** Patient context the doctor sees on a card. Every field nullable; never fabricated. */
export interface FindingPatient {
  name: string | null;
  age: string | null;
  sex: string | null;
  ip_number: string | null;
  uhid: string | null;
}

export interface FindingCitation {
  title: string;
  url: string | null;
}

/** The excerpt cap from the shared contract. */
export const EVIDENCE_EXCERPT_MAX = 600;

export interface PlannedFinding {
  finding_ref: string;
  finding_label: string;
  finding_body: string | null;
  severity: FindingSeverity;
  signal_type: string | null;
  queue_item_ref: string | null;
  note_class: string | null;
  signal_reference: string | null;
  recurrence_count: number;
  /** CDMSS `routed`: true/false when the export says, null when it does not (older payloads). */
  routed: boolean | null;
  note_date: string | null;
  evidence_excerpt: string | null;
  citations: FindingCitation[];
  patient: FindingPatient | null;
  /** SHA-256 over every content field above. A changed hash means CDMSS changed the finding. */
  content_hash: string;
}

export interface PlannedAudit {
  external_ref: string;
  doc_type: DocType;
  note_class: string | null;
  doctor_uid: string;
  note_date: string | null;
  hospital_code: string;
  source_audit_id: string | null;
  /** Absolute audit-findings PDF from the export. Never a clinical source PDF. */
  pdf_url: string | null;
  /** CDMSS audit id to HEAD when pdf_url is absent and the export did not say unavailable. */
  pdf_probe_id: string | null;
  findings: PlannedFinding[];
}

export interface ExistingAuditKey {
  external_ref: string;
  finding_refs: ReadonlyArray<string | null>;
  /**
   * finding_ref -> stored content_hash (null for rows written before migration 035). When present,
   * an audit is only "already written" if every planned finding's hash matches too, so a content
   * change in CDMSS is not skipped.
   */
  finding_hashes?: Readonly<Record<string, string | null>> | null;
}

export interface RoutedSignal {
  note_class: string | null;
  doctor_uid: string | null;
  signal_type: string | null;
  queue_item_ref: string | null;
  audit_id: string | null;
  finding_ref: string | null;
  reference: string | null;
  routed_at: string | null;
  status: string | null;
}

export interface IngestPlan {
  ok: true;
  progress_supported: boolean;
  audits: PlannedAudit[];
  signals: RoutedSignal[];
  skips: Array<{ reason: SkipReason; external_ref: string | null }>;
}

export interface IngestPlanError {
  ok: false;
  error: string;
}

export interface LocalFindingKey {
  finding_id: string;
  audit_row_id: string;
  external_ref: string | null;
  source_audit_id: string | null;
  doctor_uid: string | null;
  note_class: string | null;
  finding_ref: string | null;
  queue_item_ref: string | null;
  signal_type: string | null;
  signal_reference: string | null;
  /** CDMSS's own per-finding verdict from the last ingest: false vetoes a signal-key match. */
  cdmss_routed?: boolean | null;
  portal_visible?: boolean;
  response_owner?: string | null;
}

export interface RouteHit {
  finding_id: string;
  audit_row_id: string;
  routed_at: string | null;
  signal_reference: string | null;
  queue_item_ref: string | null;
  note_class: string | null;
  signal_type: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function clip(v: string, n: number): string {
  return v.length <= n ? v : v.slice(0, n);
}

/** Pipe A / Stage 4 note class. Does not coerce unknowns to `opd`. */
export function normalizeRouteNoteClass(raw: unknown): string | null {
  if (raw === "opd" || raw === "discharge_summary" || raw === "ot" || raw === "progress") return raw;
  if (raw === "discharge") return "discharge_summary";
  if (raw === "progress_note") return "progress";
  if (raw === "ot_note") return "ot";
  return null;
}

export function buildQueueItemRef(
  noteClass: string | null,
  doctorUid: string | null,
  signalType: string | null,
): string | null {
  if (!noteClass || !doctorUid || !signalType) return null;
  return `${noteClass}|${doctorUid}|${signalType}`;
}

/** Keep a provided queue_item_ref when it already uses the locked pipe form. */
export function preserveQueueItemRef(raw: unknown): string | null {
  const v = str(raw);
  if (!v || !v.includes("|")) return null;
  const [noteClass, doctorUid, signalType] = v.split("|");
  if (!normalizeRouteNoteClass(noteClass) || !doctorUid || !signalType) return null;
  return clip(v, 400);
}

export function preserveAuditReference(raw: unknown): string | null {
  const v = str(raw);
  if (!v) return null;
  const upper = v.toUpperCase();
  return AUDIT_REF_RE.test(upper) ? upper : null;
}

/**
 * CDMSS verdict / importance / severity → even-elo critical|high|medium|low.
 * An explicit even-elo severity wins. Otherwise importance, then verdict. Else low.
 */
export function mapFindingSeverity(input: {
  severity?: unknown;
  importance?: unknown;
  verdict?: unknown;
}): FindingSeverity {
  const direct = normalizeSeverity(typeof input.severity === "string" ? input.severity.toLowerCase() : input.severity);
  if (direct) return direct;
  const imp = String(input.importance ?? "").trim().toLowerCase();
  if (imp === "critical" || imp === "crit") return "critical";
  if (imp === "high") return "high";
  if (imp === "medium" || imp === "med") return "medium";
  if (imp === "low" || imp === "info" || imp === "informational") return "low";
  const v = String(input.verdict ?? "").trim().toLowerCase();
  if (v.includes("critical")) return "critical";
  if (
    v === "fail" ||
    v === "failed" ||
    v === "deficient" ||
    v === "non_compliant" ||
    v === "non-compliant" ||
    v === "missing"
  ) {
    return "high";
  }
  if (v === "partial" || v === "warn" || v === "warning" || v === "needs_review") return "medium";
  return "low";
}

export function acceptAuditPdfUrl(url: unknown, kind: unknown): string | null {
  if (kind === "source_document" || kind === "clinical") return null;
  const v = str(url);
  if (!v || !/^https?:\/\//i.test(v)) return null;
  return v;
}

function noteDateOf(row: Record<string, unknown>): string | null {
  const raw = str(row.note_date) || str(row.note_day) || str(row.discharged_at);
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function hospitalCodeOf(row: Record<string, unknown>): string {
  const code = str(row.hospital_code) || str(row.site_code);
  if (code) return clip(code.toUpperCase(), 16);
  const uid = str(row.hospital_uid);
  if (uid && /^(EHRC|EHBR|EHBO|EHIN)$/i.test(uid)) return uid.toUpperCase();
  return "UNMAPPED";
}

function progressSupported(root: Record<string, unknown>): boolean {
  const supports = asRecord(root.supports);
  if (supports) return supports.progress === true || supports.progress_notes === true;
  return root.progress_supported === true;
}

function docTypeOf(row: Record<string, unknown>): DocType | "opd" | null {
  const raw = str(row.doc_type);
  if (raw === "opd" || raw === "opd_note") return "opd";
  const note = normalizeRouteNoteClass(row.note_class);
  if (note === "opd") return "opd";
  const fromNote = note === "discharge_summary" ? "discharge" : note === "ot" || note === "progress" ? note : null;
  return normalizeDocType(row.doc_type) ?? fromNote;
}

function externalRefFor(row: Record<string, unknown>, doc: DocType): { ref: string | null; auditId: string | null } {
  const auditId = str(row.audit_id) || str(row.id);
  const explicit = str(row.external_ref);
  if (explicit) return { ref: clip(explicit, 300), auditId };
  const grain = str(row.uid) || str(row.document_id);
  if (doc === "ot" && auditId) return { ref: `ot:${auditId}`, auditId };
  if (doc === "discharge" && auditId) return { ref: `ds:${auditId}`, auditId };
  if (doc === "progress" && auditId) return { ref: `progress:${auditId}`, auditId };
  if (doc === "ot" && grain) return { ref: `ot:${grain}`, auditId };
  if (doc === "discharge" && grain) return { ref: `ds:${grain}`, auditId };
  if (doc === "progress" && grain) return { ref: `progress:${grain}`, auditId };
  return { ref: null, auditId };
}

/**
 * The clinical "why it matters" text. Rationale only: the old fallback to `evidence` put the note
 * excerpt (or, historically, engine text) in the rationale slot. Evidence has its own field now.
 */
function findingBody(row: Record<string, unknown>): string | null {
  const rationale = str(row.rationale) || str(row.finding_body) || str(row.body);
  if (rationale) return clip(rationale, 8000);
  return null;
}

/** Note text that triggered the finding, trimmed to the contract cap. `evidence` is the legacy name. */
export function evidenceExcerptOf(row: Record<string, unknown>): string | null {
  const raw = str(row.evidence_excerpt) || str(row.evidence);
  return raw ? clip(raw, EVIDENCE_EXCERPT_MAX) : null;
}

function scalarText(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const t = str(v);
  return t ? clip(t, max) : null;
}

/** Patient block from the export. Anything that is not an object, or has no usable field, is null. */
export function parsePatient(v: unknown): FindingPatient | null {
  const o = asRecord(v);
  if (!o) return null;
  const patient: FindingPatient = {
    name: scalarText(o.name, 120),
    age: scalarText(o.age, 20),
    sex: scalarText(o.sex, 20),
    ip_number: scalarText(o.ip_number, 40),
    uhid: scalarText(o.uhid, 40),
  };
  return Object.values(patient).some((x) => x !== null) ? patient : null;
}

/** Citations as {title, url|null}. A citation without a title is dropped; a non-http url becomes null. */
export function parseCitations(v: unknown): FindingCitation[] {
  const out: FindingCitation[] = [];
  const seen = new Set<string>();
  for (const item of asArray(v)) {
    const row = typeof item === "string" ? { title: item } : asRecord(item);
    if (!row) continue;
    const title = str(row.title);
    if (!title) continue;
    const rawUrl = str(row.url);
    const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? clip(rawUrl, 1000) : null;
    const key = `${title}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: clip(title, 300), url });
    if (out.length >= 10) break;
  }
  return out;
}

function boolOrNull(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

function dayOrNull(v: unknown): string | null {
  const raw = str(v);
  const m = raw ? raw.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m ? m[1] : null;
}

function planFinding(
  raw: unknown,
  index: number,
  audit: {
    noteClass: string | null;
    doctorUid: string;
    noteDate: string | null;
    patient: FindingPatient | null;
  },
): PlannedFinding {
  const row = asRecord(raw) ?? {};
  const signalType = str(row.signal_type);
  const noteClass = normalizeRouteNoteClass(row.note_class) ?? audit.noteClass;
  const providedRef = str(row.finding_ref) || str(row.stable_ref);
  const subject = str(row.subject) || str(row.finding_label) || str(row.label);
  const findingRef = clip(providedRef || `synth:${signalType || "finding"}:${subject || String(index)}`, 200);
  const recurrenceRaw = Number(row.recurrence_count ?? row.instances ?? 1);
  const recurrence = Number.isFinite(recurrenceRaw) && recurrenceRaw >= 1 ? Math.floor(recurrenceRaw) : 1;
  const planned = {
    finding_ref: findingRef,
    finding_label: clip(subject || "Documentation finding", 500),
    finding_body: findingBody(row),
    severity: mapFindingSeverity({
      severity: row.severity,
      importance: row.importance,
      verdict: row.verdict,
    }),
    signal_type: signalType,
    queue_item_ref:
      preserveQueueItemRef(row.queue_item_ref) ?? buildQueueItemRef(noteClass, audit.doctorUid, signalType),
    note_class: noteClass,
    signal_reference: preserveAuditReference(row.reference) || preserveAuditReference(row.signal_reference),
    recurrence_count: recurrence,
    routed: boolOrNull(row.routed),
    note_date: dayOrNull(row.note_date) ?? audit.noteDate,
    evidence_excerpt: evidenceExcerptOf(row),
    citations: parseCitations(row.citations),
    patient: parsePatient(row.patient) ?? audit.patient,
  };
  return { ...planned, content_hash: findingContentHash(planned) };
}

/** PURE. Stable digest of every content field, so ingest can tell "CDMSS changed this" from "same". */
export function findingContentHash(f: Omit<PlannedFinding, "content_hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        f.finding_label,
        f.finding_body,
        f.severity,
        f.signal_type,
        f.queue_item_ref,
        f.note_class,
        f.signal_reference,
        f.recurrence_count,
        f.routed,
        f.note_date,
        f.evidence_excerpt,
        f.citations,
        f.patient,
      ]),
    )
    .digest("hex");
}

function isLiveRoute(status: unknown): boolean {
  if (status == null || status === "") return true;
  const s = String(status).trim().toLowerCase();
  if (!s) return true;
  return LIVE_ROUTE.has(s);
}

function planSignal(raw: unknown): RoutedSignal | null {
  const row = asRecord(raw);
  if (!row || !isLiveRoute(row.status)) return null;
  const doctorUid = str(row.doctor_uid);
  const signalType = str(row.signal_type);
  const noteClass = normalizeRouteNoteClass(row.note_class);
  const queue =
    preserveQueueItemRef(row.queue_item_ref) ?? buildQueueItemRef(noteClass, doctorUid, signalType);
  const findingRef = str(row.finding_ref);
  const auditId = str(row.audit_id);
  const reference = preserveAuditReference(row.reference) || preserveAuditReference(row.signal_reference);
  if (!doctorUid && !queue && !findingRef && !reference && !auditId) return null;
  const routedAt = str(row.routed_at);
  return {
    note_class: noteClass,
    doctor_uid: doctorUid,
    signal_type: signalType,
    queue_item_ref: queue,
    audit_id: auditId,
    finding_ref: findingRef,
    reference,
    routed_at: routedAt,
    status: str(row.status),
  };
}

function auditList(root: Record<string, unknown>): unknown[] {
  const audits = asArray(root.audits);
  if (audits.length) return audits;
  const rows = asArray(root.rows);
  if (rows.length) return rows;
  return asArray(root.documents);
}

function signalList(root: Record<string, unknown>): unknown[] {
  const routed = asArray(root.routed_signals);
  if (routed.length) return routed;
  const alt = asArray(root.routed);
  if (alt.length) return alt;
  return asArray(root.signals).filter((item) => {
    const row = asRecord(item);
    if (!row) return false;
    return !!(
      str(row.doctor_uid) &&
      (str(row.reference) || str(row.queue_item_ref) || str(row.signal_type) || str(row.finding_ref))
    );
  });
}

export function planDocumentAuditIngest(payload: unknown): IngestPlan | IngestPlanError {
  const root = asRecord(payload);
  if (!root) return { ok: false, error: "export_unreadable" };
  if (root.ok === false) return { ok: false, error: str(root.error) || "export_not_ok" };

  const progressOk = progressSupported(root);
  const audits: PlannedAudit[] = [];
  const skips: IngestPlan["skips"] = [];

  for (const item of auditList(root)) {
    const row = asRecord(item);
    if (!row) {
      skips.push({ reason: "unknown_doc_type", external_ref: null });
      continue;
    }
    const doc = docTypeOf(row);
    const hintedRef = str(row.external_ref);
    if (doc === "opd") {
      skips.push({ reason: "opd_not_stage4", external_ref: hintedRef });
      continue;
    }
    if (!doc) {
      skips.push({ reason: "unknown_doc_type", external_ref: hintedRef });
      continue;
    }
    const { ref, auditId } = externalRefFor(row, doc);
    if (doc === "progress" && !progressOk) {
      skips.push({ reason: "progress_unsupported", external_ref: ref });
      continue;
    }
    const doctorUid = str(row.doctor_uid);
    const mapStatus = str(row.map_status);
    if (doc === "ot" && mapStatus && mapStatus !== "mapped") {
      skips.push({ reason: "ot_not_mapped", external_ref: ref });
      continue;
    }
    if (doc === "ot" && !doctorUid) {
      skips.push({ reason: "ot_not_mapped", external_ref: ref });
      continue;
    }
    if (doc === "discharge" && !doctorUid) {
      skips.push({ reason: "discharge_no_doctor", external_ref: ref });
      continue;
    }
    if (doc === "progress" && !doctorUid) {
      skips.push({ reason: "progress_no_doctor", external_ref: ref });
      continue;
    }
    if (!doctorUid || !ref) {
      skips.push({ reason: "missing_ref", external_ref: ref });
      continue;
    }
    const noteClass =
      normalizeRouteNoteClass(row.note_class) ??
      (doc === "discharge" ? "discharge_summary" : doc);
    const explicitPdf = acceptAuditPdfUrl(row.pdf_url, row.pdf_kind);
    const probeAllowed = row.pdf_available !== false && !explicitPdf;
    const findingsRaw = asArray(row.findings);
    audits.push({
      external_ref: ref,
      doc_type: doc,
      note_class: noteClass,
      doctor_uid: doctorUid,
      note_date: noteDateOf(row),
      hospital_code: hospitalCodeOf(row),
      source_audit_id: auditId,
      pdf_url: explicitPdf,
      pdf_probe_id: probeAllowed ? auditId : null,
      findings: findingsRaw.map((f, i) =>
        planFinding(f, i, {
          noteClass,
          doctorUid,
          noteDate: noteDateOf(row),
          patient: parsePatient(row.patient),
        }),
      ),
    });
  }

  const signals = signalList(root)
    .map(planSignal)
    .filter((s): s is RoutedSignal => s !== null);

  return { ok: true, progress_supported: progressOk, audits, signals, skips };
}

/**
 * A planned audit is already written only when its stable audit key matches, every planned stable
 * finding key is present, AND (when the stored hashes are supplied) every finding's content hash
 * is unchanged. Extra local findings are retained. A changed hash, or a row written before
 * content hashing existed (null hash), is not "already written": it is re-upserted so CDMSS
 * content changes reach the doctor.
 */
export function hasAllPlannedFindings(
  audit: Pick<PlannedAudit, "external_ref" | "findings">,
  existing: ExistingAuditKey | null | undefined,
): boolean {
  if (!existing || existing.external_ref !== audit.external_ref) return false;
  const existingRefs = new Set(existing.finding_refs.filter((ref): ref is string => !!ref));
  if (!audit.findings.every((finding) => existingRefs.has(finding.finding_ref))) return false;
  const hashes = existing.finding_hashes;
  if (!hashes) return true;
  return audit.findings.every((finding) => hashes[finding.finding_ref] === finding.content_hash);
}

/** Probe only when the export has no audit PDF and the local row does not either. */
export function shouldProbeAuditPdf(
  audit: Pick<PlannedAudit, "pdf_url" | "pdf_probe_id">,
  existingPdfUrl: string | null | undefined,
): boolean {
  return !audit.pdf_url && !!audit.pdf_probe_id && !existingPdfUrl;
}

function sameId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b;
}

function doctorOk(findingUid: string | null, signalUid: string | null): boolean {
  if (!findingUid || !signalUid) return true;
  return findingUid === signalUid;
}

/** A routed Pipe A signal matches one local finding. Never matches on doctor alone. */
export function signalMatchesFinding(finding: LocalFindingKey, signal: RoutedSignal): boolean {
  if (!doctorOk(finding.doctor_uid, signal.doctor_uid)) return false;

  const findingRef = finding.finding_ref;
  const signalRef = signal.finding_ref;
  if (findingRef && signalRef && findingRef === signalRef) {
    if (
      signal.audit_id &&
      finding.source_audit_id &&
      signal.audit_id !== finding.source_audit_id &&
      signal.audit_id !== finding.external_ref
    ) {
      return false;
    }
    return true;
  }
  if (findingRef && signalRef && findingRef !== signalRef) return false;

  const fq = finding.queue_item_ref;
  const sq = signal.queue_item_ref;
  if (fq && sq && fq === sq) return true;

  const built = buildQueueItemRef(finding.note_class, finding.doctor_uid, finding.signal_type);
  if (built && sq && built === sq && !findingRef && !signalRef) return true;

  if (
    signal.reference &&
    finding.signal_reference &&
    signal.reference === finding.signal_reference
  ) {
    return true;
  }

  if (
    signal.audit_id &&
    (sameId(signal.audit_id, finding.source_audit_id) || sameId(signal.audit_id, finding.external_ref)) &&
    !findingRef &&
    !signalRef
  ) {
    return true;
  }
  return false;
}

export function matchRoutedFindings(locals: LocalFindingKey[], signals: RoutedSignal[]): RouteHit[] {
  const hits: RouteHit[] = [];
  const seen = new Set<string>();
  for (const finding of locals) {
    // CDMSS's own per-finding verdict wins: a finding it marked not-routed is never opened to the
    // doctor by a signal-key match on its type.
    if (finding.cdmss_routed === false) continue;
    const signal = signals.find((s) => signalMatchesFinding(finding, s));
    if (!signal || seen.has(finding.finding_id)) continue;
    seen.add(finding.finding_id);
    hits.push({
      finding_id: finding.finding_id,
      audit_row_id: finding.audit_row_id,
      routed_at: signal.routed_at,
      signal_reference: signal.reference ?? finding.signal_reference,
      queue_item_ref: signal.queue_item_ref ?? finding.queue_item_ref,
      note_class: signal.note_class ?? finding.note_class,
      signal_type: signal.signal_type ?? finding.signal_type,
    });
  }
  return hits;
}

/** PURE. True when a route hit would change nothing the row already has (skip the write). */
export function isRouteHitCurrent(local: LocalFindingKey | undefined, hit: RouteHit): boolean {
  if (!local) return false;
  return (
    local.portal_visible === true &&
    local.response_owner === "pipe_a" &&
    (hit.signal_reference ?? null) === (local.signal_reference ?? null) &&
    (hit.queue_item_ref ?? null) === (local.queue_item_ref ?? null) &&
    (hit.note_class ?? null) === (local.note_class ?? null) &&
    (hit.signal_type ?? null) === (local.signal_type ?? null)
  );
}

export function countSkips(skips: Array<{ reason: SkipReason }>): Record<SkipReason, number> {
  const base: Record<SkipReason, number> = {
    ot_not_mapped: 0,
    discharge_no_doctor: 0,
    progress_unsupported: 0,
    progress_no_doctor: 0,
    missing_ref: 0,
    unknown_doc_type: 0,
    opd_not_stage4: 0,
  };
  for (const s of skips) base[s.reason] += 1;
  return base;
}

export function formatIngestNote(counts: {
  audits: number;
  findings: number;
  unmapped_doctor: number;
  skips: Record<SkipReason, number>;
  routed: number;
  pdf_stored: number;
  pdf_unavailable: number;
  progress_supported: boolean;
}): string {
  const s = counts.skips;
  return [
    `audits=${counts.audits}`,
    `findings=${counts.findings}`,
    `unmapped_doctor=${counts.unmapped_doctor}`,
    `ot_not_mapped=${s.ot_not_mapped}`,
    `discharge_no_doctor=${s.discharge_no_doctor}`,
    `progress=${counts.progress_supported ? "supported" : "deferred"}`,
    `progress_skipped=${s.progress_unsupported + s.progress_no_doctor}`,
    `routed=${counts.routed}`,
    `pdf_stored=${counts.pdf_stored}`,
    `pdf_unavailable=${counts.pdf_unavailable}`,
  ].join(" ");
}
