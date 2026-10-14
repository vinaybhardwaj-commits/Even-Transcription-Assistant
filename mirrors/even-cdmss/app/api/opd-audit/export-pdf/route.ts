/**
 * GET/POST /api/opd-audit/export-pdf — combined "note + audit" PDF (Navigation & Export PRD §6).
 * Original note pages (or a full-page image) followed by a drawn audit page, via pdf-lib.
 *   - Single:  GET ?id=<auditId>
 *   - Bulk:    GET ?doctor=<uid>[&from=&to=]   (≤50; clear message above the cap)
 *              POST { ids: string[] }          (≤50; honours a client-side filtered set)
 * Node runtime (pdf-lib + external PDF fetch), maxDuration 300, admin-gated (ADMIN_TOKEN or cookie).
 * Reads finished audits only — no engine/scoring/migration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { fetchOpdNoteByUid, fetchDoctorNames } from '@/lib/metabase';
import { rowToOpdCase } from '@/lib/opd-ingest-core';
import { doctorLabel } from '@/lib/opd-audit-ui';
import { displayedBandColumnExists } from '@/lib/opd-audit-store';
import { fetchDoctorAuditRows } from '@/lib/opd-audit-doctor';
import { buildNoteAuditPdf, buildBulkPdf, type AuditPageData, type OriginalDoc, type PdfFinding } from '@/lib/opd-audit-pdf';
import { stripRetiredEvenCitations } from '@/lib/even-ground-core';
import type { Source } from '@/lib/citations-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const APP = process.env.APP_SOURCE || 'standalone';
const BULK_CAP = 50;
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);
const FOOTER = 'Advisory note-level quality proxy — documentation, PDQI-9, appropriateness and prescribing safety as demonstrated in the note. Not an outcomes measure; not a clinician scorecard.';

// S1 deploy-tolerance: displayed_band joins the column list only once 0029 has run.
const auditCols = async () => `id, uid, doctor_uid, note_date, band${(await displayedBandColumnExists().catch(() => false)) ? ', displayed_band' : ''}, note_quality_index,
  score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
  findings, sources, suggestions, engine_version`;
const DOMAINS: { col: string; label: string }[] = [
  { col: 'score_documentation', label: 'Documentation' },
  { col: 'score_note_quality', label: 'Note quality' },
  { col: 'score_appropriateness', label: 'Appropriateness' },
  { col: 'score_prescribing_safety', label: 'Prescribing & safety' },
  { col: 'score_patient_centred', label: 'Continuity' },
];

type RawFinding = { subject?: string; verdict?: string; domain?: string; rationale?: string; source?: string; citation_ids?: number[] };
function parse<T>(v: unknown, fb: T): T {
  if (v == null) return fb;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fb; }
}
function groundOf(f: RawFinding): PdfFinding['ground'] {
  if (f.source === 'deterministic') return 'deterministic';
  return f.citation_ids && f.citation_ids.length > 0 ? 'grounded' : 'reasoning';
}
function fmtDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v || ''));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(v || '');
}
function safeName(s: string): string {
  return (s || 'doctor').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'doctor';
}

/** Fetch the original OPD-note bytes (via db13 prescriptionUrl). null → audit-only PDF downstream. */
async function fetchOriginal(uid: string): Promise<{ original: OriginalDoc; status: string | null }> {
  try {
    if (!uid) return { original: null, status: 'Original note PDF unavailable — audit only.' };
    const noteRow = await fetchOpdNoteByUid(uid).catch(() => null);
    const url = noteRow ? (rowToOpdCase(noteRow).keys.prescriptionUrl ?? null) : null;
    if (!url) return { original: null, status: 'Original note PDF unavailable — audit only.' };
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return { original: null, status: 'Original note PDF could not be fetched — audit only.' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return { original: null, status: 'Original note PDF was empty — audit only.' };
    return { original: { bytes, contentType: res.headers.get('content-type') }, status: null };
  } catch {
    return { original: null, status: 'Original note PDF could not be fetched — audit only.' };
  }
}

function toPageData(row: Record<string, unknown>, doctor: string, specialty: string | null, originalStatus: string | null, retiredEvenIds?: string[]): AuditPageData {
  // Retire display-filter (EVEN-LVC-GROUNDING §6): drop retired even-lvc citation_ids before the
  // grounded/reasoning flag is derived, so a finding grounded ONLY by a retired assertion reads honestly.
  const rawFindings = parse<RawFinding[]>(row.findings, []);
  const usable = retiredEvenIds?.length
    ? stripRetiredEvenCitations(rawFindings, parse<Source[]>(row.sources, []), retiredEvenIds).findings
    : rawFindings;
  const findings = usable.map((f) => ({
    subject: String(f.subject || ''), verdict: String(f.verdict || ''), domain: String(f.domain || ''),
    rationale: String(f.rationale || ''), ground: groundOf(f),
  }));
  const suggestions = parse<{ text?: string }[]>(row.suggestions, []).map((s) => String(s.text || '')).filter(Boolean);
  return {
    uid: String(row.uid || ''), doctor, specialty, noteDate: fmtDate(row.note_date),
    engineVersion: String(row.engine_version || ''), generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    originalStatus,
    // S1 — the PDF shows the DISPLAYED band (raw index beside it, as everywhere).
    band: String(row.displayed_band || row.band || ''), index: n(row.note_quality_index),
    domains: DOMAINS.map((d) => ({ label: d.label, score: row[d.col] == null ? null : n(row[d.col]) })),
    findings, suggestions, footer: FOOTER,
  };
}

async function namesFor(uids: string[]): Promise<Record<string, string>> {
  return fetchDoctorNames(uids).catch(() => ({} as Record<string, string>));
}
async function specialtiesFor(uids: string[]): Promise<Record<string, string>> {
  if (uids.length === 0) return {};
  const rows = await run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE doctor_uid = ANY($1)`, [uids]).catch(() => []);
  const out: Record<string, string> = {};
  for (const r of rows as Record<string, unknown>[]) { if (r.doctor_uid && r.speciality) out[String(r.doctor_uid)] = String(r.speciality); }
  return out;
}

function pdfResponse(bytes: Uint8Array, filename: string): NextResponse {
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

async function buildForRows(rows: Record<string, unknown>[]): Promise<{ data: AuditPageData; original: OriginalDoc }[]> {
  const uids = Array.from(new Set(rows.map((r) => String(r.doctor_uid || '')).filter(Boolean)));
  const [names, specs] = await Promise.all([namesFor(uids), specialtiesFor(uids)]);
  const retiredEvenIds = (await run(`SELECT id FROM even_lvc_assertions WHERE status = 'retired'`, []).catch(() => []))
    .map((r) => String((r as Record<string, unknown>).id));
  const items: { data: AuditPageData; original: OriginalDoc }[] = [];
  for (const row of rows) {
    const du = row.doctor_uid ? String(row.doctor_uid) : null;
    const doctor = (du && names[du]) || doctorLabel(du);
    const specialty = (du && specs[du]) || null;
    const { original, status } = await fetchOriginal(String(row.uid || ''));
    items.push({ data: toPageData(row, doctor, specialty, status, retiredEvenIds), original });
  }
  return items;
}

async function handleSingle(id: string): Promise<NextResponse> {
  const rows = await run(`SELECT ${await auditCols()} FROM opd_note_audits WHERE id = $1 AND app_source = $2 AND excluded_reason IS NULL LIMIT 1`, [id, APP]).catch(() => []);
  const row = rows[0];
  if (!row) return NextResponse.json({ error: 'audit not found' }, { status: 404 });
  const items = await buildForRows([row]);
  const bytes = await buildNoteAuditPdf(items[0].data, items[0].original);
  const fn = `Dr-${safeName(items[0].data.doctor)}-${String(row.uid || '').slice(0, 6)}-note+audit.pdf`;
  return pdfResponse(bytes, fn);
}

async function handleBulk(rows: Record<string, unknown>[], filename: string): Promise<NextResponse> {
  if (rows.length === 0) return NextResponse.json({ error: 'no audits in the selected set' }, { status: 404 });
  if (rows.length > BULK_CAP) {
    return NextResponse.json({ error: `Too many audits (${rows.length}) for one PDF — cap is ${BULK_CAP}. Narrow the date range or selection.` }, { status: 413 });
  }
  const items = await buildForRows(rows);
  const bytes = await buildBulkPdf(items);
  return pdfResponse(bytes, filename);
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  // Review-Mode PDF-context §2.4 / decision 3 — CM access ≡ admin access for patient info (FOR NOW):
  // the care cookie unlocks export-pdf in addition to the admin gate. A proper roles model is owed work.
  if (denied && !(await isAdminUnlocked().catch(() => false)) && !(await isCareUnlocked().catch(() => false))) return denied;

  const sp = req.nextUrl.searchParams;
  const id = (sp.get('id') || '').trim();
  const doctor = (sp.get('doctor') || '').trim();
  const from = (sp.get('from') || '').trim() || null;
  const to = (sp.get('to') || '').trim() || null;

  try {
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
      return await handleSingle(id);
    }
    if (doctor) {
      // fetch one past the cap so we can report "too many" rather than silently truncating
      const rows = await fetchDoctorAuditRows(doctor, from, to, BULK_CAP + 1) as unknown as Record<string, unknown>[];
      const nm = await namesFor([doctor]);
      const range = [from, to].filter(Boolean).join('_') || 'all';
      const fn = `Dr-${safeName(nm[doctor] || doctorLabel(doctor))}-${range}-audits.pdf`;
      return await handleBulk(rows, fn);
    }
    return NextResponse.json({ error: 'provide ?id=, ?doctor=, or POST { ids }' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  // Review-Mode PDF-context §2.4 / decision 3 — CM access ≡ admin access for patient info (FOR NOW):
  // the care cookie unlocks export-pdf in addition to the admin gate. A proper roles model is owed work.
  if (denied && !(await isAdminUnlocked().catch(() => false)) && !(await isCareUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)).filter((s) => /^[0-9a-f-]{36}$/i.test(s)) : [];
  if (ids.length === 0) return NextResponse.json({ error: 'provide a non-empty ids array' }, { status: 400 });
  if (ids.length > BULK_CAP) return NextResponse.json({ error: `Too many audits (${ids.length}) for one PDF — cap is ${BULK_CAP}. Narrow the selection.` }, { status: 413 });

  try {
    const rows = await run(`SELECT ${await auditCols()} FROM opd_note_audits WHERE id = ANY($1) AND app_source = $2 AND excluded_reason IS NULL ORDER BY note_date DESC`, [ids, APP]).catch(() => []);
    return await handleBulk(rows as Record<string, unknown>[], `opd-audits-${rows.length}-notes.pdf`);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
