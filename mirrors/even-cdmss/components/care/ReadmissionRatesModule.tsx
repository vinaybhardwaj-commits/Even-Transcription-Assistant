'use client';
/**
 * components/care/ReadmissionRatesModule.tsx — the RATES MODULE at the top of /care/readmissions
 * (CDMSS-READMISSIONS-R7-PRD v1.0, R7-1 … R7-4): five metric cards · the denominator selector (default
 * Eligible; "All in window" carries its understates warning) · monthly trend bars split reviewable vs
 * held-out with censored months as dashed ghosts · facility tabs (honouring R6's hospital filter when
 * one is set) · the this-hospital-only footnote with a pointer to the definitions doc · computed-at.
 *
 * Its own fetch of /api/care/readmissions/rates, independent of the card list: a rates fault shows
 * "rates unavailable right now" inside the module and the board is unaffected. Every number comes from
 * the pure core (readmission-rates-core) — nothing is computed here beyond bar heights.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DENOMINATOR, DENOMINATORS, DENOMINATOR_LABEL, EHBR_GATE_COPY, RATES_UNAVAILABLE_COPY, THIS_HOSPITAL_ONLY_FOOTNOTE,
  computedAtLabel, judgementStatsLine, moduleFacility, rateCards, trendBars, type DenominatorKey, type RatesResult,
} from '@/lib/readmission-rates-core';

type RatesPayload = { ok: true; rates: RatesResult; computedAt: string; cached: boolean } | { ok: false; error?: string; reason?: string; computedAt?: string };

export default function ReadmissionRatesModule({ facility }: { facility: string | null }) {
  const [payload, setPayload] = useState<RatesPayload | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [denom, setDenom] = useState<DenominatorKey>(DEFAULT_DENOMINATOR);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 45_000);
    fetch('/api/care/readmissions/rates', { signal: ctrl.signal })
      .then((r) => r.json() as Promise<RatesPayload>)
      .then((j) => { if (alive) setPayload(j && typeof j === 'object' ? j : { ok: false }); })
      .catch(() => { if (alive) setPayload({ ok: false }); })
      .finally(() => clearTimeout(killer));
    return () => { alive = false; ctrl.abort(); };
  }, []);

  const rates = payload?.ok ? payload.rates : null;
  const fac = useMemo(() => (rates ? moduleFacility(rates, facility, tab) : null), [rates, facility, tab]);
  const cards = useMemo(() => (fac ? rateCards(fac, denom) : []), [fac, denom]);
  const bars = useMemo(() => (fac ? trendBars(fac) : []), [fac]);
  const maxPct = useMemo(() => Math.max(2, ...bars.map((b) => (b.reviewablePct ?? 0) + (b.heldOutPct ?? 0))), [bars]);
  const warning = fac?.denominators[denom].warning ?? null;

  return (
    <section className="mt-4 rounded-xl border border-line bg-paper p-4 shadow-card" aria-label="Readmission rates">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13.5px] font-semibold text-slate-900">Return rates</h2>
        <span className="rounded-full bg-brand-faint px-2 py-0.5 text-[10.5px] font-medium text-brand-dark">this hospital only</span>
        {/* R7-4 — facility tabs. When the R6 hospital filter names a hospital the tabs follow it. */}
        {rates && rates.facilities.length > 1 && (
          <span className="ml-2 flex overflow-hidden rounded-lg border border-line text-[11px]">
            {rates.facilities.map((f) => (
              <button key={f.facility} type="button" onClick={() => setTab(f.facility)} disabled={!!facility && facility !== f.facility}
                title={facility && facility !== f.facility ? 'The hospital filter above is set — clear it to switch' : undefined}
                className={`px-2.5 py-1 ${fac?.facility === f.facility ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50 disabled:text-slate-300 disabled:hover:bg-white'}`}>
                {f.facility}
              </button>
            ))}
          </span>
        )}
        {/* R7-2 — the denominator selector, visible: the choice is the point. */}
        {rates && (
          <select value={denom} onChange={(e) => setDenom(e.target.value as DenominatorKey)}
            className="ml-auto rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600" title="Denominator">
            {DENOMINATORS.map((k) => <option key={k} value={k}>{DENOMINATOR_LABEL[k]}</option>)}
          </select>
        )}
      </div>
      {warning && <p className="mt-1.5 text-[11.5px] font-medium text-amber-800">⚠ {warning}</p>}
      {fac && !fac.ratesAllowed && (
        <p className="mt-1.5 text-[11.5px] text-slate-600">
          {fac.facility}: {EHBR_GATE_COPY}{fac.gate.opensOn ? ` (first full month ${fac.gate.firstFullMonth} · rates from ${fac.gate.opensOn})` : ''}
        </p>
      )}

      {payload == null && <p className="mt-3 text-[12px] text-slate-400">Computing rates…</p>}
      {payload != null && !payload.ok && <p className="mt-3 text-[12px] text-slate-500">{RATES_UNAVAILABLE_COPY}</p>}

      {fac && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            {cards.map((c) => (
              <div key={c.key} className={`rounded-lg border p-2.5 ${c.tone === 'advisory' ? 'border-dashed border-amber-300 bg-amber-50/40' : 'border-line bg-white'}`}>
                <div className="text-[10.5px] uppercase tracking-wide text-slate-500">{c.title}</div>
                <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-slate-900">{c.big}</div>
                {c.ci && <div className="text-[10.5px] tabular-nums text-slate-500">95% CI {c.ci}</div>}
                <div className="mt-0.5 text-[11px] text-slate-600">{c.sub}</div>
                {c.advisory && <div className="mt-1 text-[10.5px] font-medium italic text-amber-800">{c.advisory}</div>}
              </div>
            ))}
          </div>

          {/* Monthly trend — complete months as split bars (reviewable / held-out, stacked to the month's
              all-cause 30-day rate); incomplete months as dashed ghosts with counts only. */}
          {bars.length > 0 && (
            <div className="mt-3">
              <div className="flex items-end gap-1.5" style={{ height: 72 }}>
                {bars.map((b) => {
                  const live = b.reviewablePct != null;
                  const rH = live ? Math.max(1, Math.round(((b.reviewablePct ?? 0) / maxPct) * 60)) : 0;
                  const hH = live ? Math.round(((b.heldOutPct ?? 0) / maxPct) * 60) : 0;
                  return (
                    <div key={b.month} className="flex flex-1 flex-col items-center justify-end" title={b.title}>
                      {live ? (
                        <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: rH + hH }}>
                          <div className="w-full bg-slate-300" style={{ height: hH }} />
                          <div className="w-full bg-brand" style={{ height: rH }} />
                        </div>
                      ) : (
                        <div className="w-full rounded-t border border-dashed border-slate-300" style={{ height: 24 }} />
                      )}
                      <div className={`mt-1 text-[9.5px] ${live ? 'text-slate-500' : 'text-slate-400 italic'}`}>{b.label}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[10.5px] text-slate-500">
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand align-middle" />reviewable</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-300 align-middle" />held-out (oncology · dialysis · obstetric)</span>
                <span><i className="mr-1 inline-block h-2 w-3 rounded-sm border border-dashed border-slate-300 align-middle" />30-day follow-up not complete — counts only</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* R7-7 — judgement stats with condition-pass-only audits labelled, never "no judgement". */}
      {fac && <p className="mt-2.5 text-[11px] text-slate-600">Judgements — {judgementStatsLine(fac.judgements)}</p>}

      <p className="mt-3 text-[10.5px] leading-relaxed text-slate-500">
        {THIS_HOSPITAL_ONLY_FOOTNOTE}
        {payload?.ok && <span className="ml-1 text-slate-400">· {computedAtLabel(payload.computedAt)}{payload.cached ? ' (cached)' : ''}</span>}
      </p>
    </section>
  );
}
