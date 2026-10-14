/**
 * Right Care funnel card (RIGHT-CARE-INDICATOR-PRD §4/§7). Within-specialty funnel: x = doctor volume
 * n, y = observed LVC-note rate; center = specialty pooled rate p̄; 95% + 99.8% control limits.
 * The target doctor's dot is coloured (greyed with "building history" at n<10); peers are grey. Plain
 * sentence + a case-mix transparency strip (band mix → expected vs observed). SVG only, no chart libs.
 * Reused verbatim by the department detail page (a department IS the specialty peer group, decision 20).
 */
import {
  pooledRate, funnelLimit, funnelPosition, FUNNEL_MIN_N, Z_95, Z_998, type DoctorOE,
} from '@/lib/opd-funnel-core';

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const BAND_ORDER: { key: string; label: string }[] = [
  { key: 'LOW', label: 'low' }, { key: 'MODERATE', label: 'moderate' }, { key: 'HIGH', label: 'high' }, { key: 'NEW_TO_US', label: 'new' },
];

export function FunnelCard({ doctorUid, specialty, peers, codingFlag }: {
  doctorUid: string; specialty: string; peers: DoctorOE[]; codingFlag?: string | null;
}) {
  const me = peers.find((p) => p.doctor_uid === doctorUid) || null;
  const plotted = peers.filter((p) => p.n > 0);
  if (plotted.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-400">
        Right Care funnel — not enough banded notes in {specialty || 'this specialty'} yet.
      </div>
    );
  }
  const pBar = pooledRate(plotted.map((p) => ({ n: p.n, o: p.o })));
  const maxN = Math.max(...plotted.map((p) => p.n), 10);

  // dynamic y-domain to fit the dots + limit band
  const l95max = funnelLimit(pBar, Math.max(10, Math.min(...plotted.map((p) => p.n))), Z_998);
  const rates = plotted.map((p) => p.raw_rate);
  const yMin = Math.max(0, Math.min(pBar, ...rates, l95max.lo) - 0.05);
  const yMax = Math.min(1, Math.max(pBar, ...rates, l95max.hi) + 0.05);

  // SVG geometry
  const W = 380, H = 210, mL = 34, mR = 12, mT = 10, mB = 26;
  const iw = W - mL - mR, ih = H - mT - mB;
  const xOf = (n: number) => mL + (Math.min(n, maxN) / maxN) * iw;
  const yOf = (r: number) => mT + (1 - (Math.min(yMax, Math.max(yMin, r)) - yMin) / (yMax - yMin || 1)) * ih;

  // sample the limit band across n (denser at low n where it flares)
  const ns: number[] = [];
  for (let i = 1; i <= 60; i++) ns.push(Math.max(1, Math.round((i / 60) * maxN)));
  const uniq = Array.from(new Set(ns)).sort((a, b) => a - b);
  const path = (z: number, side: 'lo' | 'hi') =>
    uniq.map((n, i) => `${i === 0 ? 'M' : 'L'} ${xOf(n).toFixed(1)} ${yOf(funnelLimit(pBar, n, z)[side]).toFixed(1)}`).join(' ');

  const pos = me ? funnelPosition(me.raw_rate, pBar, me.n) : 'building';
  const sentence = !me ? ''
    : pos === 'building' ? `Building history for ${specialty || 'this specialty'} — ${me.n} banded notes (need ${FUNNEL_MIN_N}+ to compare).`
    : pos === 'within' ? `Within the expected range for ${specialty || 'this specialty'} at this volume.`
    : pos === 'above' ? `Above the expected range for ${specialty || 'this specialty'} at this volume.`
    : `Below the expected range for ${specialty || 'this specialty'} at this volume.`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-slate-800">Right Care — within {specialty || 'Unspecified'}</h3>
        <span className="text-[10.5px] text-slate-400">{plotted.length} peer(s) · pooled {pct(pBar)}</span>
      </div>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="mt-2" role="img" aria-label="Right Care funnel plot">
        {/* y grid: pBar center */}
        <line x1={mL} y1={yOf(pBar)} x2={W - mR} y2={yOf(pBar)} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
        <text x={mL - 4} y={yOf(pBar) + 3} textAnchor="end" fontSize="9" fill="#64748b">{pct(pBar)}</text>
        {/* 99.8% then 95% limit bands (grey → darker) */}
        <path d={path(Z_998, 'hi')} fill="none" stroke="#cbd5e1" strokeWidth={1} />
        <path d={path(Z_998, 'lo')} fill="none" stroke="#cbd5e1" strokeWidth={1} />
        <path d={path(Z_95, 'hi')} fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />
        <path d={path(Z_95, 'lo')} fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />
        {/* axes labels */}
        <text x={mL} y={H - 6} fontSize="9" fill="#94a3b8">n →</text>
        <text x={W - mR} y={H - 6} textAnchor="end" fontSize="9" fill="#94a3b8">{maxN}</text>
        {/* peer dots */}
        {plotted.filter((p) => p.doctor_uid !== doctorUid).map((p) => (
          <circle key={p.doctor_uid} cx={xOf(p.n)} cy={yOf(p.raw_rate)} r={2.6}
            fill={p.n < FUNNEL_MIN_N ? '#e2e8f0' : '#cbd5e1'} />
        ))}
        {/* this doctor */}
        {me && (
          <circle cx={xOf(me.n)} cy={yOf(me.raw_rate)} r={5}
            fill={me.n < FUNNEL_MIN_N ? '#cbd5e1' : (pos === 'above' ? '#d97706' : pos === 'below' ? '#059669' : '#0f766e')}
            stroke="#fff" strokeWidth={1.5} />
        )}
      </svg>

      {me && <p className="mt-1 text-[12px] font-medium text-slate-700">{sentence}</p>}
      {me && (
        <p className="mt-1 text-[11px] text-slate-500">
          Case-mix: {BAND_ORDER.map((b) => `${Math.round((me.band_mix[b.key] || 0) * 100)}% ${b.label}`).join(' · ')}
          {' '}→ expected {pct(me.expected_rate)}, observed {pct(me.raw_rate)}
          {me.oe != null && <span className="text-slate-400"> · O/E {me.oe.toFixed(2)}</span>}
        </p>
      )}
      {codingFlag && (
        <p className="mt-1 text-[10.5px] text-amber-700">⚠ Coding-intensity outlier — {codingFlag}. Hand-review the chronic-code accumulation before acting on the expected rate.</p>
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-slate-400">
        Advisory note-quality proxy — low-value findings as documented in notes, case-mix adjusted. Not an outcomes measure or clinician scorecard.
      </p>
    </div>
  );
}
