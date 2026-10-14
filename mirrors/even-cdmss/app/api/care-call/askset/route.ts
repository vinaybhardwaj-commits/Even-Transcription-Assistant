export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { metabaseQuery } from '@/lib/metabase';
import { prescriptionSql } from '@/lib/ccb-fetch-core';
import { rowToOpdCase, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { buildAskSet, type AskKeys } from '@/lib/care-call-core';
import { nextAttempt, priorAttempts } from '@/lib/care-call-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { withTrace, governedChat } from '@/lib/trace';
import { GEMINI_FLASH_MODEL, TEXT_MODEL } from '@/lib/llm';
import { individualUidForPresc, getMemberSnapshot } from '@/lib/member-state/member-state';
import { deriveUnknowns, type UnknownItem } from '@/lib/inquiry/unknowns-core';
import { runInquirySelection, INQUIRY_VERSION, type InquiryAskSet } from '@/lib/inquiry/inquiry-core';
import { saveServedAskSet } from '@/lib/inquiry/inquiry-store';

async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

/** Compact de-identified context for the inquiry prompt — clinical content only, NO uid/uhid/name
 *  (Inquiry PRD §17; same posture as the CCB brief + Order-check judge). */
function inquiryContextSummary(oc: DeidOpdCase, unknowns: UnknownItem[]): string {
  const lines: string[] = [];
  if (oc.presentingComplaints?.length) lines.push(`Presenting: ${oc.presentingComplaints.slice(0, 4).join('; ')}`);
  if (oc.impressions?.length) lines.push(`Impression: ${oc.impressions.slice(0, 3).join('; ')}`);
  if (oc.medications?.length) lines.push(`Prescribed: ${oc.medications.slice(0, 6).map((m) => [m.generic || m.brand, m.highAlert ? '(high-alert)' : ''].filter(Boolean).join(' ')).join('; ')}`);
  if (oc.advice?.length) lines.push(`Plan: ${oc.advice.slice(0, 3).join('; ')}`);
  lines.push(`Allergy field: ${oc.allergies && String(oc.allergies).trim() ? 'documented' : 'blank'}`);
  if (unknowns.length) lines.push(`Open unknowns: ${unknowns.slice(0, 8).map((u) => `${u.kind}:${u.subject} (${u.criticality})`).join('; ')}`);
  return lines.join('\n');
}

/**
 * The INQUIRY_ENABLED serving path (Inquiry PRD §7): resolve individual_uid → member snapshot
 * (soft-fail → episode-only, D14) → deriveUnknowns → candidates → ONE governed Gemini call →
 * validate + assemble, all inside withTrace; persist the served set best-effort (a persist
 * failure never blocks serving). NEVER throws to the caller — the selection core returns the
 * deterministic fallback (ask-set/0.1) on any model failure.
 */
async function serveInquiry(oc: DeidOpdCase, askKeys: AskKeys): Promise<InquiryAskSet & { candidateCount: number; dropped: UnknownItem[] }> {
  return withTrace('inquiry-select', { presc_uid: askKeys.presc_uid }, async (traceId) => {
    const now = new Date().toISOString();
    const indivUid = isUid(askKeys.individual_uid)
      ? askKeys.individual_uid
      : (await individualUidForPresc(askKeys.presc_uid).catch(() => null)) ?? '';
    const snapshot = indivUid ? await getMemberSnapshot(indivUid, now).catch(() => null) : null;
    const unknowns = deriveUnknowns({ episode: oc, snapshot, now });

    const result = await runInquirySelection(oc, askKeys, unknowns, {
      contextSummary: inquiryContextSummary(oc, unknowns),
      timeoutMs: Number(process.env.INQUIRY_TIMEOUT_MS) > 0 ? Number(process.env.INQUIRY_TIMEOUT_MS) : 20_000,
      generate: async (system, user) => {
        const r = await governedChat(traceId, 'inquiry-select', {
          model: TEXT_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.2,
          max_tokens: 900,
        // B6: Flash, not Pro — select-and-phrase is light (the clinical ordering is the
        // deterministic ladder); Pro's "thinking" overran the 20s cap on the first live serve.
        }, { gemini: GEMINI_FLASH_MODEL, promptRef: 'inquiry-core/INQUIRY_SELECT_SYSTEM' });
        return r?.choices?.[0]?.message?.content ?? '';
      },
    });

    // Persist the SERVED set with its full derivation (PRD §8) — best-effort, never blocking.
    const unknownById = new Map(unknowns.map((u) => [u.id, u]));
    const stateRef = unknowns.find((u) => u.stateRef.kind === 'member')?.stateRef ?? unknowns[0]?.stateRef ?? null;
    await saveServedAskSet({
      id: `${askKeys.presc_uid}:${Date.now()}`,
      presc_uid: askKeys.presc_uid,
      individual_uid: indivUid || askKeys.individual_uid || 'unknown',
      served_at: now,
      inquiry_version: INQUIRY_VERSION,
      ask_set_version: result.ask_set_version,
      source: result.source,
      trace_id: traceId ?? null,
      payload: {
        asks: result.asks.map((a) => {
          const meta = result.askMeta.find((m) => m.askId === a.id);
          const ids = meta?.unknownIds ?? [];
          return {
            askId: a.id, family: a.family, subject: a.subject, question: a.question,
            unknownIds: ids,
            sourceRefs: [...new Set(ids.flatMap((uid) => unknownById.get(uid)?.sourceRefs ?? []))],
            why: meta?.why ?? 'baseline',
          };
        }),
        unknowns, dropped: result.dropped, stateRef, candidateCount: result.candidateCount,
        askMeta: result.askMeta,
      },
    }).catch(() => { /* persist failure must never block serving (PRD §13) */ });

    return result;
  });
}

/**
 * Care-Call ask-set (DARK behind CARE_CALL_ENABLED). GET ?uid=<presc_uid> → the per-episode ask
 * generator. Reuses the exported prescriptionSql + rowToOpdCase (the hybrid path assembleEpisode
 * uses internally; assembleEpisode does not surface the DeidOpdCase the generator needs). FAIL-SAFE:
 * any fetch/parse error → { asks:[], degraded:true } at HTTP 200 (the panel logs disposition-only).
 */
export async function GET(req: NextRequest) {
  if (process.env.CARE_CALL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const uid = (req.nextUrl.searchParams.get('uid') || '').trim();
  if (!isUid(uid)) return NextResponse.json({ error: 'pass ?uid=<presc_uid>' }, { status: 400 });

  const [attempt_next, prior] = await Promise.all([nextAttempt(uid), priorAttempts(uid)]);
  try {
    const rows = await metabaseQuery(prescriptionSql(uid)).catch(() => [] as Record<string, unknown>[]);
    if (!rows.length) return NextResponse.json({ asks: [], overflow: [], degraded: true, attempt_next, prior });
    const { case: oc, keys } = rowToOpdCase(rows[0]);
    const askKeys = { presc_uid: uid, individual_uid: String(rows[0].individual_uid ?? ''), uhid: null, note_date: keys.noteDate ?? null };
    // Inquiry path (PRD §7) — DARK behind INQUIRY_ENABLED; unset ⇒ byte-identical to today.
    // Same response shape + additive ask_set_version/source/askMeta (CallPanel ignores unknown fields).
    if (process.env.INQUIRY_ENABLED === '1') {
      const r = await serveInquiry(oc, askKeys).catch(() => null);
      const served = r ?? { ...buildAskSet(oc, askKeys), ask_set_version: 'ask-set/0.1', source: 'deterministic_fallback' as const, askMeta: [] };
      return NextResponse.json({
        asks: served.asks, overflow: served.overflow, degraded: false, attempt_next, prior, keys: askKeys,
        ask_set_version: served.ask_set_version, source: served.source, askMeta: served.askMeta,
      });
    }
    const { asks, overflow } = buildAskSet(oc, askKeys);
    return NextResponse.json({ asks, overflow, degraded: false, attempt_next, prior, keys: askKeys });
  } catch {
    return NextResponse.json({ asks: [], overflow: [], degraded: true, attempt_next, prior });
  }
}
