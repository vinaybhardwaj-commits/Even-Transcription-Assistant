'use client';

/**
 * /care/readmissions — the read-only review room (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD
 * v1.0 §3, to the approved mockup). Renders what the readmission agent already stored:
 * findings grouped clearest-lane-first, each with its identity line, index→readmit path,
 * badges, verdict, reasoning and refusal record, plus an expandable evidence view.
 *
 * READ-ONLY (decision 10). There is deliberately not one control on this page that
 * mutates a finding — no escalate, no strike-down, no note. Everything is a <details>
 * or a link. Escalation is the next phase and the footer says so.
 *
 * ALL judgement lives in lib/readmission-surface-core.ts (lane order, review predicate,
 * badge and verdict mapping) so it is unit-tested; this file is markup and fetch.
 *
 * ONE HONEST DEPARTURE FROM THE MOCKUP: the mockup's "index said / readmit said" panel
 * quotes the discharge prose verbatim. That prose is NOT stored — by PHI design the
 * finding blob keeps only the structured reconciliation output (omissions, exculpatory
 * claims, the refusal record). The panel therefore renders those structured claims in
 * the same two-column shape: what the index discharge ASSERTED on the left, what the
 * readmission CONTRADICTED on the right. Same question answered, from data we actually
 * hold, with no re-read of a PDF on a page load.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RotateCw } from 'lucide-react';
import {
  badgesFor, identityLine, shortDate, verdictConfidence, verdictLabel,
  type Badge, type LaneGroup, type SurfaceFinding, type SurfaceTiles, type Tone,
} from '@/lib/readmission-surface-core';

type BoardData = {
  ok: boolean;
  lanes: LaneGroup[];
  tiles: SurfaceTiles;
  pendingCount: number;
  reviewCount: number;
  total: number;
  namesResolved: boolean;
  error?: string;
};

const CHIP: Record<Tone, string> = {
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  sky: 'bg-sky-100 text-sky-800',
  slate: 'bg-slate-100 text-slate-700',
};
const VERDICT_TEXT: Record<Tone, string> = {
  red: 'text-red-700', amber: 'text-amber-700', emerald: 'text-emerald-700', sky: 'text-sky-700', slate: 'text-slate-600',
};

function Chip({ b }: { b: Badge }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP[b.tone]}`}>{b.text}</span>;
}

function Tile({ n, k }: { n: string; k: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3.5 py-3">
      <div className="font-serif text-[22px] font-semibold tracking-tight text-slate-900">{n}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{k}</div>
    </div>
  );
}

/** The index→readmit path line. Every part is optional on a real row, so each is
 *  dropped individually rather than rendering "null → null". */
function PathLine({ f }: { f: SurfaceFinding }) {
  const oon = f.findingClass === 'out_of_network';
  const from = shortDate(f.indexDischargeAt);
  const to = shortDate(f.readmitAdmitAt);
  const bits: React.ReactNode[] = [];
  if (f.indexDepartment) bits.push(<b key="dept" className="font-semibold text-slate-900">{f.indexDepartment}</b>);
  if (f.indexDoctor) bits.push(<span key="doc">{f.indexDoctor}</span>);
  return (
    <div className="mt-1 text-[12.5px] text-slate-600">
      {bits.map((b, i) => <span key={i}>{i > 0 && ' · '}{b}</span>)}
      {(from || to) && (
        <span>
          {bits.length > 0 && '  ·  '}
          {from && <>discharged {from}</>}
          {to && <> → <b className="font-semibold text-slate-900">{oon ? `readmitted elsewhere ~${to}` : `readmitted ${to}`}</b></>}
        </span>
      )}
      {f.payerIndex && <span> · {f.payerIndex}</span>}
    </div>
  );
}

/** The expandable evidence view — structured claims, not quoted prose (see docblock). */
function EvidencePanel({ f }: { f: SurfaceFinding }) {
  const blob = f.finding;
  const omissions = f.omissionEvidence ?? [];
  const exculpatory = blob?.exculpatory ?? [];
  if (!omissions.length && !exculpatory.length && !blob?.stabilityAssessment) return null;
  return (
    <details className="mt-2.5 group">
      <summary className="cursor-pointer list-none text-[12px] font-semibold text-brand marker:content-['']">
        <span className="group-open:hidden">▸ </span><span className="hidden group-open:inline">▾ </span>
        What the index discharge claimed / what the readmission showed
      </summary>
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
          <h4 className="text-[11px] uppercase tracking-wider text-slate-500">Index discharge claimed</h4>
          {exculpatory.length === 0 && <p className="mt-1.5 text-[12px] text-slate-500">No exculpatory claim recorded.</p>}
          {exculpatory.map((e, i) => (
            <p key={i} className="mt-1.5 text-[12px] leading-relaxed text-slate-600">
              {e.claim}{' '}
              <span className={`rounded px-1 py-px text-[11px] ${e.corroborated ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
                {e.corroborated ? 'corroborated' : 'uncorroborated'}
              </span>
            </p>
          ))}
          {blob?.stabilityAssessment && (
            <p className="mt-2 text-[11.5px] text-slate-500">
              Stability at discharge: <span className="font-medium text-slate-700">{blob.stabilityAssessment}</span>
            </p>
          )}
        </div>
        <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
          <h4 className="text-[11px] uppercase tracking-wider text-slate-500">Readmission showed</h4>
          {omissions.length === 0 && <p className="mt-1.5 text-[12px] text-slate-500">No contradicting finding recorded.</p>}
          {omissions.map((o, i) => (
            <p key={i} className="mt-1.5 text-[12px] leading-relaxed text-slate-600">
              <span className="rounded bg-red-50 px-1 py-px text-red-800">{o.claim}</span>
              {o.danger && <span className="text-slate-500"> · {o.danger} risk</span>}
              {o.confidence && <span className="text-slate-500"> · {o.confidence} confidence</span>}
              {o.source === 'derived' && <span className="text-slate-500"> · from the numbers</span>}
              {o.caveat && <span className="block text-[11.5px] italic text-slate-500">{o.caveat}</span>}
            </p>
          ))}
        </div>
      </div>
    </details>
  );
}

function FindingCard({ f }: { f: SurfaceFinding }) {
  const v = verdictLabel(f);
  const conf = verdictConfidence(f.finding);
  const reason = f.finding?.avoidable?.reason ?? f.notAuditableReason ?? null;
  const refusals = (f.finding?.refusalRecord ?? []).filter((r) => r.found === false);

  return (
    <div className="mb-3 rounded-xl border border-line bg-paper p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold text-slate-900">{identityLine(f)}</div>
          <PathLine f={f} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {badgesFor(f).map((b, i) => <Chip key={i} b={b} />)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-[12.5px] font-semibold ${VERDICT_TEXT[v.tone]}`}>{v.label}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">{v.sub}</div>
          {conf && <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${CHIP[conf.tone]}`}>{conf.text}</span>}
          {f.needsHumanReview && <div className="mt-1 text-[10.5px] font-medium text-amber-700">needs a human</div>}
        </div>
      </div>

      {reason && (
        <p className="mt-3 border-t border-line pt-3 text-[12.5px] leading-relaxed text-slate-600">
          <span className="font-semibold text-slate-900">Why:</span> {reason}
        </p>
      )}

      <EvidencePanel f={f} />

      {refusals.length > 0 && (
        <p className="mt-2.5 text-[11.5px] italic text-slate-500">
          Looked for but not found: {refusals.map((r) => r.lookedFor).filter(Boolean).join('; ')}. Their absence is the finding.
        </p>
      )}
      {f.finding?.readmitFactsPatientReported && (
        <p className="mt-1.5 text-[11.5px] italic text-slate-500">
          {f.finding.identityResolved ? 'Identity is certain (member → Even UHID). ' : ''}
          What is patient-reported is the readmission itself, stated plainly.
        </p>
      )}
      {f.finding?.weakestStep && (
        <p className="mt-1.5 text-[11.5px] text-slate-500">Weakest step: {f.finding.weakestStep}</p>
      )}
    </div>
  );
}

function LaneSection({ g }: { g: LaneGroup }) {
  const body = g.rows.map((f) => <FindingCard key={f.dedupKey} f={f} />);
  const header = (
    <div className="mb-2.5 mt-7 flex items-baseline gap-2.5">
      <div className={`w-[3px] self-stretch rounded-sm ${g.bar}`} />
      <h2 className="text-[14.5px] font-semibold text-slate-900">{g.title}</h2>
      <span className="text-[12px] text-slate-500">{g.rows.length} {g.rows.length === 1 ? 'finding' : 'findings'} · {g.blurb}</span>
    </div>
  );
  // The held-out sample collapses: it is expected by design, so it should not compete
  // for attention with the lanes that are actually work.
  if (g.collapsed) {
    return (
      <details className="mt-7">
        <summary className="cursor-pointer list-none text-[13px] font-semibold text-slate-500 marker:content-['']">
          ▸ {g.title} <span className="font-normal text-slate-400">({g.rows.length}) — {g.blurb}</span>
        </summary>
        <div className="mt-3">{body}</div>
      </details>
    );
  }
  return <section>{header}{body}</section>;
}

export default function ReadmissionsBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/care/readmissions/list');
      const j = (await r.json()) as BoardData;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setData(j);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const t = data?.tiles;
  const rate = t && t.thirtyDayRate != null ? `${(t.thirtyDayRate * 100).toFixed(1)}` : '—';

  return (
    <div className="mx-auto max-w-content px-5 py-7">
      <div className="mb-3.5 text-[12px] text-slate-500">
        <Link href="/care" className="font-medium text-brand">Managed Care</Link> › Readmissions
      </div>

      <div className="flex items-center gap-2">
        <h1 className="font-serif text-[23px] font-semibold tracking-tight text-slate-900">Readmissions</h1>
        <span className="rounded-full bg-brand-faint px-2.5 py-0.5 text-[11px] font-medium text-brand-dark">Advisory · care management</span>
        <button onClick={() => void load()} disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
          <RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>
      <p className="mt-1 text-[12.5px] text-slate-500">
        Every unplanned readmission the agent has audited, reviewed for whether it needed to happen. The agent proposes; you decide what to escalate.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile n={rate === '—' ? '—' : `${rate}%`} k="30-day readmission rate (all IP stays)" />
        <Tile n={String(t?.readmissionCount ?? 0)} k="readmissions audited" />
        <Tile n={String(t?.inReviewLanes ?? 0)} k="unplanned, in scope to review (Lanes A + B)" />
        <Tile n={String(t?.outOfNetwork ?? 0)} k="out-of-network (patient readmitted elsewhere)" />
      </div>

      {err && <p className="mt-4 text-[12px] text-red-700">{err}</p>}
      {loading && !data && <p className="mt-6 text-[13px] text-slate-400">Loading…</p>}

      {data && data.pendingCount > 0 && (
        <p className="mt-3 text-[11.5px] text-slate-500">
          {data.pendingCount} finding{data.pendingCount === 1 ? '' : 's'} detected but not yet audited — they appear here once the sweep reaches them.
        </p>
      )}
      {data && data.total > 0 && !data.namesResolved && (
        <p className="mt-1 text-[11.5px] text-slate-500">
          Patient names are unavailable right now — cards are identified by UHID.
        </p>
      )}
      {data && data.total === 0 && !loading && (
        <p className="mt-6 text-[13px] text-slate-500">
          No audited findings yet{data.pendingCount > 0 ? ' — the sweep has not reached the detected ones.' : '.'}
        </p>
      )}

      {data?.lanes.map((g) => <LaneSection key={g.lane} g={g} />)}

      <p className="mt-7 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-slate-500">
        Advisory throughout — never a clinician score. The agent is a high-sensitivity screen: it surfaces what to look at and
        shows its evidence, never a verdict a doctor sees directly. Oncology, dialysis and obstetric readmissions are expected by
        design and held out of the review lanes.{' '}
        <b className="font-semibold text-slate-700">Escalation actions arrive in the next phase.</b> v1 is read-and-review.
      </p>
    </div>
  );
}
