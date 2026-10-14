'use client';

/**
 * Even Adjudicated LVC board (CDMSS-EVEN-LVC-ADJUDICATION §7). A roster-driven identity picker (like
 * Review Mode) → sets `ratified_by`; a Pending queue of Kimi-proposed candidates (Ratify / Edit &
 * ratify / Reject); an Active/Contested library (status+version, ratifier + own-cases flag, contest
 * count, Retire). Honesty banner: you ratify alone → "ratified by 1" → internal-consensus tier, below
 * external. Advisory until validated. Tailwind + lucide, matching the /care card conventions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Stamp, Sparkles, AlertTriangle, Archive, Pencil, Check, X } from 'lucide-react';
import GroundingPanel from './GroundingPanel';

type Supporting = { subject: string; count: number };
type Assertion = {
  id: string; lvc_category: string; assertion_text: string; rationale: string | null;
  supporting: Supporting[]; status: string; version: number; generated_by: string | null;
  ratified_by: string | null; ratified_at: string | null; own_cases: boolean; contest_count: number;
};
type Board = {
  ok: boolean; roster?: string[]; pending: Assertion[]; active: Assertion[]; contested: Assertion[];
  retired: Assertion[]; rejected: Assertion[]; pendingCount: number; error?: string;
};

const post = async (url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(String(j.error || `status ${r.status}`));
  return j;
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function CategoryChip({ c }: { c: string }) {
  return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">{c}</span>;
}

export default function LvcBoard() {
  const [phase, setPhase] = useState<'identify' | 'board'>('identify');
  const [roster, setRoster] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);      // id currently acting on
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genElapsed, setGenElapsed] = useState(0);   // heartbeat: seconds since the Generate POST started

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/care/lvc/list');
      const j = (await r.json()) as Board;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setBoard(j);
      if (j.roster && j.roster.length) setRoster(j.roster);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Generate heartbeat: while the (~2-min) POST is in flight, tick a live elapsed timer so the operator
  // can see it's alive. Resets on start; cleared on completion/unmount. Purely a client affordance.
  useEffect(() => {
    if (busy !== '__gen') return;
    setGenElapsed(0);
    const t = setInterval(() => setGenElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const start = (name: string) => { setReviewer(name); setPhase('board'); };

  const generate = async () => {
    setBusy('__gen'); setGenMsg(null); setErr(null);
    try {
      // Addendum A §5: the generate route ALWAYS returns HTTP 200, carrying the outcome as
      // { status: ok|error|skipped, reason, n_candidates }. Do NOT route through post() — its
      // `j.ok === false` guard would throw "status 200" and hide a hard failure behind a transport
      // code. Read the outcome directly; only a genuine non-200 (disabled/unauthorized) is a throw.
      const r = await fetch('/api/care/lvc/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = (await r.json().catch(() => ({}))) as { status?: string; reason?: string; n_candidates?: number; error?: string };
      if (!r.ok) throw new Error(String(j.error || `status ${r.status}`));
      const status = String(j.status ?? 'ok'); const n = Number(j.n_candidates ?? 0); const reason = String(j.reason || '');
      setGenMsg(status === 'ok' ? `Generated ${n} candidate${n === 1 ? '' : 's'}.` : status === 'skipped' ? `Skipped — ${reason || 'nothing new'}.` : `Generation error — ${reason || 'no candidates'} (no fallback used).`);
      await load();
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  };

  const ratify = async (a: Assertion, text?: string) => {
    setBusy(a.id); setErr(null);
    try { await post('/api/care/lvc/ratify', { id: a.id, ratified_by: reviewer, ...(text != null ? { assertion_text: text } : {}) }); setEditing(null); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  };
  const reject = async (a: Assertion) => { setBusy(a.id); setErr(null); try { await post('/api/care/lvc/reject', { id: a.id }); await load(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(null); } };
  const retire = async (a: Assertion) => { setBusy(a.id); setErr(null); try { await post('/api/care/lvc/retire', { id: a.id }); await load(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(null); } };

  const pendingCount = board?.pending.length ?? 0;
  const activeLike = useMemo(() => [...(board?.active ?? []), ...(board?.contested ?? [])], [board]);

  // ── identity gate ──
  if (phase === 'identify') {
    return (
      <div className="mx-auto max-w-lg px-5 py-12" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-amber-500" /><h1 className="text-[18px] font-semibold text-slate-900">Even Adjudicated LVC</h1></div>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-500">Ratify the low-value-care patterns Even&apos;s own audits surface — then ground future audits against them. Pick your reviewer identity to start.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {(roster.length ? roster : ['V', 'Zaki', 'Aravind', 'Binita']).map((name) => (
            <button key={name} onClick={() => start(name)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 transition hover:border-amber-300 hover:bg-amber-50">{name}</button>
          ))}
        </div>
        {err && <p className="mt-4 text-[12px] text-red-600">{err}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-amber-500" />
          <h1 className="text-[19px] font-semibold text-slate-900">Even Adjudicated LVC</h1>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">Advisory · internal consensus</span>
        </div>
        <div className="text-[12px] text-slate-500">Ratifying as <span className="font-semibold text-slate-700">{reviewer}</span></div>
      </div>

      {/* honesty banner (guardrail #2/#7) */}
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-900">
        You ratify alone → each assertion is labelled <span className="font-semibold">&quot;Even Adjudicated LVC · ratified by 1&quot;</span> and carries the <span className="font-semibold">internal-consensus</span> provenance tier — ranked <span className="font-semibold">below</span> external evidence (CDSCO / ICMR / guideline). Nothing here changes an audit score; it only attaches a post-hoc citation. Advisory until you validate.
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={generate} disabled={busy === '__gen'} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-slate-700 disabled:opacity-50">
          <Sparkles className="h-3.5 w-3.5" />{busy === '__gen' ? 'Generating…' : 'Generate candidates'}
        </button>
        {busy === '__gen' && (
          <span className="text-[12px] text-slate-500">
            <span className="font-medium tabular-nums text-slate-700">{mmss(genElapsed)}</span> · usually ~2 minutes — safe to leave open
          </span>
        )}
        {busy !== '__gen' && genMsg && <span className="text-[12px] text-slate-500">{genMsg}</span>}
      </div>

      {err && <p className="mt-3 text-[12px] text-red-600">{err}</p>}
      {loading && !board && <p className="mt-6 text-[13px] text-slate-400">Loading…</p>}

      {/* Grounding worker status (EVEN-LVC-GROUNDING §7) — ABOVE the library, right under Generate. */}
      <GroundingPanel />

      {/* ── Pending queue ── */}
      <section className="mt-6">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800"><Stamp className="h-4 w-4 text-slate-400" />Pending ratification <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{pendingCount}</span></h2>
        {pendingCount === 0 && <p className="mt-2 text-[12.5px] text-slate-400">No candidates awaiting ratification. Generate to propose new ones from Even&apos;s audited corpus.</p>}
        <div className="mt-3 space-y-3">
          {board?.pending.map((a) => (
            <div key={a.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <CategoryChip c={a.lvc_category} />
                <span className="text-[11px] text-slate-400">{a.id}</span>
              </div>
              {editing === a.id ? (
                <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-slate-300 p-2 text-[13px] text-slate-800" />
              ) : (
                <p className="mt-2 text-[14px] font-medium leading-snug text-slate-900">{a.assertion_text}</p>
              )}
              {a.rationale && <p className="mt-1 text-[12px] italic text-slate-500">{a.rationale}</p>}
              {a.supporting?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.supporting.slice(0, 8).map((s, i) => (
                    <span key={i} className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500">{s.subject} · {s.count}×</span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {editing === a.id ? (
                  <>
                    <button onClick={() => ratify(a, editText)} disabled={busy === a.id} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><Check className="h-3.5 w-3.5" />Save &amp; ratify</button>
                    <button onClick={() => setEditing(null)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-50"><X className="h-3.5 w-3.5" />Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => ratify(a)} disabled={busy === a.id} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><Check className="h-3.5 w-3.5" />Ratify</button>
                    <button onClick={() => { setEditing(a.id); setEditText(a.assertion_text); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" />Edit &amp; ratify</button>
                    <button onClick={() => reject(a)} disabled={busy === a.id} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12.5px] text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"><X className="h-3.5 w-3.5" />Reject</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Active / Contested library ── */}
      <section className="mt-8">
        <h2 className="text-[14px] font-semibold text-slate-800">Active library <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{activeLike.length}</span></h2>
        {activeLike.length === 0 && <p className="mt-2 text-[12.5px] text-slate-400">No ratified assertions yet.</p>}
        <div className="mt-3 space-y-2.5">
          {activeLike.map((a) => (
            <div key={a.id} className={`rounded-2xl border p-4 ${a.status === 'contested' ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CategoryChip c={a.lvc_category} />
                  <span className="text-[11px] text-slate-400">v{a.version}</span>
                  {a.status === 'contested' && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"><AlertTriangle className="h-3 w-3" />contested</span>}
                </div>
                <span className="text-[11px] text-slate-400">{a.id}</span>
              </div>
              <p className="mt-2 text-[13.5px] leading-snug text-slate-900">{a.assertion_text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-500">
                <span>ratified by 1: <span className="font-medium text-slate-700">{a.ratified_by || '—'}</span></span>
                {a.own_cases && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700">own cases</span>}
                <span>contests: {a.contest_count}</span>
              </div>
              <div className="mt-2.5">
                <button onClick={() => retire(a)} disabled={busy === a.id} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-500 hover:bg-slate-50 disabled:opacity-50"><Archive className="h-3.5 w-3.5" />Retire</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {board && board.retired.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[14px] font-semibold text-slate-500">Retired <span className="text-[11px] text-slate-400">({board.retired.length})</span></h2>
          <div className="mt-2 space-y-1.5">
            {board.retired.map((a) => (
              <div key={a.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2 text-[12px] text-slate-500">
                <span className="mr-2 font-medium">{a.lvc_category}</span>{a.assertion_text}
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-8 text-[11.5px] text-slate-400">Post-hoc grounding only — assertions never enter an audit prompt or any scorer. They attach an inline citation on matching low-value findings, ranked below external evidence.</p>
    </div>
  );
}
