/**
 * Right Care day-rate tile (RIGHT-CARE-INDICATOR-PRD §7). Overview top-row tile: the big day LVC-note
 * rate, Δ vs the 14-day mean, a 14-day sparkline, and 4 category chips linking to #notes. Advisory —
 * amber/neutral/emerald only (red is reserved for individual findings, decision 11). Presentational
 * server component; data comes from fetchRightCareDay(). SVG sparkline, no chart libs.
 */
import type { RightCareDay } from '@/lib/opd-audit-doctor';
import { fmtIstDateLong } from '@/lib/opd-audit-ui';
import { LVC_CATEGORY_LABELS } from '@/lib/opd-lvc-classify-core';

const pct = (x: number): string => `${Math.round(x * 100)}%`;
// 0.81.8 Decision 10 — shared labels so the new overuse sub-tags render (local short overrides retained).
const CAT_LABEL: Record<string, string> = {
  ...LVC_CATEGORY_LABELS, supplement_polypharmacy: 'Supplement', other: 'Other',
};

/** amber = elevated utilization, emerald = low, neutral otherwise (advisory bands, not a scorecard). */
function rateTone(rate: number): { text: string; bg: string } {
  if (rate >= 0.5) return { text: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' };
  if (rate <= 0.3) return { text: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' };
  return { text: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' };
}

function Sparkline({ trend }: { trend: { rate: number }[] }) {
  if (trend.length < 2) return null;
  const w = 120, h = 28, max = Math.max(0.01, ...trend.map((t) => t.rate));
  const pts = trend.map((t, i) => {
    const x = (i / (trend.length - 1)) * w;
    const y = h - (t.rate / max) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" role="img" aria-label="14-day trend">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function RightCareTile({ data }: { data: RightCareDay }) {
  if (!data || data.total === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-400">
        Right Care · no banded audited notes yet today.
      </div>
    );
  }
  const tone = rateTone(data.rate);
  const delta = data.rate - data.mean14;
  // §8 / decision 24: chips with count 0 are HIDDEN (the split query only returns categories present
  // on the headline day, so this is those with notes > 0), ordered by count.
  const chips = data.categories.filter((c) => c.notes > 0);
  return (
    <div className={`rounded-xl border ${tone.bg} px-4 py-3`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Right Care · low-value actions</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className={`text-[26px] font-semibold leading-none ${tone.text}`}>{pct(data.rate)}</span>
            <span className="text-[11.5px] text-slate-500">of {data.total} notes · {data.day ? fmtIstDateLong(data.day) : '—'}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {Math.abs(delta) < 0.005 ? 'at' : delta > 0 ? '▲' : '▼'} {pct(Math.abs(delta))} vs 14-day mean {pct(data.mean14)}
          </div>
        </div>
        <div className={tone.text}><Sparkline trend={data.trend} /></div>
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <a key={c.category} href="#notes"
              className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10.5px] font-medium text-slate-600 hover:border-slate-400">
              {CAT_LABEL[c.category] || c.category} <span className="tabular-nums">{c.notes}</span>
            </a>
          ))}
        </div>
      )}
      <p className="mt-2 text-[10.5px] leading-snug text-slate-400">
        Low-value actions per Choosing Wisely / NCG rules. Advisory — a utilization pattern, not a scorecard.
      </p>
    </div>
  );
}
