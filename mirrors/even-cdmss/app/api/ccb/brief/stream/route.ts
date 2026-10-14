export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { assembleEpisode } from '@/lib/ccb-fetch';
import { generateBrief } from '@/lib/ccb-brief';
import { saveBrief, getBriefByUid } from '@/lib/ccb-store';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { ccbApiKeyValid } from '@/lib/ccb-apikey';
import { resolveBriefUid } from '@/lib/ccb-resolve';
import { GEMINI_MODEL } from '@/lib/llm';
import { makeNdjsonStream, ndjsonHeaders, type Stage } from '@/lib/stream';

// Execution guard: CCB_API_KEY (Pulse), care-manager session, admin session, OR Bearer/secret CRON_SECRET.
async function authed(req: NextRequest): Promise<boolean> {
  if (ccbApiKeyValid(req)) return true;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (bearerOk || secretOk) return true;
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * Care Conversation Brief — STREAMING (P2.3). DARK behind CCB_ENABLED.
 * GET ?uid=<presc_uid>[&fresh=1][&dry=1] → NDJSON: {progress…} → {result: envelope} → {done}.
 * Powers the /care surface's live heartbeat (and sidesteps the single-request timeout).
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const fresh = p.get('fresh') === '1';
  const dry = p.get('dry') === '1';
  const { uid } = await resolveBriefUid({
    uid: (p.get('uid') || '').trim() || undefined,
    uhid: (p.get('uhid') || '').trim() || undefined,
    individualUid: (p.get('individual_uid') || '').trim() || undefined,
    memberId: (p.get('member_id') || '').trim() || undefined,
    date: (p.get('date') || '').trim() || undefined,
  });
  if (!uid) return NextResponse.json({ error: 'no episode found — pass ?uid=, or ?member_id=/?uhid=/?individual_uid= (optionally with ?date=)' }, { status: 404 });

  const { stream, emit, close } = makeNdjsonStream();
  const t0 = Date.now();
  const prog = (stage: Stage, msg: string) => emit({ type: 'progress', stage, msg, ms: Date.now() - t0 });

  (async () => {
    try {
      if (!fresh) {
        const cached = await getBriefByUid(uid, CCB_ENGINE_VERSION).catch(() => null);
        if (cached) { emit({ type: 'result', data: { ...cached, cached: true } }); emit({ type: 'done', ms: Date.now() - t0 }); return; }
      }
      prog('fetching', 'Assembling the episode…');
      const bundle = await assembleEpisode(uid);
      if (!bundle) { emit({ type: 'error', message: 'prescription not found' }); return; }

      const started = Date.now();
      const envelope = await generateBrief(bundle, { onStage: (s, m) => prog(s as Stage, m) });
      if (!dry) await saveBrief(envelope, bundle.keys, { model: GEMINI_MODEL, latencyMs: Date.now() - started }).catch(() => {});

      emit({ type: 'result', data: envelope });
      emit({ type: 'done', ms: Date.now() - t0 });
    } catch (e) {
      emit({ type: 'error', message: String((e as Error).message) });
    } finally {
      close();
    }
  })();

  return new Response(stream, { headers: ndjsonHeaders() });
}
