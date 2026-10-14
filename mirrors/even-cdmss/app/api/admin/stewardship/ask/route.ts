/**
 * /api/admin/stewardship/ask — the persisted conversation in the internal MS stewardship room
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A2 / A3; spec §6, §12.1 S1).
 *
 *   GET  ?case=physician&key=<doctor_uid>            the persisted thread (acceptance #4)
 *   GET  ?case=dept&key=<vocab>:<label>
 *   POST { case, key, question }
 *
 * ONE ROUTE, TWO GRAINS — and the reason it is one rather than two: O4's rule is one admin-gated
 * endpoint per SURFACE, so that each can be found, authorised and revoked on its own. The physician
 * case and the department case are the same surface — `/admin/stewardship`, one room, one gate, one
 * revocation — and A2 gives them ONE material builder in one file. Two routes here would be two
 * copies of the same auth, the same validation and the same seam, differing only in a string.
 *
 * THE GATE IS THE COOKIE, AND ONLY THE COOKIE (D-audience; kickoff §1, §5). This deliberately does
 * NOT follow the `requireAdmin(req) || isAdminUnlocked()` pattern the OPD and IPD ask routes use.
 * `requireAdmin` in lib/admin-gate.ts FAILS OPEN in dev when ADMIN_TOKEN is unset; `isAdminUnlocked`
 * in lib/admin-cookie.ts fails closed always. This room is a named-doctor ranking. A surface whose
 * whole risk is "anyone who can see a named-doctor ranking without the admin cookie" does not get to
 * borrow the looser of the two gates because the neighbouring route did.
 *
 * §3.3 / D-chat — WHAT THIS ROUTE CANNOT DO. It reads `opd_note_audits`, `ipd_discharge_audits` and
 * `doctor_directory`, and it writes `case_ask_turns`. It writes no score, no band, no verdict, no
 * feedback row, no `physician_standing` (S4 owns the overlay and it does not exist yet) and no
 * MemberState. There is no recompute control on this path. No patient name, UHID, encounter id or
 * individual_uid is assembled into the material — the aggregate reads counts and means, and never
 * reads an identifying column at all.
 *
 * ACCEPTANCE #19 — a `case` outside the union is a 400 here, BEFORE the loader, before the model and
 * before the store. `badKey()` in lib/case-ask/store.ts is the second check behind this one.
 *
 * ⚠️ INFERRED SQL: every query this route reaches lives in lib/case-ask/stewardship-material.ts and
 * is listed verbatim in the S1 slice report.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { probeReachable } from '@/lib/lab-override';
import { isCaseAskType, normaliseQuestion, type CaseAskType } from '@/lib/case-ask-core';
import { isStewardshipCaseType, loadStewardshipCase, parseDeptCaseKey } from '@/lib/case-ask/stewardship-material';
import { serveCaseAskAnswer, serveCaseAskThread } from '@/lib/case-ask/serve';
import { CASE_ASK_MODEL_ID } from '@/lib/case-ask-core';
import { STEWARDSHIP_WINDOW_DAYS } from '@/lib/stewardship-canonical';
import { standingDecision, standingRow } from '@/lib/physician-standing-core';
import { appendStanding } from '@/lib/physician-standing-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** O8 — role-only attribution. There is no per-person reviewer identity in this app and this ship
 *  does not invent one; what is recorded is the role the request proved. */
const ACTOR = 'admin';

const isDoctorUid = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);

/**
 * The case type and key, validated as VALUES. Two separate refusals, deliberately:
 *   · a case type outside the shell's union at all — acceptance #19;
 *   · a case type inside the union but belonging to another surface ('opd' / 'ipd'), which this
 *     route must not serve even though the shell would happily key a thread for it.
 */
function readCase(rawType: unknown, rawKey: unknown):
| { ok: true; caseType: CaseAskType; caseKey: string }
| { ok: false; error: string } {
  const t = String(rawType ?? '').trim();
  if (!isCaseAskType(t)) return { ok: false, error: 'unknown case type' };
  if (!isStewardshipCaseType(t)) return { ok: false, error: 'that case type is not served by this room' };
  const key = String(rawKey ?? '').trim();
  if (!key) return { ok: false, error: 'case key required' };
  if (t === 'physician') {
    if (!isDoctorUid(key)) return { ok: false, error: 'bad doctor id' };
    return { ok: true, caseType: t, caseKey: key };
  }
  // A3 — '<vocab>:<label>', vocab ∈ opd_speciality | ipd_speciality. Anything else is refused here
  // rather than stored, because the key IS the thread's identity: a malformed one is a thread nobody
  // can ever find again.
  if (!parseDeptCaseKey(key)) return { ok: false, error: 'bad department key' };
  return { ok: true, caseType: t, caseKey: key };
}

async function authorised(): Promise<NextResponse | null> {
  if (await isAdminUnlocked().catch(() => false)) return null;
  return NextResponse.json({ ok: false, error: 'locked' }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const denied = await authorised();
  if (denied) return denied;

  const c = readCase(req.nextUrl.searchParams.get('case'), req.nextUrl.searchParams.get('key'));
  if (!c.ok) return NextResponse.json({ ok: false, error: c.error }, { status: 400 });

  const { status, body } = await serveCaseAskThread({
    caseType: c.caseType, caseKey: c.caseKey, actor: ACTOR, load: loadStewardshipCase(c.caseType, c.caseKey),
  });
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const denied = await authorised();
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const c = readCase(body.case, body.key);
  if (!c.ok) return NextResponse.json({ ok: false, error: c.error }, { status: 400 });
  const q = normaliseQuestion(body.question);
  if (!q.ok) return NextResponse.json({ ok: false, error: q.error }, { status: 400 });
  // F11 — unserved means withhold, never a quiet fallback to some other model.
  if (!probeReachable('bedrock')) return NextResponse.json({ ok: false, error: 'the agent is not reachable in this deployment' }, { status: 503 });

  const { status, body: payload } = await serveCaseAskAnswer({
    caseType: c.caseType, caseKey: c.caseKey, actor: ACTOR,
    load: loadStewardshipCase(c.caseType, c.caseKey), question: q.question,

    // S4 — the standing overlay (spec §6.3 / §12.3). The shell hands over the raw claim and the
    // auditor's own words; the gate here decides, and a refusal is silent by design: the turn is
    // already stored, the answer is already shown, and "he asked a question" and "he made no
    // judgement" are the same state. Nothing on this path writes a score, a band or a pill.
    onStatedOverlay: async ({ overlay, question, userTurnId, engineVersion }) => {
      const decision = standingDecision(question, overlay as never);
      if (!decision.write) return;
      const row = standingRow({
        caseType: c.caseType, caseKey: c.caseKey, engineVersion,
        decision, actor: ACTOR, turnId: userTurnId ?? '', model: CASE_ASK_MODEL_ID,
        windowDays: STEWARDSHIP_WINDOW_DAYS,
      });
      if (row) await appendStanding(row);
    },
  });
  return NextResponse.json(payload, { status });
}
