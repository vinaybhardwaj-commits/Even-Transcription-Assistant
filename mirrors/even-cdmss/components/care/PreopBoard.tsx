'use client';

/**
 * /care/preop — the pre-op risk board (Build Plan B4; the V-approved mockup §1 plus the
 * five ratified v1.1 deltas in docs/handoff/MOCKUP-v1.1-DELTAS.md).
 *
 * Triage-first: the needs-review band pinned on top, then tier bands, with GREEN cases
 * collapsed to dense rows. Every card names what it knows, what it does not, and where
 * each came from.
 *
 * ALL JUDGEMENT lives in lib/preop-surface-core.ts and lib/preop-tier-core.ts, where it
 * is unit tested — this file is markup and fetch, the readmissions-board posture. Nothing
 * here recomputes a score; the route hands over what the sweep stored.
 *
 * READ-ONLY except for one verb: Mark reviewed, per snapshot version (mockup note 7).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw } from 'lucide-react';
import {
  buildBands, cardChips, computeTiles, daysToSurgery, degradedStrip, denseLine,
  identityLine, isReviewed, longDate, pacChip, reviewState, whenText,
  EMPTY_BOARD_COPY, REVIEW_LABEL, SCORES_FOOTER, TIER_GLYPH,
  type PreopCardRow,
} from '@/lib/preop-surface-core';
import type { Tier } from '@/lib/preop-tier-core';

interface Payload {
  ok: boolean;
  engine: string;
  rows: PreopCardRow[];
  lastSweepAt: string | null;
  degradedSources: string[];
  extraction: string;
  narrative: string;
  error: string | null;
}

const TIER_PILL: Record<Tier, string> = {
  CRITICAL: 'bg-red-800 border-red-800 text-white',
  RED: 'bg-red-50 border-red-200 text-red-700',
  AMBER: 'bg-amber-50 border-amber-200 text-amber-800',
  GREEN: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};
const TIER_EDGE: Record<Tier, string> = {
  CRITICAL: 'border-l-red-800', RED: 'border-l-red-600', AMBER: 'border-l-amber-500', GREEN: 'border-l-emerald-600',
};

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function timeStamp(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)} IST`;
}

export default function PreopBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setFailed(null);
    try {
      const r = await fetch('/api/care/preop/list', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the board could not load (HTTP ${r.status})`);
      setData((await r.json()) as Payload);
    } catch (e) {
      setFailed(String((e as Error).message));
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const markReviewed = useCallback(async (row: PreopCardRow) => {
    if (row.versionNo == null) return;
    setSaving(row.episodeKey);
    try {
      const r = await fetch('/api/care/preop/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeKey: row.episodeKey, versionNo: row.versionNo }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `could not save (HTTP ${r.status})`);
      }
      await load();
    } catch (e) {
      setFailed(String((e as Error).message));
    } finally { setSaving(null); }
  }, [load]);

  if (failed && !data) {
    return (
      <Shell>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-[13px] text-rose-800">
          <div className="font-semibold">The board did not load.</div>
          <div className="mt-1">{failed}</div>
          <button onClick={() => void load()} className="mt-2 rounded-lg border border-rose-300 bg-white px-3 py-1 text-[12px] font-medium text-rose-800">Retry</button>
        </div>
      </Shell>
    );
  }
  if (!data) return <Shell><div className="p-6 text-[13px] text-slate-500">Loading the upcoming surgical cases…</div></Shell>;

  const today = istToday();
  const rows = data.rows;
  const tiles = computeTiles(rows);
  const bands = buildBands(rows);
  const strip = degradedStrip(data.degradedSources);

  return (
    <Shell>
      {/* system strip — engine, last sweep, and the flag states (mockup note 1 + 2) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
        <div className="text-[12.5px] text-slate-600">
          CAT · Managed Care › <span className="font-semibold text-slate-900">Pre-op Risk</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill>engine {data.engine}</Pill>
          <Pill>last sweep {timeStamp(data.lastSweepAt)}</Pill>
          <Pill>extraction {data.extraction} · narrative {data.narrative}</Pill>
          <button onClick={() => void load()} disabled={busy}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-[3px] text-[10.5px] text-slate-600 disabled:opacity-50">
            <RotateCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {strip && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 flex-none" />
          <span>{strip}</span>
        </div>
      )}
      {failed && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">{failed}</div>}

      {/* tiles — numbers wear ink, never status colour */}
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{t.k}</div>
            <div className="mt-0.5 text-[20px] font-bold tabular-nums text-slate-900">{t.v}</div>
            <div className="text-[10.5px] italic text-slate-400">{t.s}</div>
          </div>
        ))}
      </div>

      {!rows.length && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">
          {EMPTY_BOARD_COPY}
          <div className="mt-1 text-[11.5px] text-slate-400">last sweep {timeStamp(data.lastSweepAt)}</div>
        </div>
      )}

      {bands.map((band) => (
        <section key={band.key} className={band.key === 'needs_review'
          ? 'mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-3'
          : 'mt-4'}>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h2 className={`text-[11px] font-bold uppercase tracking-widest ${band.key === 'needs_review' ? 'text-amber-800' : 'text-slate-700'}`}>{band.title}</h2>
            <span className="text-[11px] text-slate-400">{band.subtitle}</span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          {band.dense
            ? band.rows.map((row) => <DenseRow key={row.episodeKey} row={row} today={today} />)
            : band.rows.map((row) => (
              <Card key={row.episodeKey} row={row} today={today}
                saving={saving === row.episodeKey} onReview={() => void markReviewed(row)} />
            ))}
        </section>
      ))}

      <p className="mt-6 border-t border-slate-200 pt-3 text-[11.5px] leading-relaxed text-slate-400">{SCORES_FOOTER}</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-5 py-6" style={{ fontFamily: 'system-ui, sans-serif' }}>{children}</div>;
}

function Pill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-slate-200 bg-white px-2.5 py-[3px] text-[10.5px] text-slate-500">{children}</span>;
}

function TierPill({ tier }: { tier: Tier }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[2px] text-[10.5px] font-bold tracking-wide ${TIER_PILL[tier]}`}>
      <span aria-hidden>{TIER_GLYPH[tier]}</span>{tier}
    </span>
  );
}

/** The instrument chips. A dashed border means the unconfirmed upper bound crosses a
 *  severity boundary (mockup note 8) — never merely that the score is a range. */
function Chips({ row }: { row: PreopCardRow }) {
  const chips = cardChips(row);
  if (!chips.length) return <span className="text-[11.5px] text-slate-400">not yet computed</span>;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.instrument}
          className={`rounded-lg px-2.5 py-1 text-[11.5px] ${c.dashed ? 'border border-dashed border-slate-300 bg-slate-50/60' : 'border border-slate-200 bg-white'}`}>
          {c.title} <b className={`tabular-nums ${c.dashed ? 'text-slate-600' : 'text-slate-900'}`}>{c.score}</b>
          {c.cls && <span className="ml-1 text-[10.5px] text-slate-400">{c.cls}</span>}
        </span>
      ))}
    </div>
  );
}

function Card({ row, today, saving, onReview }: { row: PreopCardRow; today: string; saving: boolean; onReview: () => void }) {
  const id = identityLine(row);
  const days = daysToSurgery(today, row.surgeryDate);
  const pac = pacChip(row, new Date().toISOString());
  const rev = reviewState(row);
  const tier = row.tier ?? 'AMBER';

  return (
    <div className={`relative mt-2.5 rounded-xl border border-l-4 border-slate-200 bg-white px-3.5 py-3 ${TIER_EDGE[tier]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0">
          <Link href={`/care/preop/case/${encodeURIComponent(row.episodeKey)}`}
            className="text-[14px] font-semibold text-slate-900 hover:underline">
            {id.name}
          </Link>
          {id.sub && <span className="ml-1.5 text-[11px] text-slate-400">{id.sub}</span>}
          <div className="mt-0.5 text-[12.5px] text-slate-600">{[row.procedure, row.hospital].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="text-right text-[11.5px] text-slate-600">
          <div><b className="text-slate-900">{longDate(row.surgeryDate)}</b> · {whenText(days)}</div>
          <div className="mt-1"><TierPill tier={tier} /></div>
        </div>
      </div>

      <Chips row={row} />

      {row.whyLine && <p className="mt-2 text-[12px] text-slate-600"><b className="font-semibold text-slate-900">Why:</b> {row.whyLine}</p>}
      {row.missingLine && <p className="mt-1 text-[12px] font-medium text-amber-800">{row.missingLine}</p>}
      {row.situationLine && <p className="mt-1 text-[12px] font-semibold text-red-700">{row.situationLine}</p>}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full border px-2 py-[2px] text-[10.5px] ${
            pac.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : pac.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-white text-slate-500'}`}>{pac.text}</span>
          <span className="rounded-full border border-slate-200 bg-white px-2 py-[2px] text-[10.5px] text-slate-500">
            snapshot v{row.versionNo ?? 1}
          </span>
          {row.bookingOnly && <span className="rounded-full border border-slate-200 bg-white px-2 py-[2px] text-[10.5px] text-slate-500">booking-only</span>}
          {isReviewed(row) && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-[2px] text-[10.5px] text-emerald-800">reviewed ✓</span>}
        </div>
        {!isReviewed(row) && (
          <button onClick={onReview} disabled={saving || row.versionNo == null}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:border-slate-300 disabled:opacity-50">
            {saving ? 'Saving…' : rev.reopened ? 'Re-review' : REVIEW_LABEL}
          </button>
        )}
      </div>
      {rev.reopened && <p className="mt-1 text-[11px] text-slate-400">{rev.label}</p>}
    </div>
  );
}

function DenseRow({ row, today }: { row: PreopCardRow; today: string }) {
  const id = identityLine(row);
  const days = daysToSurgery(today, row.surgeryDate);
  const pac = pacChip(row, new Date().toISOString());
  return (
    <Link href={`/care/preop/case/${encodeURIComponent(row.episodeKey)}`}
      className="mt-1.5 flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-[7px] text-[12px] text-slate-600 hover:border-slate-300">
      <span><b className="font-semibold text-slate-900">{id.name}</b>{id.sub ? ` · ${id.sub}` : ''} · {row.procedure ?? 'procedure unknown'} · {longDate(row.surgeryDate)} ({whenText(days)})</span>
      <span className="flex items-center gap-3 tabular-nums">
        <span>{denseLine(row)}</span>
        <span className="text-slate-400">{pac.text}</span>
        {isReviewed(row) && <span className="text-emerald-700">reviewed ✓</span>}
      </span>
    </Link>
  );
}
