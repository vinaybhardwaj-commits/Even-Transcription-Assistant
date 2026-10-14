/**
 * POST /api/care/preop/review — Slice 1's ONLY workflow verb (mockup note 7).
 *
 * Marks ONE episode reviewed AT ONE SNAPSHOT VERSION. The version is part of the key on
 * purpose: a new snapshot re-opens review, because a sign-off is a statement about a
 * reading, not about a patient. A stale version simply does not match and the caller is
 * told why rather than silently signing off a reading nobody saw.
 *
 * This is the only route on the pre-op surface that writes. It writes four columns on one
 * row, calls no model, and touches neither the snapshot nor the versions rail.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { markReviewed } from '@/lib/preop/store';
import { isEpisodeKeyShape } from '@/lib/preop-versions-core';
import { preopAuthed, preopSurfaceEnabled } from '@/lib/preop/gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BY = 120;

export async function POST(req: NextRequest) {
  if (!preopSurfaceEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await preopAuthed())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { episodeKey?: unknown; versionNo?: unknown; by?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }

  const key = typeof body.episodeKey === 'string' ? body.episodeKey.trim() : '';
  if (!key || !isEpisodeKeyShape(key)) return NextResponse.json({ error: 'bad_key' }, { status: 400 });

  const version = typeof body.versionNo === 'number' ? body.versionNo : NaN;
  if (!Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: 'versionNo must be the snapshot version being reviewed' }, { status: 400 });
  }
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, MAX_BY) : 'care manager';

  const res = await markReviewed(key, version, by);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 409 });
  return NextResponse.json({ ok: true, episodeKey: key, versionNo: version, by });
}
