/**
 * POST /api/care/patterns/generate — run the L2 operator over the current shelved head, writing
 * `title` and `why` per pattern into `lvp_decorations`. `?auto=1` is the nightly cron tick
 * (30 0 * * * UTC = 06:00 IST). Copies the shape of app/api/care/lvc/generate/route.ts, the route
 * this one's cron line replaces: POST plus GET for the cron, and ALWAYS HTTP 200 carrying
 * `{status: ok|error|skipped}` — a generation failure is a status, never a 500.
 *
 * ⚠️ ADMIN-GATED FOR MANUAL RETRIGGER, NEVER A CARE-MANAGER CONTROL (O13). The care cookie
 * authorises the cron path NOWHERE and the manual path NOWHERE. The shelf has exactly one
 * care-manager action and it is hide; re-running a model is an operator action, so the manual arm
 * takes the admin session or ADMIN_TOKEN and nothing else. This is the one place this route
 * deliberately does NOT copy lvc/generate, which accepts a care unlock.
 *
 * ⚠️ F11: a Bedrock target that cannot be served throws rather than being answered by another
 * provider, so a failed run returns {status:'error'}, writes zero rows, and the shelf renders stub
 * copy until a later run succeeds. That is the designed degradation.
 *
 * FLAGGED OFF by default: needs CCB_ENABLED=1 and LVC_PATTERNS_ENABLED=1 — the same pair that
 * gates the shelf itself, so this route cannot decorate a page nobody can open.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { runPatternOperator } from '@/lib/lvp-operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.LVC_PATTERNS_ENABLED === '1';
}

/** The cron arm: Vercel's own header, or a bearer/query CRON_SECRET. No cookie of any kind. */
function cronAuthed(req: NextRequest): boolean {
  if (req.headers.get('x-vercel-cron') !== null) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get('secret') === secret;
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });

  const auto = req.nextUrl.searchParams.get('auto') === '1';
  if (auto) {
    if (!cronAuthed(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  } else if (!(await isAdminUnlocked().catch(() => false))) {
    // ⚠️ ADMIN ONLY (O13). requireAdmin fails OPEN when ADMIN_TOKEN is unset, which is the dev
    // posture the rest of the admin surface already has; the flag above is what keeps this route
    // closed in every environment that has not deliberately opened the shelf.
    const denied = requireAdmin(req);
    if (denied) return denied;
  }

  const result = await runPatternOperator({ trigger: auto ? 'cron' : 'manual' });
  return NextResponse.json(result);   // always 200; result.status ∈ ok | error | skipped
}

/** Vercel crons issue GET; mirrors the ?auto tick shape exactly. */
export async function GET(req: NextRequest) { return POST(req); }
