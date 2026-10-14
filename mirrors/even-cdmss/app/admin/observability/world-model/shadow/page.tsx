/**
 * app/admin/observability/world-model/shadow/page.tsx — WM1: what the agent WOULD have said.
 *
 * The whole point of this surface is the gap between "events seen" and "would ask". A shadow agent
 * that would have spoken on every second note is not ready to be given a voice; one that would have
 * spoken once per ten eligible events, and can name why it stayed quiet the other nine times, is.
 *
 * ⚠️ SHADOW ONLY. Every number here describes a decision that was recorded and never acted on. The
 * sentence saying so is rendered unconditionally, at the top, because a screen full of "would ask"
 * counts is exactly the kind of thing that gets mistaken for a queue of things that happened.
 *
 * Read-only, admin-gated by the same `isAdminUnlocked` wall as World Model and Observability. Every
 * read is individually fail-safe: a failed count renders as an honest dash, never as a zero.
 */
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { BURDEN_PER_ELIGIBLE, PER_DOCTOR_DAILY_CAP } from '@/lib/cognition/burden-policy';
import { BURDEN_POLICY_VERSION, COGNITION_SCHEMA_VERSION } from '@/lib/cognition/schema';
import { MATCH_RULE } from '@/lib/cognition/microworld';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Shadow Agent · World Model · Observability' };

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/** The sentence that must never be edited into something softer. */
const SHADOW_ONLY = 'Shadow only — no doctor has seen or will see these.';

/** Fail-safe read. `null` means "we could not read", which renders as an em dash — never as 0. */
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[] | null> {
  try { return (await run(text, params)) as T[]; } catch { return null; }
}

const REASON_LABEL: Record<string, string> = {
  would_ask: 'would ask',
  not_microworld: 'not in the microworld',
  no_doctor: 'no doctor on the row',
  stale_era: 'stale engine era',
  budget_global: 'global budget not yet earned',
  budget_doctor: 'doctor already asked today',
};

const O_STATUS_LABEL: Record<string, string> = {
  ok: 'ok — spine reconstructed',
  no_prior_history: 'no prior history',
  context_fetch_failed: 'context fetch failed',
  unresolved_identity: 'unresolved identity',
};

function Chip({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'brand' }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'brand' ? 'border-brand/30 bg-brand/5 text-brand'
    : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span className={`rounded border px-1.5 py-0.5 text-[10.5px] ${cls}`}>{children}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** A count histogram. `rows === null` is a read failure and says so rather than showing an empty list. */
function Histogram({ title, hint, rows, labels }: {
  title: string; hint?: string;
  rows: { k: string; n: number }[] | null;
  labels?: Record<string, string>;
}) {
  const total = rows ? rows.reduce((s, r) => s + r.n, 0) : 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
      {rows === null ? (
        <div className="mt-2 text-[12px] text-red-700">Could not read — this is not zero.</div>
      ) : rows.length === 0 ? (
        <div className="mt-2 text-[12px] italic text-slate-300">none yet</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li key={r.k}>
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="text-slate-700">{labels?.[r.k] ?? r.k}</span>
                <span className="font-mono text-slate-500">{r.n}{total > 0 ? ` · ${Math.round((100 * r.n) / total)}%` : ''}</span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-slate-100">
                <div className="h-1 rounded bg-brand/50" style={{ width: total > 0 ? `${(100 * r.n) / total}%` : '0%' }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function ShadowAgentPage() {
  if (!(await isAdminUnlocked())) {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
        Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.
      </div>
    );
  }

  const [totals, byKind, byReason, byOStatus] = await Promise.all([
    rowsOf<{ total: number; eligible: number; would_ask: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE eligible)::int AS eligible,
              count(*) FILTER (WHERE would_ask)::int AS would_ask
         FROM cognition_shadow_events WHERE app_source = $1 AND policy_version = $2`,
      [APP, BURDEN_POLICY_VERSION]),
    rowsOf<{ k: string; n: number }>(
      `SELECT trigger_kind AS k, count(*)::int AS n
         FROM cognition_shadow_events WHERE app_source = $1 AND policy_version = $2
        GROUP BY 1 ORDER BY n DESC`,
      [APP, BURDEN_POLICY_VERSION]),
    rowsOf<{ k: string; n: number }>(
      `SELECT reason AS k, count(*)::int AS n
         FROM cognition_shadow_events
        WHERE app_source = $1 AND policy_version = $2 AND would_ask = FALSE
        GROUP BY 1 ORDER BY n DESC`,
      [APP, BURDEN_POLICY_VERSION]),
    rowsOf<{ k: string; n: number }>(
      `SELECT o_status AS k, count(*)::int AS n
         FROM cognition_shadow_events
        WHERE app_source = $1 AND policy_version = $2 AND o_status IS NOT NULL
        GROUP BY 1 ORDER BY n DESC`,
      [APP, BURDEN_POLICY_VERSION]),
  ]);

  const t = totals?.[0] ?? null;
  const num = (v: number | undefined) => (t === null || v === undefined ? '—' : String(v));
  const eligible = t?.eligible ?? 0;
  const wouldAsk = t?.would_ask ?? 0;
  // The headline claim: one ask per N eligible events. Undefined until an ask has happened.
  const oneInN = t && wouldAsk > 0 ? (eligible / wouldAsk) : null;
  const withinBudget = oneInN === null ? null : oneInN >= BURDEN_PER_ELIGIBLE;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Shadow Agent</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
            What the world-model agent <b>would</b> have asked, had it been allowed to speak. Every decision below was
            recorded and then dropped. The number that matters is not how often it would have spoken — it is whether it
            can name why it stayed quiet the rest of the time.
          </p>
        </div>
        <Link href="/admin/observability/world-model" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">← World Model</Link>
      </div>

      {/* Unconditional, and first. */}
      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] font-medium text-amber-900">
        {SHADOW_ONLY}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Chip tone="brand">{BURDEN_POLICY_VERSION}</Chip>
        <Chip>{COGNITION_SCHEMA_VERSION}</Chip>
        <Chip>{MATCH_RULE}</Chip>
        <Chip>budget: 1 per {BURDEN_PER_ELIGIBLE} eligible</Chip>
        <Chip>cap: {PER_DOCTOR_DAILY_CAP}/doctor/day</Chip>
      </div>

      {t === null ? (
        <div className="mt-5 rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">
          <b>Could not read the shadow table.</b> This is <b>not</b> an empty result — no conclusion can be drawn from
          this screen. If the migration has not been run yet, POST <code className="rounded bg-red-100 px-1">/api/admin/migrate-cognition-shadow</code> first.
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Events seen" value={num(t.total)} hint="decision events the shadow judged" />
            <Stat label="Eligible" value={num(t.eligible)} hint="headache · doctor present · current era" />
            <Stat label="Would ask" value={num(t.would_ask)} hint={`objective: close_snapshot`} />
            <Stat
              label="Ask rate"
              value={oneInN === null ? '—' : `1 in ${oneInN.toFixed(1)}`}
              hint={oneInN === null ? 'no ask yet — budget not earned' : `budget is 1 in ${BURDEN_PER_ELIGIBLE}`}
            />
          </div>

          {withinBudget !== null ? (
            <div className={`mt-3 rounded-xl border px-4 py-2.5 text-[12.5px] ${withinBudget ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-800'}`}>
              {withinBudget
                ? <>Within budget — one ask per {oneInN!.toFixed(1)} eligible events, against a ceiling of one per {BURDEN_PER_ELIGIBLE}.</>
                : <><b>Over budget.</b> One ask per {oneInN!.toFixed(1)} eligible events, against a ceiling of one per {BURDEN_PER_ELIGIBLE}. The policy is not holding — do not close the loop.</>}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Histogram title="By trigger kind" hint="only opd_note_audited is reachable in v0" rows={byKind} />
            <Histogram title="Why it stayed quiet" hint="every silence is named" rows={byReason} labels={REASON_LABEL} />
            <Histogram title="Spine status on would-ask events" hint="annotated for would-ask rows only" rows={byOStatus} labels={O_STATUS_LABEL} />
          </div>
        </>
      )}

      <p className="mt-5 text-[11px] text-slate-400">
        Sweeps run <b>every 6 hours</b>, first verified manually on 31 Aug 2026, or on demand via{' '}
        <code className="rounded bg-slate-100 px-1">POST /api/admin/shadow-sweep</code>.
        Idempotent: re-running over the same backlog writes nothing new.
      </p>
    </div>
  );
}
