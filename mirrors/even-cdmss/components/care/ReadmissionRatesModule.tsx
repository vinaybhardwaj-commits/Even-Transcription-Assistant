'use client';
/**
 * components/care/ReadmissionRatesModule.tsx — the RATES MODULE at the top of /care/readmissions
 * (CDMSS-READMISSIONS-R7-PRD v1.0, R7-1 … R7-4): five metric cards · the denominator selector (default
 * Eligible; "All in window" carries its understates warning) · monthly trend bars split reviewable vs
 * held-out with censored months as dashed ghosts · facility tabs (honouring R6's hospital filter when
 * one is set) · the this-hospital-only footnote with a pointer to the definitions doc · computed-at.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT-PRD-27-AUG-2026-GO §12.2, D2 / D8, L1) republishes the strip
 * as TWO contracts from one spine, and the copy is the deliverable:
 *   · the LEAD is CAT incidence — unique PEOPLE, clock ≥24h and ≤30d, onco and ObGyn excluded — and it
 *     carries the neonate / ophthal footnote. When the distinct-people denominator cannot be read it
 *     says so and shows nothing (T5): a people rate is never printed off a stays denominator.
 *   · the SECONDARY is today's Eligible episode rate, unchanged arithmetic, labelled as stays.
 *   · the reviewable peer card is GONE (D8 / §3.3). CAT's 45 and revenue's 45 are two different 45s,
 *     so it must not sit next to incidence as though the two boards agreed. Hold-out lives on as the
 *     board's list filter, where it belongs.
 * Every number still comes from the pure core; nothing is computed here beyond bar heights.
 *
 * Its own fetch of /api/care/readmissions/rates, independent of the card list: a rates fault shows
 * "rates unavailable right now" inside the module and the board is unaffected.
 *
 * ORCHESTRATOR RULING 1 (17 Sep 2026): `refreshKey` is an optional re-fetch trigger — the board bumps
 * it after a successful Refresh-time check so the Last-30-days tile and the freshness line's own
 * "checked just now" move without adding any polling; a fresh mount (key 0, the default) behaves
 * exactly as before.
 *
 * READMIT-LAYOUT-FIX (17 Sep 2026, V ruling — layout fix): five headline tiles only — the sixth,
 * 'recent', is still what `rateCards` returns (unchanged, byte-stable), just no longer rendered INSIDE
 * the grid. It renders as its own full-width band below the tiles via `recentStripLine`, and the chart
 * gets one fixed-height, bottom-anchored plot area sized off `maxTrendPct`. No number, copy constant,
 * data field, API or payload changed — layout plus the date/rounding helpers only.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DENOMINATOR, DENOMINATORS, DENOMINATOR_LABEL, EHBR_GATE_COPY, INCIDENCE_FOOTNOTE, INCOMPLETE_MONTH_LEGEND, RATES_UNAVAILABLE_COPY, RECENT_TILE_CAPTION, RECENT_TILE_TITLE, THIS_HOSPITAL_ONLY_FOOTNOTE,
  computedAtLabel, judgementStatsLine, maxTrendPct, moduleFacility, rateCards, recentStripLine, trendBars, trendLabelRows, type DenominatorKey, type RatesResult,
} from '@/lib/readmission-rates-core';

type RatesPayload = { ok: true; rates: RatesResult; computedAt: string; cached: boolean } | { ok: false; error?: string; reason?: string; computedAt?: string };

export default function ReadmissionRatesModule({ facility, refreshKey = 0 }: { facility: string | null; refreshKey?: number }) {
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
  }, [refreshKey]);

  const rates = payload?.ok ? payload.rates : null;
  const fac = useMemo(() => (rates ? moduleFacility(rates, facility, tab) : null), [rates, facility, tab]);
  const cards = useMemo(() => (fac ? rateCards(fac, denom) : []), [fac, denom]);
  // READMIT-LAYOUT-FIX (17 Sep 2026) — the tile grid is the five headline cards only; `recent` renders
  // as its own band below (rateCards() itself is unchanged, still byte-stable at six).
  const tileCards = useMemo(() => cards.filter((c) => c.key !== 'recent'), [cards]);
  const bars = useMemo(() => (fac ? trendBars(fac) : []), [fac]);
  const maxPct = useMemo(() => maxTrendPct(bars), [bars]);
  const labelRows = useMemo(() => trendLabelRows(bars), [bars]);
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
        {/* R7-2 — the denominator selector, visible: the choice is the point. READMIT-LAYOUT-FIX
            (17 Sep 2026): full width on its own line under 390px so its longest option can't force
            the page to scroll horizontally; auto width and right-aligned from sm up. */}
        {rates && (
          <select value={denom} onChange={(e) => setDenom(e.target.value as DenominatorKey)}
            className="w-full rounded-lg border border-line bg-white px-2 py-1 text-[11.5px] text-slate-600 sm:ml-auto sm:w-auto" title="Denominator">
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
          {/* READMIT-LAYOUT-FIX (17 Sep 2026) — five headline tiles, equal height, no dead space. */}
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5 items-stretch">
            {tileCards.map((c) => (
              <div key={c.key} className={`flex h-full flex-col rounded-lg border p-2.5 ${
                c.tone === 'advisory' ? 'border-dashed border-amber-300 bg-amber-50/40'
                : c.tone === 'lead' ? 'border-brand/40 bg-brand-faint/40 ring-1 ring-brand/20'
                : c.tone === 'unavailable' ? 'border-dashed border-slate-300 bg-slate-50'
                : 'border-line bg-white'}`}>
                <div className={`text-[10.5px] uppercase tracking-wide ${c.tone === 'lead' ? 'font-semibold text-brand-dark' : 'text-slate-500'}`}>{c.title}</div>
                <div className={`mt-0.5 font-semibold tabular-nums ${c.tone === 'lead' ? 'text-[24px] text-slate-900' : 'text-[20px] text-slate-900'}`}>{c.big}</div>
                {c.ci && <div className="text-[10.5px] tabular-nums text-slate-500">95% CI {c.ci}</div>}
                <div className="mt-0.5 text-[11px] text-slate-600">{c.sub}</div>
                {c.note && <div className="mt-0.5 text-[10.5px] leading-snug text-slate-500">{c.note}</div>}
                {c.advisory && <div className="mt-1 text-[10.5px] font-medium italic text-amber-800">{c.advisory}</div>}
              </div>
            ))}
          </div>

          {/* READMIT-LAYOUT-FIX (17 Sep 2026) — the 'recent' tile, as one full-width band, not a grid cell. */}
          <div className="mt-2 rounded border border-dashed border-amber-300 bg-amber-50/40 px-3 py-2">
            <p className="text-[11.5px] leading-snug text-amber-900">
              <span className="font-semibold">{RECENT_TILE_TITLE}</span> — {recentStripLine(fac.recent, fac.ratesAllowed)}
            </p>
            <p className="mt-0.5 text-[10.5px] italic leading-snug text-amber-700">{RECENT_TILE_CAPTION}</p>
          </div>

          {/* D6 — required on the incidence card: the two exclusions this spine cannot tag, and the
              sentence that stops the lead number being read as the insurer's calendar. */}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">{INCIDENCE_FOOTNOTE}</p>

          {/* Monthly trend — complete months as split bars (reviewable / held-out, stacked to the month's
              all-cause 30-day rate); an INCOMPLETE month (READMIT-RECENT-VIEW, 17 Sep 2026) renders at
              its PROVISIONAL height when the gate is open — dashed outline, lighter fill, counts can
              only rise — and a fixed dashed ghost box only when the gate is closed (no rate to show
              at all). Every incomplete bar carries a visible `n / N so far` label; the hover title is
              unchanged. READMIT-LAYOUT-FIX (17 Sep 2026): one fixed-height, overflow-hidden plot area —
              every bar bottom-anchored on a shared baseline, sized off `maxTrendPct` so the tallest bar
              reaches the top and nothing overflows into the footnote above. */}
          {bars.length > 0 && (
            <div className="mt-4">
              <div className="overflow-x-auto">
                <div style={{ minWidth: Math.max(320, bars.length * 40) }}>
                  <div className="relative h-28 overflow-hidden">
                    <div className="absolute inset-x-0 bottom-0 flex items-end gap-1.5">
                      {bars.map((b) => {
                        const live = b.reviewablePct != null;
                        const provisional = !live && b.provisionalPct != null;
                        const rH = live ? Math.max(1, Math.round(((b.reviewablePct ?? 0) / maxPct) * 100)) : 0;
                        const hH = live ? Math.round(((b.heldOutPct ?? 0) / maxPct) * 100) : 0;
                        const pH = provisional ? Math.max(1, Math.round(((b.provisionalPct ?? 0) / maxPct) * 100)) : 0;
                        return (
                          <div key={b.month} className="flex flex-1 flex-col items-center justify-end" title={b.title}>
                            {live ? (
                              <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: rH + hH }}>
                                <div className="w-full bg-slate-300" style={{ height: hH }} />
                                <div className="w-full bg-brand" style={{ height: rH }} />
                              </div>
                            ) : provisional ? (
                              <div className="w-full rounded-t border border-dashed border-brand/40 bg-brand-faint/50" style={{ height: pH }} />
                            ) : (
                              <div className="w-full rounded-t border border-dashed border-slate-300" style={{ height: 24 }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-start gap-1.5">
                    {labelRows.map((r, i) => (
                      <div key={r.month} className="flex h-[28px] flex-1 flex-col items-center justify-start">
                        <div className={`w-full whitespace-nowrap text-center text-[11px] leading-[14px] ${bars[i].reviewablePct != null ? 'text-slate-500' : 'text-slate-400 italic'}`}>{r.row1}</div>
                        <div className="w-full whitespace-nowrap text-center text-[11px] leading-[14px] text-slate-400">{r.row2}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[10.5px] text-slate-500">
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand align-middle" />reviewable</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-300 align-middle" />held-out (oncology · dialysis · obstetric)</span>
                <span><i className="mr-1 inline-block h-2 w-3 rounded-sm border border-dashed border-brand/40 bg-brand-faint/50 align-middle" />{INCOMPLETE_MONTH_LEGEND} · n/N = returns/discharges so far</span>
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
