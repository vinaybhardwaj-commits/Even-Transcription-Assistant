// app/admin/observability/engine-health/page.tsx — Engine Health (PRD
// CDMSS-METAMORPHIC-AND-SYNTHETIC-CONTROLS v1.0 §5A, M6).
//
// The DETERMINISTIC half runs LIVE on load — the metamorphic relations and synthetic controls are
// pure functions over committed fixtures (the SAME runRelations()/runSyntheticControls() the CI
// tests assert; lib/metamorphic-core.ts is the single definition). No stored results, no
// migration, no staleness — and therefore NO HISTORY: this half shows the deployed engine NOW.
// Only the LLM half has history, because lab_analyses keeps its rows (experiment LIKE 'mm-llm-%').
//
// FAIL-SAFE (§5A): every section degrades independently. A failed lab_analyses query renders the
// LLM section empty with a note; it never blanks the live relation results and never 500s.
//
// ⚠️ SHELL CONVENTION, flagged (same finding as app/admin/scoring-policy/page.tsx): the PRD
// mandates `AdminLayout` with a `breadcrumbs` prop and warns omitting it breaks the build. There
// is NO AdminLayout in this repository — every /admin/observability page is a plain server
// component gating on isAdminUnlocked() with its own header + back-link. This page follows the
// repo's actual convention (see ../adjudications/page.tsx); flagged in the build report.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  runRelations, runSyntheticControls, RATIFIED_RELATION_STATUS, PART_C_RELATIONS, majorityOf,
  RATIFIED_AT_ENGINE, ratificationDriftWarning, partCVerdict, type PartCVerdict,
} from '@/lib/metamorphic-core';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Engine Health · Observability' };

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

type LlmRow = { experiment: string; output: Record<string, unknown>; created_at: string };

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
      {label}
    </span>
  );
}

// VACUOUS is a real result, not an absence of one — and never green: it means the base arm lacked
// the state the transformation removes, so the relation could not be tested (HONESTY PRD §2).
function VerdictPill({ verdict }: { verdict: PartCVerdict }) {
  const cls = verdict === 'HOLDS' ? 'bg-emerald-50 text-emerald-700'
    : verdict === 'FAILS' ? 'bg-red-50 text-red-700'
    : 'bg-amber-50 text-amber-700';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>{verdict}</span>;
}

export default async function EngineHealthPage() {
  if (!(await isAdminUnlocked())) {
    return <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.</div>;
  }

  // ── Deterministic half — LIVE, pure, no I/O. Each block degrades independently. ──
  let relations: ReturnType<typeof runRelations> = [];
  let relationsError: string | null = null;
  try { relations = runRelations(); } catch (e) { relationsError = (e as Error).message; }

  let controls: ReturnType<typeof runSyntheticControls> | null = null;
  let controlsError: string | null = null;
  try { controls = runSyntheticControls(); } catch (e) { controlsError = (e as Error).message; }

  // ── LLM half — lab_analyses history. A failed query degrades to an empty section. ──
  let llmRows: LlmRow[] = [];
  let llmError: string | null = null;
  try {
    llmRows = (await run(
      `SELECT experiment, output, created_at::text AS created_at
         FROM lab_analyses
        WHERE experiment LIKE 'mm-llm-%'
        ORDER BY created_at DESC
        LIMIT 200`, [],
    )) as LlmRow[];
  } catch (e) { llmError = (e as Error).message; }

  // Latest 3 runs per (experiment, arm); majority per arm; 2–1 = split (M2). `praise` is read
  // beside `fired` because the precondition (and L-3's verdict) needs both (HONESTY PRD §2).
  // RETIRED relations (active: false) are not displayed. They stay in PART_C_RELATIONS as fixtures
  // for the verdict-logic tests — L-3 is the subject of the 1 August regression guard — but a
  // retired relation has no live result to show. An empty active set renders the empty-state row.
  const llmByRelation = PART_C_RELATIONS.filter((rel) => rel.active).map((rel) => {
    const rows = llmRows.filter((r) => r.experiment === rel.experiment);
    const arm = (name: string, key: 'fired' | 'praise') => rows
      .filter((r) => (r.output as { arm?: string })?.arm === name)
      .slice(0, 3)
      .map((r) => (r.output as Record<string, unknown>)?.[key] === true);
    const base = arm('base', 'fired');
    const transformed = arm('transformed', 'fired');
    const baseMaj = base.length ? majorityOf(base) : null;
    const transMaj = transformed.length ? majorityOf(transformed) : null;
    const basePraiseMaj = base.length ? majorityOf(arm('base', 'praise')) : null;
    const transPraiseMaj = transformed.length ? majorityOf(arm('transformed', 'praise')) : null;
    return { rel, base, transformed, baseMaj, transMaj, basePraiseMaj, transPraiseMaj, hasData: base.length > 0 || transformed.length > 0 };
  });

  const driftWarning = ratificationDriftWarning(OPD_ENGINE_VERSION);

  const fmt = (fires: boolean[]) => `${fires.filter(Boolean).length}/${fires.length}`;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Engine Health</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-slate-500">
            Metamorphic relations + synthetic known-positive controls over the OPD deterministic leg, and the LLM-leg lab relations.
            <b> The deterministic half runs live on load and shows the CURRENT deployed engine — it is a snapshot, not a history.</b> Only
            the LLM half has history (persisted lab runs). A pinned <i>known defect</i> is an observed production defect deliberately
            reproduced, not fixed, by the test suite.
          </p>
        </div>
        <Link href="/admin/observability" className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">← Observability</Link>
      </div>

      {/* ── Section 1: metamorphic relations (live) ── */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-slate-900">Metamorphic relations — live (D-1…D-7, G-1…G-7)</h2>
        {driftWarning && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{driftWarning}</p>
        )}
        {relationsError ? (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Relations could not run: {relationsError}</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-400">
                <th className="py-1.5 pr-2 font-medium">Relation</th>
                <th className="py-1.5 pr-2 font-medium">Status</th>
                <th className="py-1.5 pr-2 font-medium">Ratified @ {RATIFIED_AT_ENGINE}</th>
                <th className="py-1.5 font-medium">Observed</th>
              </tr>
            </thead>
            <tbody>
              {relations.map((r) => {
                const ratified = RATIFIED_RELATION_STATUS[r.id];
                const deviates = (ratified === 'pass') !== r.pass;
                return (
                  <tr key={r.id} className={`border-b border-slate-100 align-top ${deviates ? 'bg-amber-50' : ''}`}>
                    <td className="py-1.5 pr-2 whitespace-nowrap font-medium text-slate-700">{r.id} · {r.title}</td>
                    <td className="py-1.5 pr-2"><Pill ok={r.pass} label={r.pass ? 'PASS' : 'FAIL'} /></td>
                    <td className="py-1.5 pr-2 text-slate-500">
                      {ratified === 'fail' ? 'known defect (pinned)' : 'pass'}
                      {deviates && <b className="ml-1 text-amber-700">— DEVIATES, re-ratify</b>}
                    </td>
                    <td className="py-1.5 text-slate-500">{r.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Section 2: synthetic controls + recall_det (live) ── */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-slate-900">Synthetic known-positives — live</h2>
        {controlsError || !controls ? (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Controls could not run: {controlsError ?? 'unknown'}</p>
        ) : (
          <>
            <p className="mt-1.5 text-xs text-slate-500">
              <b className="text-slate-700">recall_det = {controls.fired} / {controls.planted} = {(controls.recall_det * 100).toFixed(1)}%</b> —
              recall of the <b>deterministic leg only</b> over the planted rulebook-derived corpus; no LLM recall is claimed.
            </p>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-600">Positives ({controls.positives.length})</h3>
                <ul className="mt-1 space-y-1">
                  {controls.positives.map((p) => (
                    <li key={p.id} className="flex items-start gap-2 text-xs text-slate-500">
                      <Pill ok={p.fired} label={p.fired ? 'FIRED' : 'MISS'} />
                      <span><b className="text-slate-700">{p.id}</b> ({p.expected_signal_type}) — {p.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-600">Negative controls (6) — {controls.negativesHeld ? 'all held' : 'BROKEN'}</h3>
                <ul className="mt-1 space-y-1">
                  {controls.negatives.map((n) => (
                    <li key={n.id} className="flex items-start gap-2 text-xs text-slate-500">
                      <Pill ok={n.held === true} label={n.held ? 'HELD' : 'FIRED'} />
                      <span><b className="text-slate-700">{n.id}</b> — {n.note}{!n.held && <i> · observed: {n.observed}</i>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Section 3: LLM-leg relations (lab history) ── */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-slate-900">LLM-leg relations — lab history (3 runs per arm, majority decides)</h2>
        {/* Retirement + scope statement (V, 2 Aug 2026). States only what the leg supports: it runs
            on the local model, so a verdict here is not a statement about the production grader. */}
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-slate-500">
          These relations run on the <b className="text-slate-700">local model</b>, not on the production grader,
          so they do not test the engine that scores doctors. A verdict here is a statement about the lab pipeline
          and nothing more.
          {' '}<b className="text-slate-700">L-2 and L-3 are retired</b> — both rest on the engine praising a note,
          and praise proved too rare to build a test on. Their fixtures are kept as test cases for the verdict logic;
          they are no longer run.
          {' '}<b className="text-slate-700">L-1 is retained</b>, and its result stands on record below.
        </p>
        {llmError ? (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            lab_analyses could not be read ({llmError}) — the LLM section is empty; the live deterministic results above are unaffected.
          </p>
        ) : (
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-400">
                <th className="py-1.5 pr-2 font-medium">Relation</th>
                <th className="py-1.5 pr-2 font-medium">Base fires</th>
                <th className="py-1.5 pr-2 font-medium">Transformed fires</th>
                <th className="py-1.5 pr-2 font-medium">Verdict</th>
                <th className="py-1.5 font-medium">Split?</th>
              </tr>
            </thead>
            <tbody>
              {llmByRelation.map(({ rel, base, transformed, baseMaj, transMaj, basePraiseMaj, transPraiseMaj, hasData }) => {
                if (!hasData) {
                  return (
                    <tr key={rel.id} className="border-b border-slate-100">
                      <td className="py-1.5 pr-2 font-medium text-slate-700">{rel.id} · {rel.title}</td>
                      <td className="py-1.5 text-slate-400" colSpan={4}>no lab runs yet — run scripts/metamorphic-llm-report.mjs</td>
                    </tr>
                  );
                }
                const split = (baseMaj?.split ?? false) || (transMaj?.split ?? false)
                  || (rel.precondition === 'praise' && (basePraiseMaj?.split ?? false))
                  || (rel.id === 'L-3' && (transPraiseMaj?.split ?? false));
                // Precondition first, then the relation's own verdict — the SAME partCVerdict the
                // runner uses (single definition). Also repairs the old L-3 wiring here, which fed
                // (baseFired, transformedFired) into a verdict expecting (praiseStillPresent, safetyFired).
                const result = baseMaj != null && transMaj != null && basePraiseMaj != null && transPraiseMaj != null
                  ? partCVerdict(rel, {
                      baseFired: baseMaj.fired, basePraise: basePraiseMaj.fired,
                      transformedFired: transMaj.fired, transformedPraise: transPraiseMaj.fired,
                    })
                  : null;
                return (
                  <tr key={rel.id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-2 font-medium text-slate-700">{rel.id} · {rel.title}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{fmt(base)}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{fmt(transformed)}</td>
                    <td className="py-1.5 pr-2">
                      {result == null ? <span className="text-slate-400">incomplete</span> : <VerdictPill verdict={result.verdict} />}
                      {result?.reason && <span className="ml-1.5 text-amber-700">{result.reason}</span>}
                    </td>
                    <td className="py-1.5">{split ? <b className="text-amber-700">split (2–1) — a finding about non-determinism, not a pass</b> : 'no'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
