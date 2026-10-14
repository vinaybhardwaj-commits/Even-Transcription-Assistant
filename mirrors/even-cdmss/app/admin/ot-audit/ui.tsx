// Shared server-safe chrome for the CAT admin OT Audit browser.
// Unlock cookie, day window, and filter links follow the IPD discharge audit.
import Link from 'next/link';
import type { OtAdminMapStatus, OtAdminScoreBand } from '@/lib/triage/ot-admin-present';

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function Locked({ configured, bad }: { configured: boolean; bad?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OT Audit</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value="/admin/ot-audit" />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

const MAP_PILLS: { key: OtAdminMapStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All hops' },
  { key: 'mapped', label: 'Mapped' },
  { key: 'unmapped', label: 'Unmapped' },
  { key: 'multi_surgeon_hold', label: 'Multi-surgeon hold' },
];

const BAND_PILLS: { key: OtAdminScoreBand | 'all'; label: string }[] = [
  { key: 'all', label: 'Any score' },
  { key: 'ge80', label: '≥80' },
  { key: 'mid', label: '60–79' },
  { key: 'lt60', label: '<60' },
];

export function OtFilterBar({
  day, period, map, site, band, surgeon, sites,
}: {
  day: string;
  period: string;
  map?: string;
  site?: string;
  band?: string;
  surgeon?: string;
  sites: { id: string; label: string }[];
}) {
  const q = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = {
      day, period, map, site, band, surgeon, ...patch,
    };
    const parts = Object.entries(merged)
      .filter(([, v]) => v != null && v !== '' && v !== 'all')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `/admin/ot-audit?${parts.join('&')}` : '/admin/ot-audit';
  };
  const pill = (href: string, active: boolean, label: string) => (
    <Link key={label} href={href} className={`rounded-md px-2 py-1 text-[11.5px] font-medium ${active ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</Link>
  );
  return (
    <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Surgeon hop</span>
        <span className="flex flex-wrap overflow-hidden rounded-lg border border-slate-200">
          {MAP_PILLS.map((p) => pill(q({ map: p.key === 'all' ? undefined : p.key }), (map || 'all') === p.key, p.label))}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">NABH</span>
        <span className="flex overflow-hidden rounded-lg border border-slate-200">
          {BAND_PILLS.map((p) => pill(q({ band: p.key === 'all' ? undefined : p.key }), (band || 'all') === p.key, p.label))}
        </span>
      </div>
      {sites.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Site</span>
          {pill(q({ site: undefined }), !site, 'All')}
          {sites.map((s) => pill(q({ site: s.id }), site === s.id, s.label))}
        </div>
      )}
      <form method="GET" action="/admin/ot-audit" className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        <input type="hidden" name="day" value={day} />
        <input type="hidden" name="period" value={period} />
        {map ? <input type="hidden" name="map" value={map} /> : null}
        {site ? <input type="hidden" name="site" value={site} /> : null}
        {band ? <input type="hidden" name="band" value={band} /> : null}
        <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400" htmlFor="ot-surgeon">Surgeon</label>
        <input
          id="ot-surgeon"
          name="surgeon"
          defaultValue={surgeon || ''}
          placeholder="Raw text or mapped Pulse name"
          className="w-64 rounded-lg border border-slate-300 px-2.5 py-1 text-[12.5px]"
        />
        <button className="rounded-lg bg-brand px-3 py-1 text-[12px] font-semibold text-white">Search</button>
        {surgeon ? <Link href={q({ surgeon: undefined })} className="text-[12px] text-slate-500 hover:text-brand">Clear</Link> : null}
      </form>
    </div>
  );
}

export function MapChip({ status }: { status: string }) {
  const tone = status === 'mapped'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : status === 'multi_surgeon_hold'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-600';
  const label = status === 'multi_surgeon_hold' ? 'multi_surgeon_hold' : status === 'mapped' ? 'mapped' : 'unmapped';
  return <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold ${tone}`}>{label}</span>;
}

export function NabhPct({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-400">Not scored</span>;
  const tone = pct >= 80 ? 'text-emerald-700' : pct >= 60 ? 'text-amber-700' : 'text-red-700';
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, '');
  return <span className={`font-semibold tabular-nums ${tone}`}>{text}%</span>;
}
