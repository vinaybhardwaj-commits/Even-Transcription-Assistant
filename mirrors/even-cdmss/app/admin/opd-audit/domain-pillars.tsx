'use client';
import { useState } from 'react';
import Link from 'next/link';
import { scoreColor, bandColor, PDQI9_HELP } from '@/lib/opd-audit-ui';
import { bandFor } from '@/lib/opd-note-score-core';

export type DomainDatum = {
  key: string; label: string; short: string; score: number; weight: number; contribPts: number;
  trend: { d: string; v: number }[];
  drivers: { kind: 'count' | 'rating'; items: { label: string; value: number; pct: number }[] };
  topDoctors: { name: string; score: number; n: number }[];
  bottomDoctors: { name: string; score: number; n: number }[];
  best: { id: string; score: number } | null;
  worst: { id: string; score: number } | null;
  lever: string;
  coverage: { measured: number; total: number; basis: string };
};

const HOW: Record<string, string> = {
  documentation: 'Share of the seven NABH-OPD documentation items present on the note — presenting complaint, relevant history, diagnosis/impression, allergy status, complete medication dosing, advice, and follow-up. Read deterministically from the structured note, on every note.',
  note_quality: "The note's intrinsic quality on the validated PDQI-9 instrument — nine attributes (accurate, thorough, organized, synthesized, succinct …), each AI-rated 1–5 and rescaled to 0–100. Rated only on notes the model assessed; it never re-penalises missing sections — that is documentation's job.",
  appropriateness: 'Whether the tests, treatments and referrals fit the presentation — low-value or inappropriate orders are penalised (RAND / Choosing Wisely lens, with anti-anchoring on pre-test probability). AI-judged, grounded in the evidence corpus.',
  prescribing_safety: 'Rational, safe prescribing — generic naming, complete dosing and absence of duplication (deterministic) plus AI checks for irrational or unsafe drugs and interactions (WHO rational-prescribing & stewardship).',
  patient_centred: 'Continuity and patient-centredness — whether advice / safety-netting and a specified follow-up are documented (IOM patient-centred care). Deterministic.',
};
const SCALE = 'Scored 0–100 · bands A ≥85 · B ≥70 · C ≥55 · D ≥40 · E <40.';

// PDQI-9 attribute help now lives in lib/opd-audit-ui.ts (shared with the case-screen radar).

function Spark({ data, color }: { data: { d: string; v: number }[]; color: string }) {
  const W = 300, H = 46;
  if (data.length === 0) return <div className="text-[10.5px] text-slate-400">no history yet</div>;
  const vs = data.map((p) => p.v);
  const lo = Math.min(40, ...vs), hi = Math.max(85, ...vs);
  const pts = data.map((p, i) => {
    const x = data.length === 1 ? W : (i / (data.length - 1)) * W;
    const y = H - ((p.v - lo) / Math.max(1, hi - lo)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
      {data.map((p, i) => {
        const x = data.length === 1 ? W : (i / (data.length - 1)) * W;
        const y = H - ((p.v - lo) / Math.max(1, hi - lo)) * H;
        return <circle key={i} cx={x} cy={y} r="1.6" fill={color} />;
      })}
    </svg>
  );
}

function DocList({ title, rows }: { title: string; rows: { name: string; score: number; n: number }[] }) {
  return (
    <div className="flex-1">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">{title}</div>
      <div className="space-y-1">
        {rows.length === 0 && <div className="text-[11px] text-slate-400">—</div>}
        {rows.map((d, i) => (
          <div key={i} className="flex items-center justify-between text-[11.5px]">
            <span className="truncate pr-2 text-slate-700">{d.name} <span className="text-slate-400">· {d.n}</span></span>
            <span className="font-medium tabular-nums" style={{ color: scoreColor(d.score) }}>{d.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DomainPillars({ data, indexValue }: { data: DomainDatum[]; indexValue: number }) {
  const [open, setOpen] = useState<string>('');
  const [info, setInfo] = useState<{ key: string; x: number; y: number } | null>(null);
  const [attrTip, setAttrTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const D = data.find((d) => d.key === open) || null;

  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-5">
        {data.map((d) => (
          <div key={d.key} className="relative bg-white">
            <button
              aria-label={`How ${d.label} is measured`}
              onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setInfo(info?.key === d.key ? null : { key: d.key, x: r.right, y: r.bottom }); }}
              className="absolute right-2 top-2 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[9px] font-semibold text-slate-400 hover:border-brand hover:text-brand">i</button>
            <button onClick={() => setOpen(d.key)} className="block w-full px-3 py-3 text-left hover:bg-slate-50/60">
              <div className="min-h-[28px] pr-5 text-[10.5px] leading-tight text-slate-500">{d.label}</div>
              <div className="font-serif text-[22px] font-semibold" style={{ color: scoreColor(d.score) }}>{d.score}</div>
              <div className="mt-1.5 h-[5px] rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${d.score}%`, background: scoreColor(d.score) }} /></div>
            </button>
          </div>
        ))}
      </div>

      {/* info popover (fixed → escapes the grid clip) */}
      {info && (() => {
        const d = data.find((x) => x.key === info.key);
        if (!d) return null;
        const left = Math.min(info.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 20) - 260;
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setInfo(null)} />
            <div className="fixed z-50 w-[260px] rounded-lg border border-slate-200 bg-white p-3 shadow-pop" style={{ left: Math.max(12, left), top: info.y + 6 }}>
              <div className="text-[11.5px] font-semibold text-slate-800">{d.label}</div>
              <div className="mt-1 text-[11px] leading-snug text-slate-600">{HOW[d.key]}</div>
              <div className="mt-2 text-[10px] text-slate-400">{SCALE}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">Weight {Math.round(d.weight * 100)}% of the index · {d.coverage.basis}.</div>
            </div>
          </>
        );
      })()}

      {/* drill-down modal */}
      {D && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 sm:p-8" onClick={() => setOpen('')}>
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white shadow-pop" onClick={(e) => e.stopPropagation()}>
            {/* header */}
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
              <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl" style={{ background: scoreColor(D.score) + '18' }}>
                <span className="font-serif text-[20px] font-semibold" style={{ color: scoreColor(D.score) }}>{D.score}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-serif text-[16px] font-semibold text-slate-900">{D.label}</div>
                <div className="mt-0.5 text-[11.5px] text-slate-500">Weight {Math.round(D.weight * 100)}% · contributes ~{D.contribPts} pts to the index of {indexValue} · band <b style={{ color: bandColor(bandFor(D.score)) }}>{bandFor(D.score)}</b></div>
              </div>
              <button onClick={() => setOpen('')} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>

            <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
              {/* how measured */}
              <div className="rounded-lg bg-slate-50 px-3 py-2.5 text-[11.5px] leading-snug text-slate-600">
                {HOW[D.key]}
                <div className="mt-1.5 text-[10.5px] text-slate-400">{SCALE} · measured on <b>{D.coverage.measured}/{D.coverage.total}</b> notes ({D.coverage.basis}).</div>
              </div>

              {/* lever */}
              <div className="rounded-lg border border-brand/30 bg-brand-faint px-3 py-2 text-[11.5px] text-slate-700"><b className="text-brand">Biggest lever · </b>{D.lever}</div>

              {/* trend */}
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">This domain · last 14 days</div>
                <Spark data={D.trend} color={scoreColor(D.score)} />
              </div>

              {/* drivers */}
              {D.drivers.items.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">{D.drivers.kind === 'rating' ? "What's dragging it · PDQI-9 attributes (1–5)" : "What's dragging it"}</div>
                  <div className="space-y-1.5">
                    {D.drivers.items.slice(0, 8).map((it, i) => {
                      const help = D.drivers.kind === 'rating' ? PDQI9_HELP[it.label] : undefined;
                      return (
                      <div key={i} className={`flex items-center gap-2 text-[11.5px] ${help ? 'cursor-help' : ''}`}
                        onMouseEnter={help ? (e) => { const r = e.currentTarget.getBoundingClientRect(); setAttrTip({ label: it.label, x: r.left, y: r.bottom }); } : undefined}
                        onMouseLeave={help ? () => setAttrTip(null) : undefined}>
                        <span className={`flex-1 truncate ${help ? 'text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-2' : 'text-slate-700'}`}>{it.label}</span>
                        <span className="h-[5px] w-28 rounded bg-slate-100"><span className="block h-full rounded" style={{ width: `${it.pct}%`, background: D.drivers.kind === 'rating' ? scoreColor(it.pct) : '#d97706' }} /></span>
                        <span className="w-16 text-right tabular-nums text-slate-600">{D.drivers.kind === 'rating' ? `${it.value}/5` : `${it.value} · ${it.pct}%`}</span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* top / bottom doctors */}
              <div className="flex gap-5">
                <DocList title="Best doctors (≥5 notes)" rows={D.topDoctors} />
                <DocList title="Need support" rows={D.bottomDoctors} />
              </div>

              {/* best / worst example */}
              <div className="flex gap-3 text-[11.5px]">
                {D.best && <Link href={`/admin/opd-audit/${D.best.id}`} onClick={() => setOpen('')} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 hover:border-brand"><span className="text-slate-400">Best example · </span><b style={{ color: scoreColor(D.best.score) }}>{D.best.score}</b> <span className="text-brand">open ›</span></Link>}
                {D.worst && <Link href={`/admin/opd-audit/${D.worst.id}`} onClick={() => setOpen('')} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 hover:border-brand"><span className="text-slate-400">Worst example · </span><b style={{ color: scoreColor(D.worst.score) }}>{D.worst.score}</b> <span className="text-brand">open ›</span></Link>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PDQI-9 attribute hover tooltip — auditor definition only. Governance actions live in
          /api/governance/opd-signals (→ governance app); EMR capture cues live in the design report. */}
      {attrTip && PDQI9_HELP[attrTip.label] && (
        <div className="pointer-events-none fixed z-[60] w-[300px] rounded-lg border border-slate-200 bg-white p-3 shadow-pop"
          style={{ left: Math.min(Math.max(12, attrTip.x), (typeof window !== 'undefined' ? window.innerWidth : 1200) - 312), top: attrTip.y + 6 }}>
          <div className="text-[11.5px] font-semibold text-slate-800">{attrTip.label} <span className="font-normal text-slate-400">· PDQI-9</span></div>
          <div className="mt-1 text-[11px] leading-snug text-slate-600">{PDQI9_HELP[attrTip.label].def}</div>
        </div>
      )}
    </>
  );
}
