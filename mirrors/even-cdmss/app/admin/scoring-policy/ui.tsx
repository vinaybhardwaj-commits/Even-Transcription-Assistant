'use client';
/**
 * app/admin/scoring-policy/ui.tsx — the interactive parts of the Scoring policy module.
 *
 * The App Router forces a server/client split: the pages are server components (they hold the
 * admin gate and the initial data read), and everything that reacts to a click lives here. This
 * mirrors app/admin/ipd-audit/{page,ui}.tsx exactly.
 *
 * ⚠️ This file is the ONE addition to the PRD §9 Phase A file list (13 new → 14). The PRD lists
 * `page.tsx` alone for the weightage screen, but §5.3 requires tier controls that recompute the
 * impact preview on every change with no save — which cannot be a server component. Flagged in the
 * build report.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// §12.4 + decision 17 — required, and typed fresh every time. There is no prefill by design.
import { isValidAttribution, ATTRIBUTION_LABEL, ATTRIBUTION_HELP } from '@/lib/admin-attribution';
import {
  TIER_ORDER, TIER_LABEL, SECTION_LABEL, asTier, diffVectors, normalisedWeights, vectorsEqual,
  type FieldDef, type Tier, type WeightVector,
} from '@/lib/scoring-policy/weights';
import { systemicDefectMessage } from '@/lib/scoring-policy/preview';

// ── the access gate, with the RIGHT post-unlock destination ─────────────────────────────────────
// app/admin/ipd-audit/ui.tsx's Locked hardcodes next="/admin/ipd-audit", which would bounce a
// scoring-policy visitor to the wrong screen. Same markup, correct target.
export function Locked({ configured, bad, next }: { configured: boolean; bad?: boolean; next: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Scoring policy</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value={next} />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

export interface PreviewPayload {
  emptyState?: boolean;
  degraded?: boolean;
  accumulated?: number;
  n?: number;
  windowDays?: number;
  message?: string;
  now?: { n: number; meanCompleteness: number; sdCompleteness: number; bandHistogram: Record<string, number> };
  after?: { n: number; meanCompleteness: number; sdCompleteness: number; bandHistogram: Record<string, number> };
  changingBand?: number;
  deltaMeanCompleteness?: number;
  deltaSd?: number;
  movers?: { id: string; fromPct: number; toPct: number; delta: number; fromBand: string; toBand: string }[];
  prevalence?: Record<string, { missing: number; applicable: number; pct: number }>;
  warnings?: { key: string; label: string; missingPct: number }[];
}

const BANDS = ['A', 'B', 'C', 'D', 'E'] as const;
const BAND_BG: Record<string, string> = { A: '#0d9488', B: '#16a34a', C: '#d97706', D: '#ea580c', E: '#dc2626' };

export interface EditorProps {
  noteType: string;
  noteTypeLabel: string;
  fields: FieldDef[];
  activeVector: WeightVector;
  activeVersion: number;
  activeVersionString: string;
  activeFallback: boolean;
  draftVector: WeightVector | null;
  draftUpdatedAt: string | null;
  /** Server-rendered first preview, so the panel is populated before any interaction. */
  initialPreview: PreviewPayload | null;
  noteTypeTabs: { noteType: string; label: string; count: number; locked?: boolean }[];
  /** Set when arriving via §5.5 Restore — prefills the publish rationale. */
  restoredFromVersion?: number | null;
}

export function WeightageEditor(props: EditorProps) {
  const {
    noteType, noteTypeLabel, fields, activeVector, activeVersion, activeVersionString,
    activeFallback, draftVector, draftUpdatedAt, initialPreview, noteTypeTabs, restoredFromVersion,
  } = props;

  const weightedFields = useMemo(() => fields.filter((f) => f.weighted), [fields]);
  const keys = useMemo(() => weightedFields.map((f) => f.key), [weightedFields]);

  const [vector, setVector] = useState<WeightVector>(() => ({ ...activeVector, ...(draftVector ?? {}) }));
  const [preview, setPreview] = useState<PreviewPayload | null>(initialPreview);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const seq = useRef(0);

  const changed = !vectorsEqual(activeVector, vector, keys);
  const changedFields = useMemo(() => diffVectors(activeVector, vector, keys), [activeVector, vector, keys]);
  const pct = useMemo(() => normalisedWeights(vector, keys), [vector, keys]);
  const prevalence = preview?.prevalence ?? initialPreview?.prevalence ?? {};

  // Recompute on every tier change. Debounced and sequence-guarded so a fast click-through cannot
  // land an older response over a newer one.
  const refresh = useCallback(async (next: WeightVector) => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const res = await fetch('/api/scoring-policy/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note_type: noteType, weights: next }),
      });
      const json = (await res.json()) as PreviewPayload;
      if (mine === seq.current) setPreview(json);
    } catch {
      if (mine === seq.current) setPreview({ degraded: true, emptyState: true, message: 'Impact preview is temporarily unavailable.' });
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [noteType]);

  useEffect(() => {
    const t = setTimeout(() => { void refresh(vector); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vector]);

  // The draft is saved quietly in the background; a failure never blocks editing.
  useEffect(() => {
    if (!changed) return;
    const t = setTimeout(() => {
      void fetch('/api/scoring-policy/draft', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note_type: noteType, weights: vector }),
      }).catch(() => {});
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vector, changed, noteType]);

  const setTier = (key: string, tier: Tier) => setVector((v) => ({ ...v, [key]: tier }));
  const resetToEqual = () => setVector(() => { const v: WeightVector = {}; for (const k of keys) v[k] = 'standard'; return v; });

  // Sections in catalogue order; within a section, ordered by missing count DESC (PRD §5.3).
  const sections = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, FieldDef[]>();
    for (const f of weightedFields) {
      if (!map.has(f.section)) { map.set(f.section, []); order.push(f.section); }
      map.get(f.section)!.push(f);
    }
    return order.map((s) => ({
      section: s,
      fields: [...map.get(s)!].sort((a, b) => (prevalence[b.key]?.pct ?? 0) - (prevalence[a.key]?.pct ?? 0)),
    }));
  }, [weightedFields, prevalence]);

  const warnings = preview?.warnings ?? [];
  const sdAfter = preview?.after?.sdCompleteness ?? 0;
  const sdFalling = (preview?.deltaSd ?? 0) < 0;

  return (
    <div>
      {/* ── header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">
            <Link href="/admin/scoring-policy" className="hover:underline">Admin › Scoring policy</Link> › NABH completeness weightage
          </nav>
          <h1 className="mt-0.5 font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">NABH completeness weightage</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
            <span>{noteTypeLabel} · {weightedFields.length} fields</span>
            <span className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
              {activeFallback ? 'not initialised' : `v${activeVersion} · live`}
            </span>
            {changed && (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
                {changedFields.length} field{changedFields.length === 1 ? '' : 's'} changed
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/scoring-policy/nabh-completeness/history" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Version history</Link>
          <button
            onClick={() => setPublishOpen(true)}
            disabled={!changed}
            title={changed ? undefined : 'Nothing has changed since the live version.'}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            Publish new version
          </button>
        </div>
      </div>

      {activeFallback && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          No weights version is live yet — every field is being treated as <b>Standard</b>, which reproduces the
          existing scoring exactly. Run migration <code className="font-mono">0026_scoring_policy.sql</code> to seed v1.
        </div>
      )}

      {/* ── note-type tabs ── */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {noteTypeTabs.map((t) => (
          t.locked ? (
            <span key={t.noteType} aria-disabled className="cursor-not-allowed rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-400">
              {t.label} · {t.count} <span className="ml-1 text-[10px] uppercase">locked</span>
            </span>
          ) : (
            <Link
              key={t.noteType}
              href={`/admin/scoring-policy/nabh-completeness?note_type=${t.noteType}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${t.noteType === noteType ? 'bg-brand text-white' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {t.label} · {t.count}
            </Link>
          )
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── field list ── */}
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13.5px] font-semibold text-slate-800">Set how much each field matters clinically</p>
            <button onClick={resetToEqual} className="text-xs text-brand hover:underline">Reset to equal</button>
          </div>

          {sections.map(({ section, fields: fs }) => (
            <div key={section} className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400">{SECTION_LABEL[section] ?? section}</div>
              <div className="mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {fs.map((f, i) => {
                  const p = prevalence[f.key]?.pct;
                  const tier = asTier(vector[f.key]);
                  return (
                    <div key={f.key} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i ? 'border-t border-slate-100' : ''}`}>
                      <div className="min-w-[190px] flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-medium text-slate-900">{f.label}</span>
                          <span className="rounded border border-slate-200 px-1 py-px text-[10px] text-slate-400">NABH AAC.14</span>
                          {f.nearDuplicateOf && (
                            <span title={`Near-duplicate label of “${f.nearDuplicateOf}” — kept separate deliberately.`} className="rounded border border-slate-200 bg-slate-50 px-1 py-px text-[10px] text-slate-400">
                              near-duplicate
                            </span>
                          )}
                        </div>
                        {/* LOAD-BEARING — never move this into a tooltip (PRD §5.3). */}
                        {p != null && (
                          <div className={`mt-0.5 text-[11.5px] ${p > 50 ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                            missing in {p}% of summaries
                          </div>
                        )}
                      </div>

                      <div className="flex overflow-hidden rounded-lg border border-slate-200">
                        {TIER_ORDER.map((t) => (
                          <button
                            key={t}
                            onClick={() => setTier(f.key, t)}
                            aria-pressed={tier === t}
                            className={`px-2.5 py-1 text-[11.5px] font-semibold transition ${tier === t ? 'bg-brand text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                          >
                            {TIER_LABEL[t]}
                          </button>
                        ))}
                      </div>

                      <div className="w-[52px] text-right text-[12px] tabular-nums text-slate-400">
                        {(pct[f.key] ?? 0).toFixed(1)}%
                      </div>
                      <span title="Set by NABH 6th edition — not editable." className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                        NABH mandatory
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Continuity fields are shown but not weightable — better than hiding them. */}
          {fields.some((f) => !f.weighted) && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-slate-400">Not weighted here</div>
              <div className="mt-1.5 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
                <p className="text-[12px] text-slate-500">
                  {fields.filter((f) => !f.weighted).map((f) => f.label).join(' · ')}
                </p>
                <p className="mt-1 text-[11.5px] text-slate-400">
                  These are scored in the Continuity &amp; patient-centredness domain, not in documentation completeness.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── impact preview ── */}
        <aside>
          {warnings.map((w) => (
            <div key={w.key} className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12.5px] leading-relaxed text-amber-900">
              <b>{w.label}</b> {systemicDefectMessage(w.label, sdAfter).slice(w.label.length + 1)}
            </div>
          ))}

          {preview?.emptyState || preview?.degraded ? (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[13px] font-semibold text-slate-800">
                {preview?.degraded ? 'Preview unavailable' : 'No preview available yet.'}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-500">
                {preview?.message ?? 'Nothing to preview in this window.'}
                {preview?.accumulated != null && <> Currently <b>{preview.accumulated}</b>.</>}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[11.5px] text-slate-400">
                Last {preview?.windowDays ?? 90} days · {preview?.n ?? 0} summaries · recalculated instantly, no re-audit
                {busy && <span className="ml-1 animate-pulse">…</span>}
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                <Metric label="Mean completeness" value={`${preview?.after?.meanCompleteness ?? 0}%`} delta={preview?.deltaMeanCompleteness ?? 0} />
                {/* A FALLING SD renders in danger colour — narrowing spread means the change measured less. */}
                <Metric label="Spread (SD)" value={String(preview?.after?.sdCompleteness ?? 0)} delta={preview?.deltaSd ?? 0} danger={sdFalling} />
                <Metric label="Change band" value={String(preview?.changingBand ?? 0)} />
              </div>

              <div className="mt-4 space-y-2">
                <BandBar title="Now" hist={preview?.now?.bandHistogram} total={preview?.n ?? 0} />
                <BandBar title="After" hist={preview?.after?.bandHistogram} total={preview?.n ?? 0} />
              </div>

              {!!preview?.movers?.length && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Largest movers</div>
                  <ul className="mt-1.5 space-y-1">
                    {preview.movers.map((m) => (
                      <li key={m.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                        <span className="truncate font-mono text-[11px] text-slate-500">{m.id.slice(0, 8)}</span>
                        <span className="tabular-nums text-slate-700">
                          {m.fromPct}% → {m.toPct}% <span className={m.delta < 0 ? 'text-red-600' : 'text-emerald-700'}>({m.delta > 0 ? '+' : ''}{m.delta})</span>
                          {m.fromBand !== m.toBand && <span className="ml-1 text-slate-400">{m.fromBand}→{m.toBand}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="mt-3 text-[11.5px] leading-relaxed text-slate-400">
            Weighted completeness feeds the headline index, so re-weighting moves bands. Every surface showing a band
            also shows the weights version that produced it — currently <span className="font-mono">{activeVersionString}</span>.
          </p>
        </aside>
      </div>

      {restoredFromVersion != null && (
        <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">
          Loaded the weights from <b>v{restoredFromVersion}</b>. Publishing will create a NEW version carrying them
          forward — v{restoredFromVersion} itself is not modified.
        </div>
      )}

      {publishOpen && (
        <PublishModal
          noteType={noteType}
          restoredFromVersion={restoredFromVersion ?? null}
          changedFields={changedFields}
          fields={fields}
          vector={vector}
          draftUpdatedAt={draftUpdatedAt}
          onClose={() => setPublishOpen(false)}
          onDone={(msg) => { setPublishOpen(false); setToast(msg); setTimeout(() => location.reload(), 700); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg">{toast}</div>
      )}
    </div>
  );
}

function Metric({ label, value, delta, danger }: { label: string; value: string; delta?: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 font-serif text-[20px] font-semibold leading-none text-slate-900">{value}</div>
      {delta != null && delta !== 0 && (
        <div className={`mt-1 text-[11px] tabular-nums ${danger ? 'font-semibold text-red-600' : delta < 0 ? 'text-slate-500' : 'text-slate-500'}`}>
          {delta > 0 ? '+' : ''}{delta} vs live
        </div>
      )}
    </div>
  );
}

function BandBar({ title, hist, total }: { title: string; hist?: Record<string, number>; total: number }) {
  const h = hist ?? {};
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] text-slate-400">
        <span>{title}</span>
        <span className="tabular-nums">{BANDS.map((b) => `${b}×${h[b] ?? 0}`).join(' · ')}</span>
      </div>
      <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-slate-100">
        {BANDS.map((b) => {
          const n = h[b] ?? 0;
          if (!n || !total) return null;
          return <div key={b} title={`${b}: ${n}`} style={{ width: `${(100 * n) / total}%`, background: BAND_BG[b] }} />;
        })}
      </div>
    </div>
  );
}

function PublishModal(props: {
  noteType: string;
  changedFields: { key: string; from: Tier; to: Tier }[];
  fields: FieldDef[];
  vector: WeightVector;
  draftUpdatedAt: string | null;
  restoredFromVersion: number | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { noteType, changedFields, fields, vector, draftUpdatedAt, restoredFromVersion, onClose, onDone } = props;
  // §5.5 — a restore arrives with its rationale prefilled, and editable.
  const [rationale, setRationale] = useState(restoredFromVersion != null ? `Restored v${restoredFromVersion}.` : '');
  // ⚠️ STARTS EMPTY, ALWAYS (decision 17). A remembered name would offer the LAST person's name to
  // the NEXT one on a shared browser, and a wrong name is worse than no name. Do not add a default.
  const [changedBy, setChangedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k;
  const ok = rationale.trim().length >= 10 && isValidAttribution(changedBy);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/scoring-policy/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          note_type: noteType, weights: vector, rationale,
          published_by_name: changedBy.trim(),
          expected_draft_updated_at: draftUpdatedAt ?? undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; toast?: string; error?: string };
      if (!res.ok || !json.ok) { setError(json.error ?? 'Publish failed.'); setBusy(false); return; }
      onDone(json.toast ?? 'Published');
    } catch {
      setError('Publish failed — nothing was changed.'); setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal>
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="font-serif text-[19px] font-semibold text-slate-900">Publish new version</h2>

        <div className="mt-3 rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {changedFields.length} field{changedFields.length === 1 ? '' : 's'} changed
          </div>
          <ul className="divide-y divide-slate-100">
            {changedFields.map((c) => (
              <li key={c.key} className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="text-slate-700">{label(c.key)}</span>
                <span className="whitespace-nowrap text-slate-500">{TIER_LABEL[c.from]} → <b className="text-slate-900">{TIER_LABEL[c.to]}</b></span>
              </li>
            ))}
          </ul>
        </div>

        <label className="mt-4 block">
          <span className="text-[12.5px] font-semibold text-slate-800">Why are you making this change?</span>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
            placeholder="A sentence is enough — it is kept with the version, permanently."
          />
          <span className="text-[11px] text-slate-400">{rationale.trim().length}/10 characters minimum</span>
        </label>

        <label className="mt-4 block">
          <span className="text-[12.5px] font-semibold text-slate-800">{ATTRIBUTION_LABEL}</span>
          <input
            value={changedBy}
            onChange={(e) => setChangedBy(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
            placeholder="Dr Binita Priyambada"
          />
          <span className="text-[11px] text-slate-400">{ATTRIBUTION_HELP}</span>
        </label>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
          {noteType === 'discharge_summary'
            ? 'Applies to all audits, including the last 90 days.'
            : 'Applies to audits from now on.'}
        </p>

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Cancel</button>
          <button
            onClick={submit}
            disabled={!ok || busy}
            className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
