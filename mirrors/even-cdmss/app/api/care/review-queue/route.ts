/**
 * GET /api/care/review-queue — Review Mode's worklist (Gold-Label Review-Mode §2). Care-manager gate.
 *
 * Returns the next N findings for ?reviewer= given filters. Priority (§2): disagreement items (only
 * when app_settings review_disagreement_enabled=1 — §4 flag, default OFF) → untriaged current-engine
 * findings balanced across signal_types, newest first. Assignment (§1.7): hash(finding_ref)%100 →
 * 0–19 overlap (all reviewers), 20–99 partitioned across app_settings review_roster (seed ["V","Zaki"]).
 * Findings already labeled by THIS reviewer are excluded server-side (current-state dedup).
 *
 * ⚠️ SQL HONESTY: this sandbox has NO live DB — every query below is INFERRED from the shapes in
 * lib/opd-audit-doctor.ts / lib/opd-triage-store.ts / lib/lab.ts. All reads are fail-safe: any error
 * degrades to an EMPTY queue / no-op, never a 500 or wrong data. Cowork validates each SQL string
 * (listed verbatim in the build report) against the live DB before the pilot.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { OPD_ENGINE_VERSION, stampFindingIdentity, type OpdFinding } from '@/lib/opd-note-audit-core';
import { parseJson } from '@/lib/opd-audit-ui';
import { getSettings } from '@/lib/mini-backfill';
import { fetchPrescriptionUrls } from '@/lib/metabase';
import {
  buildReviewQueue, itemKey, type QueueFinding, type QueueItem,
} from '@/lib/review-queue-core';
import { matchFindings, disagreementsOf, type MatchFinding } from '@/lib/finding-match-core';
import { stripRetiredEvenCitations } from '@/lib/even-ground-core';
import type { Source } from '@/lib/citations-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/** app_settings keys this build owns (all optional; sane fail-safe defaults if absent). */
const REVIEW_KEYS = {
  roster: 'review_roster',
  disagreementEnabled: 'review_disagreement_enabled',
} as const;
const DEFAULT_ROSTER = ['V', 'Zaki'];
/** The night-window student experiment stream (§4/§8) — engine-versioned, matched by prefix. */
const STUDENT_EXPERIMENT_PREFIX = 'student_stream_';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const ISODATE = /^\d{4}-\d{2}-\d{2}$/;
function parseRoster(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_ROSTER;
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      const list = j.map((x) => String(x).trim()).filter(Boolean);
      if (list.length) return list;
    }
  } catch { /* fall through to default */ }
  return DEFAULT_ROSTER;
}

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const reviewer = (sp.get('reviewer') || '').trim().slice(0, 64);
  if (!reviewer) return NextResponse.json({ ok: false, error: 'reviewer required' }, { status: 400 });

  const n = Math.max(1, Math.min(120, Number(sp.get('n')) || 20)); // §3.3: cap 50→120 (navigator working set)
  const queue = sp.get('queue') === 'disagreement' ? 'disagreement' : sp.get('queue') === 'fresh' ? 'fresh' : 'all';
  const signal_type = (sp.get('signal_type') || '').trim() || null;
  // §8 study filter: names the labelling study this queue session belongs to. Absent ⇒ production.
  const study = (sp.get('study') || '').trim().slice(0, 64) || null;
  const domain = (sp.get('domain') || '').trim() || null;
  const doctor_uid = (sp.get('doctor_uid') || '').trim() || null;
  const from = ISODATE.test(sp.get('from') || '') ? sp.get('from') : null;
  const to = ISODATE.test(sp.get('to') || '') ? sp.get('to') : null;

  // Settings (fail-safe): roster seed + disagreement flag (default OFF / absent).
  const settings = await getSettings([REVIEW_KEYS.roster, REVIEW_KEYS.disagreementEnabled]).catch(() => ({} as Record<string, string>));
  const roster = parseRoster(settings[REVIEW_KEYS.roster]);
  const disagreementEnabled = settings[REVIEW_KEYS.disagreementEnabled] === '1';

  // ── read current-engine audits, newest first, bounded ─────────────────────────
  const params: unknown[] = [APP, OPD_ENGINE_VERSION];
  let where = `app_source = $1 AND engine_version = $2 AND excluded_reason IS NULL`;   // Fix C: keep house-account audits out of the review queue
  if (doctor_uid) { params.push(doctor_uid); where += ` AND doctor_uid = $${params.length}`; }
  if (from) { params.push(from); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`; }
  const cap = Math.max(200, Math.min(800, n * 20));

  // Retire display-filter (EVEN-LVC-GROUNDING §6): hide retired assertions' citations. Empty set (the
  // common case) ⇒ no sources SELECTed, byte-identical to today.
  const retiredEvenIds = (await run(`SELECT id FROM even_lvc_assertions WHERE status = 'retired'`, []).catch(() => []))
    .map((r) => String((r as Record<string, unknown>).id));
  const srcCol = retiredEvenIds.length ? ', sources' : '';

  const rows = await run(
    `SELECT id::text AS id, uid, doctor_uid,
            to_char((note_date AT TIME ZONE 'Asia/Kolkata'),'YYYY-MM-DD') AS note_date, findings${srcCol}
     FROM opd_note_audits WHERE ${where}
     ORDER BY note_date DESC NULLS LAST LIMIT ${cap}`, params).catch(() => []);

  const fresh: QueueFinding[] = [];
  // uid → note context for the (flagged) disagreement matcher
  const byUid = new Map<string, { audit_id: string; doctor_uid: string; note_date: string; teacher: (MatchFinding & QueueFinding)[] }>();

  for (const r of rows as Record<string, unknown>[]) {
    const audit_id = String(r.id);
    const uid = r.uid ? String(r.uid) : '';
    const doctor = r.doctor_uid ? String(r.doctor_uid) : '';
    const note_date = String(r.note_date || '');
    let stamped = stampFindingIdentity(parseJson<OpdFinding[]>(r.findings, []));
    if (retiredEvenIds.length) {
      stamped = stripRetiredEvenCitations(stamped, parseJson<Source[]>(r.sources, []), retiredEvenIds).findings;
    }
    for (const f of stamped) {
      if (!f.finding_ref) continue;
      const qf: QueueFinding & MatchFinding = {
        audit_id,
        finding_ref: String(f.finding_ref),
        signal_type: String(f.signal_type || ''),
        domain: String(f.domain || ''),
        subject: String(f.subject || ''),
        rationale: String(f.rationale || ''),
        verdict: String(f.verdict || ''),
        note_date,
        doctor_uid: doctor,
        citation_ids: Array.isArray(f.citation_ids) ? f.citation_ids : [],
        informational: !!f.informational,
        uid: uid || undefined,   // note uid → PDF-context enrichment (§2.1)
      };
      fresh.push(qf);
      if (uid) {
        const slot = byUid.get(uid) || { audit_id, doctor_uid: doctor, note_date, teacher: [] };
        slot.teacher.push(qf);
        byUid.set(uid, slot);
      }
    }
  }

  // ── labeled-by-this-reviewer exclusion (current state) ────────────────────────
  // §8 / PRD §3.2: the exclusion is STUDY-SCOPED — only labels from the same study (or from
  // production, when study is absent) exclude an item from this reviewer's queue.
  const labeledRows = await run(
    `SELECT DISTINCT audit_id::text AS audit_id, finding_ref
     FROM opd_audit_feedback
     WHERE app_source = $1 AND scope = 'finding' AND author = $2 AND finding_ref IS NOT NULL
       AND study IS NOT DISTINCT FROM $3`,
    [APP, reviewer, study]).catch(() => []);
  const labeledKeys = new Set<string>();
  for (const r of labeledRows as Record<string, unknown>[]) {
    labeledKeys.add(itemKey({ audit_id: String(r.audit_id), finding_ref: String(r.finding_ref) }));
  }

  // ── disagreement items (ONLY when the flag is on — §4; fully fail-safe) ────────
  let disagreements: QueueItem[] = [];
  if (disagreementEnabled && queue !== 'fresh' && byUid.size > 0) {
    disagreements = await buildDisagreements(byUid).catch(() => []);
  }

  const items = buildReviewQueue({
    reviewer,
    roster,
    fresh: queue === 'disagreement' ? [] : fresh,
    disagreements: queue === 'fresh' ? [] : disagreements,
    labeledKeys,
    limit: n,
    filters: { signal_type, domain, doctor_uid, from, to },
  });

  // PDF-context enrichment (§2.1): ONE db13 lookup per queue load, on the RETURNED items' distinct
  // uids only (≤ n) — never the 200–800 scanned rows. Fail-safe: any error → prescription_url null
  // on every item (fallback pane), never a 500.
  const pdfUids = Array.from(new Set(items.map((i) => i.uid).filter((u): u is string => !!u)));
  const urlMap = pdfUids.length ? await fetchPrescriptionUrls(pdfUids).catch(() => ({} as Record<string, string>)) : {};
  for (const it of items) it.prescription_url = (it.uid && urlMap[it.uid]) || null;

  const labeled_today = await labeledTodayCount(reviewer);

  return NextResponse.json({
    ok: true,
    engine: OPD_ENGINE_VERSION,
    reviewer,
    roster,
    disagreement_enabled: disagreementEnabled,
    queue,
    count: items.length,
    items,
    stats: { labeled_today },
    advisory: 'Keyboard-first finding triage — every tap is one append-only gold label. Not a clinician performance score.',
  });
}

/** Build the disagreement worklist from the (flag-gated) student stream. INFERRED lab_analyses read;
 *  any failure returns [] so Review Mode silently falls back to the fresh queue. */
async function buildDisagreements(
  byUid: Map<string, { audit_id: string; doctor_uid: string; note_date: string; teacher: (MatchFinding & QueueFinding)[] }>,
): Promise<QueueItem[]> {
  const uids = [...byUid.keys()];
  if (!uids.length) return [];
  // Latest student run per uid across ANY student_stream_* experiment.
  const studentRows = await run(
    `SELECT DISTINCT ON (input_ref) input_ref AS uid, output
     FROM lab_analyses
     WHERE experiment LIKE '${STUDENT_EXPERIMENT_PREFIX}%' AND input_ref = ANY($1)
     ORDER BY input_ref, created_at DESC`, [uids]).catch(() => []);

  const out: QueueItem[] = [];
  for (const r of studentRows as Record<string, unknown>[]) {
    const uid = String(r.uid);
    const slot = byUid.get(uid);
    if (!slot) continue;
    const output = parseJson<{ findings?: unknown }>(r.output, {});
    const studentRaw = Array.isArray(output?.findings) ? (output.findings as Record<string, unknown>[]) : [];
    const student: MatchFinding[] = studentRaw.map((f) => ({
      finding_ref: f.finding_ref == null ? null : String(f.finding_ref),
      signal_type: f.signal_type == null ? null : String(f.signal_type),
      subject: f.subject == null ? null : String(f.subject),
      domain: f.domain == null ? null : String(f.domain),
      verdict: f.verdict == null ? null : String(f.verdict),
    }));
    const dis = disagreementsOf(matchFindings(slot.teacher, student));
    for (const d of dis) {
      const base = (d.teacher ?? d.student) as (MatchFinding & Partial<QueueFinding>) | undefined;
      const finding_ref = base?.finding_ref;
      if (!finding_ref) continue; // no stable key to assign/label → skip (fail-safe, never a wrong label)
      out.push({
        audit_id: slot.audit_id,
        finding_ref: String(finding_ref),
        signal_type: String(base?.signal_type || ''),
        domain: String(base?.domain || ''),
        subject: String(base?.subject || ''),
        rationale: String((base as Partial<QueueFinding>)?.rationale || ''),
        verdict: String(base?.verdict || ''),
        note_date: slot.note_date,
        doctor_uid: slot.doctor_uid,
        informational: false,
        uid,   // disagreement items get uid from their byUid slot key (§2.1)
        queue: 'disagreement',
        disagreement_type: d.type,
        disagreement_reason: d.reason,
      });
    }
  }
  return out;
}

/** Today's (IST) label count for the rail. Fail-safe → 0. Gamification §3.4: `impact` is NOT counted
 *  (it's a second tap on an already-counted finding) so the rail agrees with the team-goal basis. */
async function labeledTodayCount(reviewer: string): Promise<number> {
  // study-filter-exempt (D12): the daily rail counts reviewer ACTIVITY — a study label is work done
  // today and must count toward the goal; filtering it would under-report against the team basis.
  const rows = await run(
    `SELECT count(*)::int AS n FROM opd_audit_feedback
     WHERE app_source = $1 AND author = $2
       AND scope IN ('finding','missed')
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [APP, reviewer]).catch(() => []);
  return Number((rows[0] as Record<string, unknown>)?.n ?? 0) || 0;
}
