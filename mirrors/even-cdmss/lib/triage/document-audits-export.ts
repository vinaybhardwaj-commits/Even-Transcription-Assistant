/**
 * lib/triage/document-audits-export.ts — Pipe B document-audit cards (pure).
 *
 * Even-CDMSS read door for Governance ingest. Mapped OT comes from ot_note_audits.
 * Discharge is included only when the treating-doctor hop resolves to one Pulse uid.
 * Progress is included only when a progress audit store exists and can be attributed
 * the same fail-closed way. Unmapped rows are counted and omitted.
 *
 * OT route mint stays off until TRIAGE_BOT_WRITE_CLASSES includes `ot`. This module
 * does not set that flag and does not mint opd_gov_signal. Join keys for a later
 * Route → Pipe B hop are preserved on each finding:
 *   queue_item_ref = note_class|doctor_uid|signal_type
 *   signal_reference = EHRC-AUD-YYYY-NNNN when a routed thread's window covers the note.
 */

import { stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { isAuditRef } from '@/lib/opd-gov-signal-core';
import { actionQueueItemRef } from '@/lib/triage/shadow-schema';
import { landOtAudits, type OtAuditSource } from '@/lib/triage/ot-lander';
import { landDischargeAudits, type DischargeAuditSource, type DischargeHopView } from '@/lib/triage/ds-lander';
import type { NoteClass } from '@/lib/triage/note-class';

export const OT_WRITE_MINT_NOTE =
  'OT route mint stays off until TRIAGE_BOT_WRITE_CLASSES includes ot. This export does not set that flag and does not mint opd_gov_signal.';

export const PROGRESS_TABLE_CANDIDATES = ['progress_note_audits', 'ipd_progress_audits', 'progress_audits'] as const;

export const DOCUMENT_AUDIT_CLASSES = ['ot', 'discharge_summary', 'progress'] as const;
export type DocumentAuditClass = (typeof DOCUMENT_AUDIT_CLASSES)[number];

export type DocType = 'ot' | 'discharge' | 'progress';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 400;
const DEFAULT_WINDOW_DAYS = 120;

export interface ExportQuery {
  from: string;
  to: string;
  doctorUid: string | null;
  noteClass: DocumentAuditClass | null;
}

export function parseExportQuery(
  sp: { get(name: string): string | null },
  now = new Date(),
): { ok: true; value: ExportQuery } | { ok: false; error: string } {
  const noteRaw = (sp.get('note_class') || '').trim();
  if (noteRaw && !(DOCUMENT_AUDIT_CLASSES as readonly string[]).includes(noteRaw)) {
    return { ok: false, error: 'note_class must be ot|discharge_summary|progress' };
  }
  const doctorRaw = (sp.get('doctor_uid') || '').trim();
  if (doctorRaw.length > 80 || /[|\s]/.test(doctorRaw)) {
    return { ok: false, error: 'doctor_uid is not a single uid' };
  }
  const fromRaw = (sp.get('from') || '').trim();
  const toRaw = (sp.get('to') || '').trim();
  let from: string;
  let to: string;
  if (fromRaw || toRaw) {
    if (!DATE_RE.test(fromRaw) || !DATE_RE.test(toRaw)) {
      return { ok: false, error: 'from and to must be YYYY-MM-DD' };
    }
    from = fromRaw;
    to = toRaw;
  } else {
    const days = Number(sp.get('window') || DEFAULT_WINDOW_DAYS);
    if (!Number.isFinite(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      return { ok: false, error: `window must be 1..${MAX_WINDOW_DAYS}` };
    }
    to = now.toISOString().slice(0, 10);
    from = addUtcDays(to, -(Math.floor(days) - 1));
  }
  if (from > to) return { ok: false, error: 'from must be on or before to' };
  if (daySpan(from, to) > MAX_WINDOW_DAYS) {
    return { ok: false, error: `window must be 1..${MAX_WINDOW_DAYS} days` };
  }
  return {
    ok: true,
    value: {
      from,
      to,
      doctorUid: doctorRaw || null,
      noteClass: (noteRaw || null) as DocumentAuditClass | null,
    },
  };
}

function addUtcDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

export interface RoutedSignalRef {
  reference: string;
  note_class: string;
  doctor_uid: string;
  signal_type: string;
  window_from: string | null;
  window_to: string | null;
  created_at: string;
}

export interface ExportFinding {
  finding_ref: string;
  signal_type: string;
  subject: string;
  verdict: string;
  rationale: string;
  domain: string;
  citation_ids: number[];
  /** `note_class|doctor_uid|signal_type`. Null for progress — it is not an Action-queue class. */
  queue_item_ref: string | null;
  /** EHRC-AUD-YYYY-NNNN when a routed thread's window covers this note. */
  signal_reference: string | null;
}

export interface ExportAudit {
  audit_id: string;
  /** Stable ingest key. The audit uuid, which is also the findings-PDF id. */
  external_ref: string;
  finding_ref: string;
  doctor_uid: string;
  note_class: DocumentAuditClass;
  doc_type: DocType;
  note_date: string;
  hospital_uid: string | null;
  findings: ExportFinding[];
  /** Relative findings PDF. Null only when this card has no findings. */
  pdf: string | null;
  /** Distinct EHRC-AUD refs attached above. Empty → staff-only; do not open the portal. */
  routed_refs: string[];
}

export interface ClassCounts {
  exported: number;
  skipped_unmapped: number;
  skipped_no_findings: number;
}

export interface ProgressReport {
  included: boolean;
  table: string | null;
  reason: string | null;
}

export interface DocumentAuditExport {
  ok: true;
  ot_write_mint: 'off' | 'on';
  ot_write_mint_note: string;
  from: string;
  to: string;
  progress: ProgressReport;
  counts: {
    ot: ClassCounts | null;
    discharge: ClassCounts | null;
    progress: ClassCounts | null;
  };
  audits: ExportAudit[];
}

export interface OtExportSource extends OtAuditSource {
  hospital_uid?: string | null;
}

export interface ProgressAuditSource {
  id: string;
  doctor_uid?: string | null;
  map_status?: string | null;
  note_date: string;
  hospital_uid?: string | null;
  findings: unknown;
}

export type ProgressProbe =
  | { status: 'absent' }
  | { status: 'unreadable'; table: string; reason: string }
  | { status: 'rows'; table: string; rows: readonly ProgressAuditSource[] };

export function auditFindingsPdfPath(auditId: string): string {
  return `/api/governance/audits/${encodeURIComponent(auditId)}/pdf`;
}

export function signalReferenceFor(
  signals: readonly RoutedSignalRef[],
  noteClass: string,
  doctorUid: string,
  signalType: string,
  noteDate: string,
): string | null {
  const day = noteDate.slice(0, 10);
  const hits = signals.filter((s) =>
    s.note_class === noteClass
    && s.doctor_uid === doctorUid
    && s.signal_type === signalType
    && isAuditRef(s.reference)
    && windowCovers(s.window_from, s.window_to, day));
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return hits[0].reference;
}

function windowCovers(from: string | null, to: string | null, day: string): boolean {
  if (!day) return false;
  const start = from ? from.slice(0, 10) : '';
  const end = to ? to.slice(0, 10) : '';
  if (!start && !end) return false;
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

/** Same subject→finding stamp the OT/DS landers use, so finding_ref matches the Action queue. */
export function toStampedFindings(raw: unknown): OpdFinding[] {
  const rows = asFindingArray(raw).map(toOpdFinding).filter((f): f is OpdFinding => !!f);
  return stampFindingIdentity(rows).filter((f) => !!f.signal_type && !!f.finding_ref && !f.informational);
}

function asFindingArray(value: unknown): Record<string, unknown>[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row) => row && typeof row === 'object') as Record<string, unknown>[];
}

function toOpdFinding(raw: Record<string, unknown>): OpdFinding | null {
  const subject = String(raw.subject ?? '').trim();
  if (!subject) return null;
  const domain = raw.domain === 'prescribing_safety' ? 'prescribing_safety' : 'appropriateness';
  const citation_ids = Array.isArray(raw.citation_ids)
    ? raw.citation_ids.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  return {
    subject,
    verdict: (String(raw.verdict ?? 'uncertain') || 'uncertain') as OpdFinding['verdict'],
    confidence: Number(raw.confidence) || 0,
    domain,
    rationale: String(raw.rationale ?? ''),
    evidence: [],
    estimates: [],
    citation_ids,
    source: 'llm',
  };
}

interface LandedLike {
  audit_id: string;
  doctor_uid: string;
  note_date: string;
  subject: string;
  rationale: string;
  verdict: string;
  domain: string;
  signal_type: string;
  finding_ref: string;
  citation_ids?: number[];
}

function docTypeOf(noteClass: DocumentAuditClass): DocType {
  if (noteClass === 'discharge_summary') return 'discharge';
  return noteClass;
}

function cardsFromLanded(
  findings: readonly LandedLike[],
  hospitalByAudit: ReadonlyMap<string, string | null>,
  noteClass: 'ot' | 'discharge_summary',
  signals: readonly RoutedSignalRef[],
  doctorUid: string | null,
): ExportAudit[] {
  const byAudit = new Map<string, LandedLike[]>();
  for (const f of findings) {
    if (doctorUid && f.doctor_uid !== doctorUid) continue;
    if (!f.audit_id || !f.doctor_uid || !f.finding_ref || !f.signal_type) continue;
    const list = byAudit.get(f.audit_id) ?? [];
    list.push(f);
    byAudit.set(f.audit_id, list);
  }
  const cards: ExportAudit[] = [];
  for (const [auditId, list] of byAudit) {
    cards.push(cardFor(auditId, noteClass, list[0].doctor_uid, list[0].note_date, hospitalByAudit.get(auditId) ?? null, list, signals, true));
  }
  return cards;
}

function cardFor(
  auditId: string,
  noteClass: DocumentAuditClass,
  doctorUid: string,
  noteDate: string,
  hospitalUid: string | null,
  findings: readonly LandedLike[],
  signals: readonly RoutedSignalRef[],
  join: boolean,
): ExportAudit {
  const queueClass = noteClass === 'progress' ? null : noteClass;
  const exported: ExportFinding[] = findings
    .map((f) => {
      const queue_item_ref = join && queueClass
        ? actionQueueItemRef(doctorUid, f.signal_type, queueClass as NoteClass)
        : null;
      const signal_reference = join && queueClass
        ? signalReferenceFor(signals, queueClass, doctorUid, f.signal_type, noteDate)
        : null;
      return {
        finding_ref: f.finding_ref,
        signal_type: f.signal_type,
        subject: f.subject,
        verdict: f.verdict,
        rationale: f.rationale,
        domain: f.domain,
        citation_ids: (f.citation_ids ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n)),
        queue_item_ref,
        signal_reference,
      };
    })
    .sort((a, b) => a.finding_ref.localeCompare(b.finding_ref) || a.signal_type.localeCompare(b.signal_type));
  const routed = [...new Set(exported.map((f) => f.signal_reference).filter((r): r is string => !!r))];
  return {
    audit_id: auditId,
    external_ref: auditId,
    finding_ref: exported[0]?.finding_ref ?? '',
    doctor_uid: doctorUid,
    note_class: noteClass,
    doc_type: docTypeOf(noteClass),
    note_date: noteDate.slice(0, 10),
    hospital_uid: hospitalUid,
    findings: exported,
    pdf: exported.length ? auditFindingsPdfPath(auditId) : null,
    routed_refs: routed,
  };
}

function countClass(
  rows: readonly { id: string }[],
  cards: readonly ExportAudit[],
  unmappedIds: ReadonlySet<string>,
  otherDoctorIds: ReadonlySet<string>,
): ClassCounts {
  const exported = new Set(cards.map((c) => c.audit_id));
  let skipped_unmapped = 0;
  let skipped_no_findings = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (exported.has(id) || otherDoctorIds.has(id)) continue;
    if (unmappedIds.has(id)) skipped_unmapped += 1;
    else skipped_no_findings += 1;
  }
  return { exported: exported.size, skipped_unmapped, skipped_no_findings };
}

function progressCards(
  rows: readonly ProgressAuditSource[],
  doctorUid: string | null,
): { cards: ExportAudit[]; counts: ClassCounts } {
  const cards: ExportAudit[] = [];
  const unmapped = new Set<string>();
  const considered: { id: string }[] = [];
  for (const row of rows) {
    const id = String(row.id || '').trim();
    if (!id) continue;
    const uid = row.doctor_uid == null ? '' : String(row.doctor_uid).trim();
    if (doctorUid && uid && uid !== doctorUid) continue;
    considered.push({ id });
    const mapStatus = row.map_status == null ? null : String(row.map_status);
    const mapped = mapStatus == null ? !!uid : mapStatus === 'mapped' && !!uid;
    if (!mapped || (doctorUid && uid !== doctorUid)) {
      if (!mapped) unmapped.add(id);
      continue;
    }
    const stamped = toStampedFindings(row.findings);
    if (!stamped.length) continue;
    const landed: LandedLike[] = stamped.map((f) => ({
      audit_id: id,
      doctor_uid: uid,
      note_date: String(row.note_date || '').slice(0, 10),
      subject: f.subject,
      rationale: f.rationale,
      verdict: f.verdict,
      domain: f.domain,
      signal_type: String(f.signal_type),
      finding_ref: String(f.finding_ref),
      citation_ids: f.citation_ids,
    }));
    cards.push(cardFor(
      id,
      'progress',
      uid,
      String(row.note_date || ''),
      row.hospital_uid == null || String(row.hospital_uid).trim() === '' ? null : String(row.hospital_uid),
      landed,
      [],
      false,
    ));
  }
  return { cards, counts: countClass(considered, cards, unmapped, new Set()) };
}

function otherDoctorIds(findings: readonly { audit_id: string; doctor_uid: string }[], doctorUid: string | null): Set<string> {
  const ids = new Set<string>();
  if (!doctorUid) return ids;
  for (const f of findings) {
    if (f.doctor_uid && f.doctor_uid !== doctorUid) ids.add(f.audit_id);
  }
  return ids;
}

export interface ProgressColumnRow { table_name: string; column_name: string }

export type ProgressShape =
  | { status: 'absent' }
  | { status: 'unreadable'; table: string; reason: string }
  | { status: 'readable'; table: string; date: 'note_day' | 'note_date'; hospital: boolean; mapStatus: boolean };

/** First candidate table that exists wins. A store without doctor_uid is not ingested. */
export function interpretProgressColumns(rows: readonly ProgressColumnRow[]): ProgressShape {
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row.table_name || '');
    if (!(PROGRESS_TABLE_CANDIDATES as readonly string[]).includes(table)) continue;
    const cols = byTable.get(table) ?? new Set<string>();
    cols.add(String(row.column_name || ''));
    byTable.set(table, cols);
  }
  for (const table of PROGRESS_TABLE_CANDIDATES) {
    const cols = byTable.get(table);
    if (!cols) continue;
    if (!cols.has('id') || !cols.has('findings') || !cols.has('doctor_uid')) {
      return {
        status: 'unreadable',
        table,
        reason: 'progress store has no fail-closed doctor_uid (or id/findings); not ingested',
      };
    }
    const date = cols.has('note_day') ? 'note_day' : cols.has('note_date') ? 'note_date' : null;
    if (!date) {
      return { status: 'unreadable', table, reason: 'progress store has no note_day or note_date; not ingested' };
    }
    return { status: 'readable', table, date, hospital: cols.has('hospital_uid'), mapStatus: cols.has('map_status') };
  }
  return { status: 'absent' };
}

const ABSENT_PROGRESS: ProgressReport = {
  included: false,
  table: null,
  reason: 'no progress audit store (progress_note_audits, ipd_progress_audits, progress_audits)',
};

export function buildDocumentAuditExport(input: {
  from: string;
  to: string;
  doctorUid?: string | null;
  noteClass?: DocumentAuditClass | null;
  otRows: readonly OtExportSource[];
  dischargeRows: readonly DischargeAuditSource[];
  dischargeHop: DischargeHopView;
  progress: ProgressProbe;
  signals: readonly RoutedSignalRef[];
  otWriteMint: 'off' | 'on';
}): DocumentAuditExport {
  const want = input.noteClass ?? null;
  const doctorUid = input.doctorUid ?? null;
  const readOt = !want || want === 'ot';
  const readDs = !want || want === 'discharge_summary';
  const readPr = !want || want === 'progress';

  let otCounts: ClassCounts | null = null;
  let dsCounts: ClassCounts | null = null;
  let prCounts: ClassCounts | null = null;
  const audits: ExportAudit[] = [];

  if (readOt) {
    const landed = landOtAudits(input.otRows);
    const hospital = new Map<string, string | null>();
    for (const row of input.otRows) {
      const id = String(row.id || '').trim();
      if (!id) continue;
      const uid = row.hospital_uid == null || String(row.hospital_uid).trim() === '' ? null : String(row.hospital_uid);
      hospital.set(id, uid);
    }
    const cards = cardsFromLanded(landed.findings, hospital, 'ot', input.signals, doctorUid);
    const unmapped = new Set(landed.unmapped.map((c) => c.audit_id));
    otCounts = countClass(input.otRows, cards, unmapped, otherDoctorIds(landed.findings, doctorUid));
    audits.push(...cards);
  }

  if (readDs) {
    const landed = landDischargeAudits(input.dischargeRows, input.dischargeHop);
    const cards = cardsFromLanded(landed.findings, new Map(), 'discharge_summary', input.signals, doctorUid);
    const unmapped = new Set(landed.unmapped.map((c) => c.audit_id));
    dsCounts = countClass(input.dischargeRows, cards, unmapped, otherDoctorIds(landed.findings, doctorUid));
    audits.push(...cards);
  }

  let progress: ProgressReport = { included: false, table: null, reason: null };
  if (readPr) {
    if (input.progress.status === 'absent') {
      progress = ABSENT_PROGRESS;
      prCounts = { exported: 0, skipped_unmapped: 0, skipped_no_findings: 0 };
    } else if (input.progress.status === 'unreadable') {
      progress = { included: false, table: input.progress.table, reason: input.progress.reason };
      prCounts = { exported: 0, skipped_unmapped: 0, skipped_no_findings: 0 };
    } else {
      const landed = progressCards(input.progress.rows, doctorUid);
      progress = {
        included: true,
        table: input.progress.table,
        reason: 'ingested from the progress audit store; no Action-queue class, so no EHRC-AUD join',
      };
      prCounts = landed.counts;
      audits.push(...landed.cards);
    }
  }

  audits.sort((a, b) => b.note_date.localeCompare(a.note_date) || a.audit_id.localeCompare(b.audit_id));

  return {
    ok: true,
    ot_write_mint: input.otWriteMint,
    ot_write_mint_note: OT_WRITE_MINT_NOTE,
    from: input.from,
    to: input.to,
    progress,
    counts: { ot: otCounts, discharge: dsCounts, progress: prCounts },
    audits,
  };
}
