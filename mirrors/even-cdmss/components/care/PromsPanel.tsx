'use client';

// PromsPanel — PROMs 0.2a-2 surgical-recovery tracker (per the approved normative mockup). Mounted on
// the member workspace behind PROMS_ENABLED (server-read prop). Fetches the compiled schedule from
// /api/care-call/proms/schedule, administers the open window's house/CORE items VERBATIM (chips = each
// item's scale), previews the DETERMINISTIC score client-side (scoreInstrument, the same pure fn the
// server authoritatively re-runs on save), surfaces ⚠ escalations, and posts each administration.
// WHODAS-12 + PREM show "pending" until their verbatim item text is entered (WHO source / V-supplied).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ClipboardList, CalendarDays, Target, Mic, Calculator, AlertTriangle, Sparkles, Trash2, RefreshCw } from 'lucide-react';
import type { SurgicalSeries, AdhocSetView } from '@/lib/proms/schedule';
import type { DueInstrument } from '@/lib/proms/schedule-core';
import { scoreInstrument, type ItemResponse } from '@/lib/proms/schedule-core';
import { instrumentById, SHARED_SCALES, ARCHETYPE_WINDOWS, ESCALATION, type Window, type Scale } from '@/lib/proms/catalog';
import { scoreAdhocSet } from '@/lib/proms/adhoc-core';
import type { BankItem } from '@/lib/proms/item-bank-core';

interface Administered { instrument_id: string; window: string; administered_at: string; score: number | null; score_scale: string; escalations: string[] }
interface ScheduleResp { ok: boolean; series: SurgicalSeries | null; administered?: Administered[] }

const WINDOW_LABEL: Record<Window, string> = {
  baseline: 'Baseline pre-op', d72h: '72 hours', w2: '2 weeks', w6: '6 weeks', m3: '3 months', m6: '6 months', m12: '12 months',
};
const day = (s: string | null | undefined) => (typeof s === 'string' ? s.slice(0, 10) : '');
const escLabel = (code: string) => ESCALATION.find((e) => e.code === code)?.rule ?? code;

export default function PromsPanel({ individualUid }: { individualUid: string }) {
  const [data, setData] = useState<ScheduleResp | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [answers, setAnswers] = useState<Record<string, string>>({});   // `${instrumentId}:${itemId}` → value
  const [saved, setSaved] = useState<string>('');
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setState('loading');
    fetch(`/api/care-call/proms/schedule?individual_uid=${encodeURIComponent(individualUid)}`)
      .then(async (r) => (r.ok ? r.json() : { __status: r.status }))
      .then((j: ScheduleResp & { __status?: number }) => {
        if (!alive) return;
        if (j?.ok && j.series) { setData(j); setState('ready'); }
        else if (j?.ok && j.series === null) setState('empty');
        else setState('error');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [individualUid, nonce]);

  const series = data?.series ?? null;
  const administered = data?.administered ?? [];
  const doneWindows = useMemo(() => new Set(administered.map((a) => a.window)), [administered]);

  // per-window bounds/status from the compiled due list (all instruments in a window share bounds).
  const windows = series ? ARCHETYPE_WINDOWS[series.archetype] : [];
  const byWindow = useMemo(() => {
    const m = new Map<string, DueInstrument[]>();
    for (const d of series?.due ?? []) { const a = m.get(d.window) ?? []; a.push(d); m.set(d.window, a); }
    return m;
  }, [series]);
  const openWindow = windows.find((w) => byWindow.get(w)?.some((d) => d.status === 'in_window')) ?? null;
  const openInstruments = openWindow
    ? Array.from(new Set((byWindow.get(openWindow) ?? []).map((d) => d.instrumentId)))
    : [];

  if (state === 'empty' || state === 'error') return null;   // no surgical series → hide (fail-safe)

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-200 px-4 py-3">
        <ClipboardList className="h-4 w-4 text-teal-600" />
        <span className="text-[14px] font-semibold text-slate-800">Surgical recovery · PROMs</span>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">advisory · care-call/0.2</span>
        {series && (
          <span className="ml-auto text-right text-[11px] text-slate-400">
            {series.procedureName || series.family}{series.plannedDate ? ` · surgery ${series.plannedDate}` : ''}<br />
            {series.family} · {series.archetype} · prom-catalog/0.1
          </span>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {state === 'loading' && <div className="flex items-center gap-2 py-4 text-[12.5px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Detecting surgical series…</div>}

        {series && (
          <>
            {/* ── Recovery schedule strip ─────────────────────────────── */}
            <div>
              <SectionHead icon={CalendarDays} title="Recovery schedule" sub={`${series.archetype} archetype · anchored on surgery/discharge`} />
              <div className="flex overflow-hidden rounded-lg border border-slate-200">
                {windows.map((w) => {
                  const items = byWindow.get(w) ?? [];
                  const st = items[0]?.status;
                  const done = doneWindows.has(w);
                  const cls = done ? 'bg-emerald-50' : st === 'in_window' ? 'bg-amber-50 ring-2 ring-inset ring-amber-300'
                    : st === 'missed' ? 'bg-rose-50' : 'bg-slate-50/60';
                  const stTxt = done ? '✓ captured' : st === 'in_window' ? '● DUE now' : st === 'missed' ? 'missed' : 'upcoming';
                  const stColor = done ? 'text-emerald-700' : st === 'in_window' ? 'text-amber-700' : st === 'missed' ? 'text-rose-700' : 'text-slate-400';
                  const range = w === 'baseline' ? 'pre-op' : items[0] ? `${day(items[0].opensAt)}–${day(items[0].closesAt)}` : '';
                  return (
                    <div key={w} className={`flex-1 border-r border-slate-200 px-2 py-2.5 text-center last:border-r-0 ${cls}`}>
                      <div className="text-[12px] font-bold text-slate-700">{WINDOW_LABEL[w]}</div>
                      <div className="text-[10px] text-slate-400">{range}</div>
                      <div className={`mt-1 text-[10.5px] font-bold ${stColor}`}>{stTxt}</div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">Windows are deterministic (± tolerance off the discharge/surgery date). prom-sched/0.1.</p>
            </div>

            {/* ── Due this call ───────────────────────────────────────── */}
            <div>
              <SectionHead icon={Target} title="Due this call" sub={openWindow ? `${WINDOW_LABEL[openWindow]} window` : 'no open window'} />
              {openInstruments.length ? (
                <div className="space-y-0.5">
                  {openInstruments.map((id) => {
                    const def = instrumentById(id);
                    return (
                      <div key={id} className="flex items-center gap-2 border-b border-dashed border-slate-100 py-1.5 text-[12.5px] last:border-0">
                        <span className="font-semibold text-slate-700">{def?.label ?? id}</span>
                        <span className="ml-auto text-[11px] text-slate-400">
                          {def?.kind === 'validated' ? (id === 'whodas12' ? 'validated · WHO item text pending' : 'validated') : `house${def?.items?.length ? ` · ${def.items.length} items` : ''}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="text-[12px] text-slate-500">No instruments are due in an open window right now.</p>}
            </div>

            {/* ── Tier-3 tailored (adhoc) set — unmapped family only, behind TIER3_ENABLED ─ */}
            {series.tier3 && (
              <AdhocFlow series={series} openWindow={openWindow} reload={reload} />
            )}

            {/* ── Administer ──────────────────────────────────────────── */}
            {openInstruments.length > 0 && (
              <div>
                <SectionHead icon={Mic} title="Administer" sub="read each item verbatim · tap the patient's answer" />
                <div className="space-y-3">
                  {openInstruments.map((id) => (
                    <Administer key={id} instrumentId={id} answers={answers} setAnswers={setAnswers} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Score + escalation ──────────────────────────────────── */}
            <ScorePanel openInstruments={openInstruments} answers={answers} />

            {/* ── Save ────────────────────────────────────────────────── */}
            {openWindow && openInstruments.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => saveAll(series, openWindow, openInstruments, answers, setSaved)}
                  className="rounded-lg bg-teal-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-teal-700"
                >Save administration</button>
                {saved && <span className="text-[11.5px] text-slate-500">{saved}</span>}
              </div>
            )}

            <p className="text-[11px] text-slate-400">
              Scores land as dated numeric series feeding the MemberState spine (pre-op baseline = the appropriateness signal).
              Raw responses stored immutably; house scores never cross-patient benchmarked. prom-sched/0.1 · prom-scoring/0.1.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function SectionHead({ icon: Icon, title, sub }: { icon: typeof Target; title: string; sub?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-1.5">
      <Icon className="h-4 w-4 shrink-0 translate-y-0.5 text-slate-400" />
      <span className="text-[13px] font-semibold text-slate-800">{title}</span>
      {sub && <span className="text-[11.5px] font-normal text-slate-400">· {sub}</span>}
    </div>
  );
}

/** One instrument's items rendered verbatim; chips = the item's scale. Pending for validated/PREM. */
function Administer({ instrumentId, answers, setAnswers }: { instrumentId: string; answers: Record<string, string>; setAnswers: (f: (a: Record<string, string>) => Record<string, string>) => void }) {
  const def = instrumentById(instrumentId);
  if (!def) return null;
  const pick = (itemId: string, value: string) => setAnswers((a) => ({ ...a, [`${instrumentId}:${itemId}`]: value }));

  // pain_nrs is validated with items:[] but administrable as a single NRS-11 row (mockup).
  const rows: { itemId: string; text: string | null; scale: Scale; escalation?: string | null }[] =
    def.items.length ? def.items.map((it) => ({ itemId: it.id, text: it.text, scale: it.scale, escalation: it.escalation }))
    : instrumentId === 'pain_nrs' ? [{ itemId: 'pain', text: 'Pain at the operation site today (0 = none, 10 = worst)', scale: 'NRS-11' }]
    : [];

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2 text-[12px] italic text-slate-400">
        {def.label} — {instrumentId === 'whodas12' ? 'WHODAS 2.0 item text pending (entered verbatim from the WHO source at 0.2a-2)' : 'item text pending'}.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">{def.label}</div>
      {rows.map((r) => {
        const opts = SHARED_SCALES[r.scale] ?? [];
        const sel = answers[`${instrumentId}:${r.itemId}`];
        return (
          <div key={r.itemId} className="border-b border-slate-100 py-2 last:border-0">
            <div className="mb-1.5 text-[12.5px] font-medium text-slate-700">
              {r.text ?? <span className="italic text-slate-400">item text pending</span>}
              {r.escalation && <span className="ml-1.5 text-[10.5px] font-bold text-amber-600">⚠ {r.escalation}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {opts.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => pick(r.itemId, o)}
                  className={`rounded-full border px-2.5 py-1 text-[12px] ${sel === o ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'}`}
                >{o}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Deterministic score preview (scoreInstrument) + ⚠ escalations for the answered house instruments. */
function ScorePanel({ openInstruments, answers }: { openInstruments: string[]; answers: Record<string, string> }) {
  const scored = openInstruments.map((id) => {
    const responses: ItemResponse[] = Object.entries(answers)
      .filter(([k]) => k.startsWith(`${id}:`))
      .map(([k, value]) => ({ itemId: k.slice(id.length + 1), value }));
    if (!responses.length) return null;
    const s = scoreInstrument(id, responses);
    return { id, label: instrumentById(id)?.label ?? id, ...s };
  }).filter(Boolean) as { id: string; label: string; score: number | null; scale: string; escalations: string[] }[];

  if (!scored.length) return null;
  const escalations = Array.from(new Set(scored.flatMap((s) => s.escalations)));

  return (
    <div>
      <SectionHead icon={Calculator} title="Score" sub="deterministic · house sum · within-patient trend only" />
      <div className="space-y-2">
        {scored.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg border border-teal-100 bg-teal-50/40 px-3 py-2">
            <div className="text-[20px] font-extrabold text-teal-800">{s.score ?? '—'}</div>
            <div className="text-[12px] text-slate-600"><b className="text-slate-700">{s.label}</b> · {s.scale}{s.score == null ? ' · needs the full set to score' : ' · lands as a dated point on this member’s series'}</div>
          </div>
        ))}
      </div>
      {escalations.map((code) => (
        <div key={code} className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><b>▲ {code} escalation</b> — {escLabel(code)}. Scripted advise-review + added to today's escalation list.</span>
        </div>
      ))}
    </div>
  );
}

/** POST each answered instrument as one administration (server re-scores authoritatively). */
async function saveAll(
  series: SurgicalSeries, window: string, openInstruments: string[],
  answers: Record<string, string>, setSaved: (s: string) => void,
) {
  setSaved('Saving…');
  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  let ok = 0, fail = 0;
  for (const id of openInstruments) {
    const raw: ItemResponse[] = Object.entries(answers)
      .filter(([k]) => k.startsWith(`${id}:`))
      .map(([k, value]) => ({ itemId: k.slice(id.length + 1), value }));
    if (!raw.length) continue;
    try {
      const r = await fetch('/api/care-call/proms/response', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uid(), individual_uid: series.individualUid, instrument_id: id, window, raw, series_id: `psr:${series.individualUid}` }),
      });
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }
  setSaved(fail ? `Saved ${ok}, ${fail} failed (check migration)` : `Saved ${ok} administration${ok === 1 ? '' : 's'} · folds into the spine`);
}

const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e6)}`);

// ── Tier-3 tailored (adhoc) set flow (0.2b-2) — matches the normative CDMSS-PROMS-0.2b-2-MOCKUP-ADHOC-FLOW.
// Unmapped family only, behind TIER3_ENABLED (the server attaches series.tier3). SELECTION-ONLY: items are
// chosen from the ratified library — wording is never invented. Draft → trim/regenerate → freeze-on-first-
// administration (T4). Scored via the shipped scoreAdhocSet (house sum); labelled adhoc, never benchmarked.
interface AdhocFlowSet extends AdhocSetView { gaps?: string[] }
function AdhocFlow({ series, openWindow, reload }: { series: SurgicalSeries; openWindow: Window | null; reload: () => void }) {
  const [set, setSet] = useState<AdhocFlowSet | null>((series.tier3?.set as AdhocFlowSet) ?? null);
  const [gaps, setGaps] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'gen' | 'trim' | 'regen' | 'save'>('');
  const [administering, setAdministering] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});   // itemId → value
  const [msg, setMsg] = useState('');

  const procedure = series.procedureName || '';
  const seriesId = `psr:${series.individualUid}`;
  const available = !!series.tier3?.available && !set;

  const scored = useMemo(() => {
    if (!set) return null;
    const responses: ItemResponse[] = set.items.map((it) => ({ itemId: it.id, value: answers[it.id] })).filter((a) => a.value);
    if (!responses.length) return null;
    const items = set.items.map((i) => ({ id: i.id, text: i.text, scale: i.scale, escalation: i.escalation, sourceSet: i.sourceSet })) as unknown as BankItem[];
    return scoreAdhocSet({ items }, responses);
  }, [set, answers]);

  async function generate(regen = false) {
    setBusy(regen ? 'regen' : 'gen'); setMsg('');
    try {
      const url = regen ? '/api/care-call/proms/adhoc/update' : '/api/care-call/proms/adhoc/generate';
      const body = regen
        ? { individual_uid: series.individualUid, series_id: seriesId, procedure_context: procedure, regenerate: true }
        : { individual_uid: series.individualUid, series_id: seriesId, procedure_context: procedure };
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j?.ok && j.set && Array.isArray(j.set.items)) { setSet(j.set as AdhocFlowSet); setGaps(Array.isArray(j.set.gaps) ? j.set.gaps : []); }
      else if (j?.ok && !j.set) setMsg('No library item fits this procedure — the core stack still administers (WHODAS-12 · pain NRS · return-to-function).');
      else if (r.status === 409) setMsg('This set is frozen — it can no longer be regenerated.');
      else setMsg(j?.error || 'Generation failed.');
    } catch { setMsg('Generation failed.'); }
    setBusy('');
  }

  async function removeItem(id: string) {
    if (!set || set.status === 'frozen') return;
    const remaining = set.items.filter((i) => i.id !== id);
    const prev = set;
    setSet({ ...set, items: remaining });   // optimistic
    setBusy('trim');
    try {
      const r = await fetch('/api/care-call/proms/adhoc/update', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ individual_uid: series.individualUid, series_id: seriesId, item_ids: remaining.map((i) => i.id) }),
      });
      if (!r.ok) { setSet(prev); setMsg(r.status === 409 ? 'This set is frozen — it can no longer be edited.' : 'Could not remove the item.'); }
    } catch { setSet(prev); setMsg('Could not remove the item.'); }
    setBusy('');
  }

  async function administer() {
    if (!set || !openWindow) return;
    const raw: ItemResponse[] = set.items.map((it) => ({ itemId: it.id, value: answers[it.id] })).filter((a) => a.value);
    if (!raw.length) { setMsg('Enter the patient’s answers first.'); return; }
    setBusy('save'); setMsg('');
    try {
      const r = await fetch('/api/care-call/proms/response', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: newId(), individual_uid: series.individualUid, instrument_id: set.id, window: openWindow, adhoc_set_ref: set.id, series_id: seriesId, raw }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) { setMsg('Administered — this set is now frozen for the member’s series.'); reload(); }
      else setMsg(j?.error || 'Save failed (check migration).');
    } catch { setMsg('Save failed.'); }
    setBusy('');
  }

  // ── unmapped, no set yet → offer generate ──
  if (available) {
    return (
      <div className="rounded-xl border border-dashed border-purple-200 bg-purple-50/60 px-4 py-3.5">
        <div className="mb-0.5 flex items-center gap-2 text-[13px] font-semibold text-purple-800"><Sparkles className="h-4 w-4" /> Tailored set available</div>
        <p className="text-[12px] text-purple-900/70">No ratified instrument maps to “{procedure || 'this procedure'}.” A set can be assembled from the ratified question library for this procedure — <b>selection-only</b>, wording never invented.</p>
        <button type="button" disabled={busy === 'gen'} onClick={() => generate(false)}
          className="mt-2.5 inline-flex items-center gap-2 rounded-lg bg-purple-700 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-purple-800 disabled:opacity-60">
          {busy === 'gen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Generate a tailored set
        </button>
        {msg && <p className="mt-2 text-[11.5px] text-slate-500">{msg}</p>}
      </div>
    );
  }

  if (!set) { return msg ? <p className="text-[11.5px] text-slate-500">{msg}</p> : null; }

  const isFrozen = set.status === 'frozen';
  const inAdminMode = administering || isFrozen;

  return (
    <div className="overflow-hidden rounded-xl border border-purple-200 bg-white ring-2 ring-inset ring-purple-50">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-purple-600" />
        <span className="text-[14px] font-bold text-purple-800">Tailored set</span>
        <span className="rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[10.5px] font-bold text-purple-700">Adhoc</span>
        {isFrozen
          ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10.5px] font-bold text-emerald-700">Frozen · immutable</span>
          : <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] font-bold text-amber-700">Draft — editable until first use</span>}
        <span className="ml-auto text-[11px] text-slate-400">{set.genVersion || 'adhoc-gen/0.1'}</span>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        <p className="rounded-lg border border-purple-100 bg-purple-50/70 px-3 py-2 text-[12px] text-purple-900/80">
          <b className="text-purple-800">Selection-only:</b> every item was chosen from the ratified question library — wording is never changed or invented. {isFrozen ? 'This set is locked for the series so scores stay comparable across windows.' : 'Drop an item or regenerate before you administer; the first administration locks the set for this member.'}
        </p>

        {set.items.map((it, i) => (
          <div key={it.id} className="flex gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
            <div className="pt-0.5 text-[12px] font-bold text-purple-700">{i + 1}</div>
            <div className="min-w-0 flex-1">
              {inAdminMode
                ? <AdhocAnswerRow item={it} value={answers[it.id]} onPick={(v) => setAnswers((a) => ({ ...a, [it.id]: v }))} />
                : <div className="mb-1 text-[13px] text-slate-700">{it.text ?? <span className="italic text-slate-400">item text pending</span>}</div>}
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-px font-mono text-[10.5px] font-bold text-slate-600">{it.scale}</span>
                <span className="rounded border border-purple-200 bg-purple-50 px-1.5 py-px font-mono text-[10.5px] text-purple-700">{it.sourceSet}</span>
                {it.escalation && <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-px text-[10.5px] font-bold text-amber-700">⚠ escalates</span>}
              </div>
              {it.rationale && <div className="text-[11.5px] text-slate-500"><b className="text-slate-600">Why:</b> {it.rationale}</div>}
            </div>
            {!inAdminMode && (
              <button type="button" disabled={busy === 'trim'} onClick={() => removeItem(it.id)}
                className="h-fit shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-500 hover:border-slate-300 disabled:opacity-50">
                <Trash2 className="mr-1 inline h-3 w-3" />Remove
              </button>
            )}
          </div>
        ))}

        {!!gaps.length && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
            <b>Coverage note:</b> {gaps.join('; ')}. Selection-only can’t author a new item — flagged for the review queue; the core stack + these items still administer.
          </div>
        )}

        {inAdminMode && <AdhocScore scored={scored} />}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {!inAdminMode ? (
            <>
              <button type="button" onClick={() => setAdministering(true)} className="rounded-lg bg-teal-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-teal-700">Accept &amp; administer</button>
              <button type="button" disabled={busy === 'regen'} onClick={() => generate(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-[13px] font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-60">
                {busy === 'regen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Regenerate
              </button>
              <span className="ml-auto max-w-[280px] text-right text-[11px] text-slate-400">Administering pins this exact set for the series (all windows) — immutable afterwards.</span>
            </>
          ) : (
            <>
              <button type="button" disabled={busy === 'save' || !openWindow} onClick={administer}
                className="rounded-lg bg-teal-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-teal-700 disabled:opacity-60">
                {busy === 'save' ? 'Saving…' : 'Save administration'}
              </button>
              {!openWindow && <span className="text-[11.5px] text-slate-400">No open window right now — administer when a window opens.</span>}
              {msg && <span className="text-[11.5px] text-slate-500">{msg}</span>}
            </>
          )}
        </div>

        {!inAdminMode && msg && <p className="text-[11.5px] text-slate-500">{msg}</p>}

        <p className="border-t border-slate-100 pt-2.5 text-[11px] text-slate-400">
          <b className="text-slate-600">How this is recorded:</b> labelled <b>adhoc</b> · scored as a house simple-sum · <b>within-hospital, within-patient trend only — never benchmarked or pooled across patients</b>. English verbatim. adhoc-gen/0.1 · prom-scoring/0.1.
        </p>
      </div>
    </div>
  );
}

/** One adhoc item rendered as answerable chips (administration mode). */
function AdhocAnswerRow({ item, value, onPick }: { item: AdhocSetView['items'][number]; value: string | undefined; onPick: (v: string) => void }) {
  const opts = SHARED_SCALES[item.scale as Scale] ?? [];
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-slate-700">
        {item.text ?? <span className="italic text-slate-400">item text pending</span>}
        {item.escalation && <span className="ml-1.5 text-[10.5px] font-bold text-amber-600">⚠ {item.escalation}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {opts.map((o) => (
          <button key={o} type="button" onClick={() => onPick(o)}
            className={`rounded-full border px-2.5 py-1 text-[12px] ${value === o ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'}`}>{o}</button>
        ))}
      </div>
    </div>
  );
}

/** Adhoc score preview (scoreAdhocSet) + ⚠ escalations. */
function AdhocScore({ scored }: { scored: { score: number | null; scale: string; escalations: string[] } | null }) {
  if (!scored) return null;
  return (
    <div>
      <div className="flex items-center gap-3 rounded-lg border border-purple-100 bg-purple-50/50 px-3 py-2">
        <div className="text-[20px] font-extrabold text-purple-800">{scored.score ?? '—'}</div>
        <div className="text-[12px] text-slate-600"><b className="text-slate-700">Tailored set</b> · house sum{scored.score == null ? ' · needs the full set to score' : ' · lands on this member’s series (keyed by the adhoc set — never pooled)'}</div>
      </div>
      {Array.from(new Set(scored.escalations)).map((code) => (
        <div key={code} className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><b>▲ {code} escalation</b> — {escLabel(code)}. Scripted advise-review + added to today’s escalation list.</span>
        </div>
      ))}
    </div>
  );
}
