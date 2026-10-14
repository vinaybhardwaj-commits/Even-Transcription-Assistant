'use client';

/**
 * /care/readmissions/case/[key] — the R4 case page (CDMSS-READMISSIONS-R4-PRD v1.0 §1, R4-1..R4-9).
 * Top to bottom: the card header (identity KX-first, path, situation, chips) · WHY THIS CASE WAS
 * FLAGGED (assembled by code, no model) · THE AGENT'S ACCOUNT (the stored audit-time narrative,
 * rendered ONLY when code marked its citations valid; every marker is a link to its ledger row) ·
 * THE EVIDENCE LEDGER (every item the audit read — R4.2: source / stay / written-by in plain words
 * with a legend, and a date that never dashes; plus looked-for-and-not-found) · PRIOR FINDINGS RELATED TO THIS RETURN (relevance-filtered, the denominator on every
 * render) · THE MONEY (judgements + both bills, R3) · the download button · ASK THE AGENT (R4.3 — a
 * conversation fenced to this case's stored material, citations checked by code, ephemeral).
 *
 * READ-ONLY, RENDERS STORED ARTEFACTS ONLY (R4-2 / R4-9): two fetches — the case route (the pinned
 * finding + artefacts + bills) and the list route (the KX identity the board already resolved,
 * decision 13 — the case route does not re-join it). No model call, no write, no escalate control,
 * no external links in v1. Everything it decides comes from lib/readmission-surface-core.ts and
 * lib/readmission-narrative-core.ts so it is unit-tested; this file is markup and fetch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, RotateCw } from 'lucide-react';
import {
  cardIdentityLine, chipText, coverageChips, judgementLabel, justificationCell, NEGLIGENCE_ADVISORY,
  pathSegments, returnStayBill, returnStayBillSub, situationLine, formatBillRs, narrativeStateCopy,
  ledgerSourceLabel, ledgerSideLabel, ledgerWeightLabel, ledgerDateLabel, LEDGER_LEGEND,
  type ChipState, type LaneGroup, type SurfaceFinding,
} from '@/lib/readmission-surface-core';
import { denominatorLine, relatedLvcCopy, segmentNarrative } from '@/lib/readmission-narrative-core';
import { returnContextLines } from '@/lib/readmission-rates-core';
import { ASK_ADVISORY, ASK_PER_LOAD_LIMIT, ASK_QUESTION_MAX_CHARS, ASK_SUGGESTIONS, ASK_WORKING_COPY, ASK_WITHHELD_COPY, type AskTurn } from '@/lib/readmission-ask-core';
import type { BillBreakdown, ExtractSubset } from '@/lib/readmission/brief';
import { downloadBrief } from './ReadmissionsBoard';

type LedgerItem = { id: string; source: string; side: string | null; at: string | null; weight: string; text: string; abnormal?: boolean | null };
type RelatedItem = { noteUid: string; noteDate: string | null; concept: string; lvcCategory: string | null; engineVersion: string | null; reviewStatus: string; reason: string; priorEvidence: string; readmitEvidenceIds: string[] };
type CasePayload = {
  ok: boolean;
  error?: string;
  engineVersion?: string;
  row: SurfaceFinding;
  indexExtract: ExtractSubset | null;
  readmitExtract: ExtractSubset | null;
  indexBill?: BillBreakdown | null;
  readmitBill?: BillBreakdown | null;
  whyFlagged?: string[];
  evidenceLedger?: { version?: string; items?: LedgerItem[]; generatedAt?: string; source?: string } | null;
  caseNarrative?: { text: string; citedIds: string[]; generatedAt: string; model: string; provider: string; version: string; source: string } | null;
  narrativeState?: 'absent' | 'invalid' | 'valid';
  narrativeMeta?: { generatedAt?: string; model?: string; provider?: string; version?: string; source?: string; invalidReason?: string | null } | null;
  relatedLvc?: { state: 'present' | 'none_related' | 'no_audited_artefacts' | 'join_failed'; audited: number; totalNotes: number; items: RelatedItem[]; droppedProposals?: number; joinFailure?: string | null; generatedAt?: string } | null;
};
type ListPayload = { ok: boolean; lanes: LaneGroup[] };

const CHIP_STATE: Record<ChipState, string> = {
  present: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  empty: 'bg-transparent text-amber-800 border border-amber-300',
  absent: 'bg-transparent text-slate-600 border border-slate-300',
  unknown: 'bg-transparent text-slate-500 border border-slate-200 border-dashed',
  'n/a': 'bg-slate-50 text-slate-400 border border-slate-100 line-through',
};
const WEIGHT_TONE: Record<string, string> = {
  disinterested: 'text-emerald-800 bg-emerald-50 border-emerald-200',
  interested: 'text-amber-800 bg-amber-50 border-amber-200',
  neither: 'text-slate-600 bg-slate-50 border-slate-200',
};
const REVIEW_WORD: Record<string, string> = {
  unreviewed: 'unreviewed', true_positive: 'reviewed · true positive', nitpick: 'reviewed · nitpick', false: 'reviewed · false', contested: 'reviewed · contested',
};

function Cell({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-slate-500">{k}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-slate-900">{v}</div>
      {sub && <div className="mt-0.5 text-[10.5px] italic text-slate-500">{sub}</div>}
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-6 rounded-xl border border-line bg-paper p-4 shadow-card">
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function CiteLink({ id, known, onJump }: { id: string; known: boolean; onJump: (id: string) => void }) {
  return known ? (
    <button type="button" onClick={() => onJump(id)}
      className="mx-0.5 rounded border border-brand/30 bg-brand-faint px-1 py-0 font-mono text-[11px] text-brand-dark hover:bg-brand/10">{id}</button>
  ) : (
    <span className="mx-0.5 rounded border border-red-200 bg-red-50 px-1 py-0 font-mono text-[11px] text-red-700" title="not in the ledger">{id}</span>
  );
}

function BillTable({ heading, bill }: { heading: string; bill: BillBreakdown | null | undefined }) {
  if (!bill || !bill.ok) return <p className="text-[12px] text-slate-500">{heading}: not available</p>;
  if (bill.lines <= 0 || !bill.groups.length) return <p className="text-[12px] text-slate-500">{heading}: bill not finalised</p>;
  return (
    <div>
      <div className="text-[12px] font-medium text-slate-700">{heading} <span className="font-normal text-slate-500">· {bill.lines} line(s) · hospital bill, db13</span></div>
      <table className="mt-1 w-full text-[12px]">
        <tbody>
          {bill.groups.map((g) => (
            <tr key={g.serviceType} className="border-t border-line"><td className="py-0.5 pr-3 text-slate-700">{g.serviceType}</td><td className="py-0.5 text-right tabular-nums text-slate-900">{formatBillRs(g.netRs)}</td></tr>
          ))}
          <tr className="border-t border-line font-semibold"><td className="py-0.5 pr-3">Total</td><td className="py-0.5 text-right tabular-nums">{formatBillRs(bill.totalRs)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

type AskResponse = { ok: boolean; error?: string; withheld?: boolean; reason?: string; copy?: string; answer?: string; citedIds?: string[]; answerable?: boolean; cost?: { usd: number } | null };
type AskEntry = { question: string; answer: string | null; citedIds: string[]; withheld: boolean; copy?: string };

/**
 * R4.3 — ASK THE AGENT (R43-1..R43-8). The conversation's whole world is this case's stored material
 * (the route enforces that); it is EPHEMERAL — component state only, gone on reload; the last ≤ 6
 * turns go back as context. Every answer arrives with code-checked citations rendered as the same
 * clickable tags the account uses (jump to the ledger row); a withheld answer shows the honest copy.
 * Question length capped; ASK_PER_LOAD_LIMIT questions per page load (builder's proposal, flagged).
 */
function AskTheAgent({ dedupKey, known, onJump }: { dedupKey: string; known: Set<string>; onJump: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<AskEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const left = Math.max(0, ASK_PER_LOAD_LIMIT - entries.length);

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || busy || left <= 0) return;
    setBusy(true); setErr(null);
    const history: AskTurn[] = entries.filter((e) => !e.withheld && e.answer).slice(-6).map((e) => ({ question: e.question, answer: e.answer! }));
    try {
      const r = await fetch('/api/care/readmissions/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dedup_key: dedupKey, question: text, history }),
      });
      const j = (await r.json()) as AskResponse;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      if (j.withheld) setEntries((xs) => [...xs, { question: text, answer: null, citedIds: [], withheld: true, copy: j.copy ?? ASK_WITHHELD_COPY }]);
      else setEntries((xs) => [...xs, { question: text, answer: j.answer ?? '', citedIds: j.citedIds ?? [], withheld: false }]);
      setQ('');
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }, [busy, dedupKey, entries, left]);

  return (
    <div>
      {entries.length > 0 && (
        <div className="mb-3 space-y-3">
          {entries.map((e, i) => (
            <div key={i}>
              <div className="text-[12.5px] font-medium text-slate-800">Q · {e.question}</div>
              {e.withheld
                ? <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{e.copy ?? ASK_WITHHELD_COPY}</div>
                : (
                  <div className="mt-1 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-slate-800">
                    {segmentNarrative(e.answer ?? '').map((seg, si) => seg.kind === 'text'
                      ? <span key={si}>{seg.text}</span>
                      : <span key={si}>[{seg.ids.map((id, k) => <span key={id}>{k > 0 && ','}<CiteLink id={id} known={known.has(id)} onJump={onJump} /></span>)}]</span>)}
                    {e.citedIds.length === 0 && <div className="mt-1 text-[10.5px] italic text-slate-500">the case record does not answer this — nothing to cite</div>}
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
      {busy && <p className="mb-2 text-[12px] italic text-slate-500">{ASK_WORKING_COPY}</p>}
      {err && <p className="mb-2 text-[12px] text-red-700">{err}</p>}
      <div className="flex flex-wrap gap-1.5">
        {ASK_SUGGESTIONS.map((sug) => (
          <button key={sug} type="button" disabled={busy || left <= 0} onClick={() => void ask(sug)}
            className="rounded-full border border-line bg-white px-2.5 py-0.5 text-[11.5px] text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">{sug}</button>
        ))}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
        <input type="text" value={q} maxLength={ASK_QUESTION_MAX_CHARS} disabled={busy || left <= 0}
          onChange={(e) => setQ(e.target.value)}
          placeholder={left <= 0 ? `Question limit reached for this page load (${ASK_PER_LOAD_LIMIT}) — reload to ask more` : 'Ask about this case — answered only from its stored evidence'}
          className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] text-slate-800 disabled:bg-slate-50 disabled:text-slate-400" />
        <button type="submit" disabled={busy || left <= 0 || !q.trim()}
          className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">Ask</button>
      </form>
      <p className="mt-2 text-[10.5px] italic text-slate-500">{ASK_ADVISORY} · {left} of {ASK_PER_LOAD_LIMIT} questions left on this page load · the conversation is not saved</p>
    </div>
  );
}

export default function ReadmissionCasePage({ dedupKey }: { dedupKey: string }) {
  const [data, setData] = useState<CasePayload | null>(null);
  const [card, setCard] = useState<SurfaceFinding | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [cr, lr] = await Promise.all([
        fetch(`/api/care/readmissions/case?dedup_key=${encodeURIComponent(dedupKey)}`),
        fetch('/api/care/readmissions/list').catch(() => null),
      ]);
      const cj = (await cr.json()) as CasePayload;
      if (!cr.ok || !cj.ok) throw new Error(String(cj.error || `status ${cr.status}`));
      setData(cj);
      if (lr && lr.ok) {
        const lj = (await lr.json()) as ListPayload;
        const found = (lj.lanes ?? []).flatMap((g) => g.rows).find((r) => r.dedupKey === dedupKey) ?? null;
        setCard(found);
      }
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [dedupKey]);

  useEffect(() => { void load(); }, [load]);

  // Decision 13 overlay (identical to the board's brief path): the KX identity from the list, the
  // fresher returnBill from the case route.
  const row: SurfaceFinding | null = useMemo(() => {
    if (!data?.row) return null;
    return card
      ? { ...data.row, patientName: card.patientName, ageGender: card.ageGender ?? data.row.ageGender ?? null, indexCase: data.row.indexCase ?? card.indexCase ?? null, returnBill: data.row.returnBill ?? card.returnBill ?? null, facility: card.facility ?? data.row.facility ?? null }
      : data.row;
  }, [data, card]);

  const ledger = data?.evidenceLedger?.items ?? [];
  const known = useMemo(() => new Set(ledger.map((i) => i.id)), [ledger]);
  const jump = useCallback((id: string) => {
    setHighlight(id);
    document.getElementById(`ev-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const narrState = data ? narrativeStateCopy(data.narrativeState === 'valid' && data.caseNarrative ? { ...data.caseNarrative, valid: true } : data.narrativeState === 'invalid' ? { valid: false, text: '' } : undefined) : null;
  const refusals = (row?.finding?.refusalRecord ?? []).filter((r) => r.found === false);

  return (
    <div className="mx-auto max-w-content px-5 py-7">
      <div className="mb-3.5 text-[12px] text-slate-500">
        <Link href="/care" className="font-medium text-brand">Managed Care</Link> › <Link href="/care/readmissions" className="font-medium text-brand">Readmissions</Link> › Case
      </div>

      {err && <p className="mt-4 text-[12px] text-red-700">{err}</p>}
      {loading && !data && <p className="mt-6 text-[13px] text-slate-400">Loading…</p>}

      {row && data && (
        <>
          {/* Header — the card, verbatim helpers */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-serif text-[21px] font-semibold tracking-tight text-slate-900">
                {cardIdentityLine(row)}
                {/* R6.1 (R61-3): the hospital, the same verbatim value the list card shows (it rides the list's
                    identity overlay — the case route does no identity join, decision 13); nothing when unknown */}
                {row.facility && <span className="ml-2 text-[12px] font-sans font-normal text-slate-500">· {row.facility}</span>}
              </h1>
              <div className="mt-1 text-[12.5px] text-slate-600">
                {pathSegments(row).map((seg, i) => (
                  <span key={i}>{i > 0 && ' · '}{i === 0 ? <b className="font-semibold text-slate-900">{seg}</b> : seg}</span>
                ))}
              </div>
              {situationLine(row) && <div className="mt-1 text-[12px] font-medium text-red-700">{situationLine(row)}</div>}
              {/* R7 (R7-5 / R7-6) — the card's return-context markers, echoed; annotation only. */}
              {returnContextLines(row.returnContext).map((l) => (
                <div key={l.key} className="mt-1 text-[12px] font-medium text-amber-800">{l.text}</div>
              ))}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {coverageChips(row).map((c) => (
                  <span key={c.key} title={`${c.label}: ${c.state}`} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP_STATE[c.state]}`}>{chipText(c)}</span>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={() => void load()} disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                <RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Refresh
              </button>
              <button type="button" disabled={busy}
                onClick={() => { setBusy(true); void downloadBrief(row).finally(() => setBusy(false)); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">
                <Download className="h-3 w-3" />Download case brief · .md
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11.5px] text-slate-500">Advisory · care management · engine {data.engineVersion ?? 'unknown'} · nothing on this page changes a finding</p>

          {/* Why flagged — code, no model */}
          <Section title="Why this case was flagged">
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-slate-700">
              {(data.whyFlagged ?? []).map((l, i) => <li key={i}>{l}</li>)}
            </ul>
            <p className="mt-2 text-[10.5px] italic text-slate-500">assembled from the detection facts on the finding row — no model</p>
          </Section>

          {/* The agent's account — stored, cited, code-validated */}
          <Section title="The agent's account">
            {data.narrativeState === 'valid' && data.caseNarrative ? (
              <>
                <div className="space-y-3 text-[13px] leading-relaxed text-slate-800">
                  {data.caseNarrative.text.split(/\n{2,}/).map((para, pi) => (
                    <p key={pi}>
                      {segmentNarrative(para).map((seg, si) => seg.kind === 'text'
                        ? <span key={si}>{seg.text}</span>
                        : <span key={si}>[{seg.ids.map((id, k) => <span key={id}>{k > 0 && ','}<CiteLink id={id} known={known.has(id)} onJump={jump} /></span>)}]</span>)}
                    </p>
                  ))}
                </div>
                <p className="mt-3 text-[10.5px] italic text-slate-500">
                  Written {data.caseNarrative.generatedAt} · {data.caseNarrative.version} · {data.caseNarrative.provider}:{data.caseNarrative.model} · {data.caseNarrative.source === 'backfill' ? 'written by the backfill' : 'written at audit'} · {data.caseNarrative.citedIds.length} citation{data.caseNarrative.citedIds.length === 1 ? '' : 's'}, every one resolved by code
                </p>
              </>
            ) : (
              <p className="text-[12.5px] text-slate-500">
                {narrState?.copy}
                {data.narrativeState === 'invalid' && data.narrativeMeta && (
                  <span className="text-slate-400"> ({data.narrativeMeta.invalidReason ?? 'unresolved'} · written {data.narrativeMeta.generatedAt} · {data.narrativeMeta.provider}:{data.narrativeMeta.model})</span>
                )}
              </p>
            )}
          </Section>

          {/* Evidence ledger */}
          <Section title="The evidence ledger" id="ledger">
            {ledger.length ? (
              <>
                <p className="mb-2 text-[11.5px] text-slate-500">
                  {ledger.length} item{ledger.length === 1 ? '' : 's'} the audit read · {data.evidenceLedger?.source === 'reassembled' ? 're-assembled by the backfill from db13' : 'the catalog the audit legs read'} · {data.evidenceLedger?.generatedAt}
                </p>
                {/* R42-3 — the legend: what the weight column means, in one line */}
                <p className="mb-2 text-[11.5px] italic text-slate-600">{LEDGER_LEGEND}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-slate-500"><th className="py-1 pr-2">id</th><th className="py-1 pr-2">source</th><th className="py-1 pr-2">stay</th><th className="py-1 pr-2">written by</th><th className="py-1 pr-2">date</th><th className="py-1">text</th></tr></thead>
                    <tbody>
                      {ledger.map((it) => (
                        <tr key={it.id} id={`ev-${it.id}`} className={`border-t border-line align-top ${highlight === it.id ? 'bg-brand-faint' : ''}`}>
                          <td className="py-1 pr-2 font-mono text-[11px] text-slate-700">{it.id}</td>
                          {/* R42-1/2/3/4 — words, never enums; a date always (item's own, else the stay fallback) */}
                          <td className="py-1 pr-2 whitespace-nowrap text-slate-700">{ledgerSourceLabel(it.source, it.id)}</td>
                          <td className="py-1 pr-2 whitespace-nowrap text-slate-600">{ledgerSideLabel(it.side)}</td>
                          <td className="py-1 pr-2"><span className={`rounded border px-1 text-[10.5px] ${WEIGHT_TONE[it.weight] ?? WEIGHT_TONE.neither}`}>{ledgerWeightLabel(it.weight)}</span></td>
                          <td className="py-1 pr-2 whitespace-nowrap text-slate-600">{ledgerDateLabel(it, row)}</td>
                          <td className="py-1 text-slate-800">{it.text}{it.abnormal === true && <span className="ml-1 rounded bg-red-50 px-1 text-[10px] text-red-700">abnormal</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <p className="text-[12.5px] text-slate-500">No evidence ledger stored for this case yet — it is written with the account.</p>}
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Looked for and not found</div>
              {refusals.length
                ? <ul className="mt-1 list-disc pl-5 text-[12px] text-slate-700">{refusals.map((r, i) => <li key={i}>{r.lookedFor ?? 'unknown'}{r.note ? ` — ${r.note}` : ''}</li>)}</ul>
                : <p className="mt-1 text-[12px] text-slate-500">{row.auditStatus === 'audited' ? 'Nothing recorded as looked-for-and-absent' : 'unknown'}</p>}
            </div>
          </Section>

          {/* Prior findings related to this return — the denominator on EVERY render */}
          <Section title="Prior findings related to this return">
            {data.relatedLvc ? (
              <>
                <p className="text-[12.5px] font-medium text-slate-800">{relatedLvcCopy(data.relatedLvc)}</p>
                <p className="mt-0.5 text-[11.5px] text-slate-500">{denominatorLine(data.relatedLvc)} · latest audit per note{data.relatedLvc.state === 'join_failed' && data.relatedLvc.joinFailure ? ` · join failed at: ${data.relatedLvc.joinFailure}` : ''}</p>
                {data.relatedLvc.state === 'present' && (
                  <ul className="mt-2 space-y-2">
                    {data.relatedLvc.items.map((it) => (
                      <li key={`${it.noteUid}#${it.priorEvidence}`} className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px]">
                        <div className="font-semibold text-slate-900">{it.concept}{it.lvcCategory ? <span className="ml-1 font-normal text-slate-500">· {it.lvcCategory}</span> : null}</div>
                        <div className="text-[11.5px] text-slate-500">OPD note {it.noteDate ? it.noteDate.slice(0, 10) : 'undated'} · {REVIEW_WORD[it.reviewStatus] ?? it.reviewStatus}{it.engineVersion ? ` · ${it.engineVersion}` : ''}</div>
                        <div className="mt-1 text-slate-700">{it.reason}</div>
                        <div className="mt-1 text-[11.5px] text-slate-500">connects to {it.readmitEvidenceIds.map((id) => <CiteLink key={id} id={id} known={known.has(id)} onJump={jump} />)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : <p className="text-[12.5px] text-slate-500">unknown — no prior-findings selection stored for this case yet (it is written with the account).</p>}
            <p className="mt-2 text-[10.5px] italic text-slate-500">absence of flags is never clean care — most notes are un-audited; only concept labels, dates and review status are shown here, never note text</p>
          </Section>

          {/* The money — judgements + both bills (R3) */}
          <Section title="The money">
            {row.auditStatus === 'audited' ? (
              <div className="grid grid-cols-2 gap-2">
                <Cell k="Medical justification" v={justificationCell(row)} />
                <Cell k="Preventable injury" v={judgementLabel(row.preventableInjury)} />
                <Cell k="Negligence" v={judgementLabel(row.negligence)} sub={NEGLIGENCE_ADVISORY} />
                <Cell k="Return stay bill" v={returnStayBill(row)} sub={returnStayBillSub(row)} />
              </div>
            ) : <p className="text-[12px] text-slate-500">Not yet audited</p>}
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              <BillTable heading="Index stay bill" bill={data.indexBill} />
              {row.findingClass === 'even_even' ? <BillTable heading="Return stay bill" bill={data.readmitBill} /> : <p className="text-[12px] text-slate-500">Return stay bill: n/a</p>}
            </div>
            <p className="mt-2 text-[10.5px] italic text-slate-500">hospital bill · net of refunds · fresh at load · [hospital bill, db13]</p>
          </Section>

          {/* R4.3 (R43-7) — ask the agent: a conversation fenced to this case's stored material */}
          <Section title="Ask the agent">
            <AskTheAgent dedupKey={dedupKey} known={known} onJump={jump} />
          </Section>

          <p className="mt-7 border-t border-line pt-3.5 text-[11.5px] leading-relaxed text-slate-500">
            Advisory throughout — never a clinician score, never a court or council finding. The account above was written once, at audit time, from the evidence ledger, and every citation in it was checked by code before it was shown. Nothing on this page changes a finding.
          </p>
        </>
      )}
    </div>
  );
}
