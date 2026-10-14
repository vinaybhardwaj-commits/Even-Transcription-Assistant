'use client';

/**
 * SignalHealthPanel — Tier 0/1 self-healing (PRD §7). Per signal_type validated-FP rates from CM
 * triage, and human-approved suppression management with the dual-label safety check enforced before
 * anything goes live. Reads /api/opd-triage/signal-health; writes /api/opd-triage/suppressions.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, ShieldCheck, ShieldOff, RefreshCw, Info } from 'lucide-react';

interface Health {
  signal_type: string; label: string; decided: number; valid: number; audit_bug: number;
  process_bug: number; structural_bug: number; routed: number; fp_rate: number;
  trend: string; top_reasons: { reason: string; n: number }[]; healable: boolean;
}
interface Suppression {
  id: string; signal_type: string; discriminator: string | null; match_kind: string; scope: string;
  doctor_uid: string | null; action: string; reason: string | null; active: boolean; created_by: string | null;
}
interface Preview { would_suppress: number; collateral: number; safe: boolean; collateral_examples: { doctor_uid: string; subject: string }[] }

const pct = (r: number) => `${Math.round(r * 100)}%`;
const trendColor: Record<string, string> = { improving: 'text-emerald-600', worsening: 'text-rose-600', flat: 'text-slate-400', insufficient: 'text-slate-300' };

export default function SignalHealthPanel() {
  const [health, setHealth] = useState<Health[]>([]);
  const [supps, setSupps] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ signal_type: string; label: string } | null>(null);
  // Quieting-volume guard (PRD §10): if active demote rules ever silence a majority of low-value
  // findings, the audit has been configured into silence — the number must be VISIBLE here.
  const [quietVol, setQuietVol] = useState<{ quieted: number; low_value: number; gen: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const j = await fetch('/api/opd-triage/signal-health', { cache: 'no-store' }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'failed');
      setHealth(j.health || []); setSupps(j.suppressions || []);
    } catch (e) { setErr(String((e as Error).message)); } finally { setLoading(false); }
    try {
      const q = await fetch('/api/opd-triage/suppressions', { cache: 'no-store' }).then((r) => r.json());
      if (q.ok && q.quieted_volume_30d) setQuietVol({ ...q.quieted_volume_30d, gen: q.current_gen ?? 0 });
    } catch { /* volume line is best-effort */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(id: string, active: boolean) {
    await fetch('/api/opd-triage/suppressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'toggle', id, active }) });
    load();
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-7" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-slate-900">Signal health</h1>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">Self-healing · Tier 0/1</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="/care/triage" className="text-[12.5px] text-sky-700 hover:underline">← Triage</a>
          <button onClick={load} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:border-slate-300"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <p className="mt-0.5 text-[12.5px] text-slate-500">Validated false-positive rates per signal type, from care-manager triage. A suppression may only remove flagged FPs if it removes no validated signal.</p>
      {quietVol && quietVol.gen > 0 && (
        <div className={`mt-2 rounded-lg border px-3 py-2 text-[12.5px] ${
          quietVol.low_value > 0 && quietVol.quieted / Math.max(1, quietVol.low_value) > 0.5
            ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-violet-200 bg-violet-50/60 text-violet-800'}`}>
          Quieting volume (30d): <b>{quietVol.quieted}</b> finding(s) quieted vs {quietVol.low_value} low-value flagged · policy gen {quietVol.gen}.
          {quietVol.low_value > 0 && quietVol.quieted / Math.max(1, quietVol.low_value) > 0.5 && (
            <b> Majority of low-value findings are being quieted — the audit is approaching configured silence; review the active rules.</b>
          )}
        </div>
      )}

      {loading ? (
        <div className="mt-16 flex justify-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : err ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700"><AlertTriangle className="h-4 w-4" /> {err}</div>
      ) : (
        <>
          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-[12.5px]">
              <thead><tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Signal type</th><th className="px-2">Decided</th><th className="px-2">Valid</th>
                <th className="px-2">FP rate</th><th className="px-2">Struct/Proc</th><th className="px-2">Trend</th><th className="px-2">Top reason</th><th className="px-2"></th>
              </tr></thead>
              <tbody>
                {health.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">No triage decisions yet — the view fills as care managers work the queue.</td></tr>}
                {health.map((h) => (
                  <tr key={h.signal_type} className="border-t border-slate-50 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-800">{h.label}</td>
                    <td className="px-2 text-slate-600">{h.decided}</td>
                    <td className="px-2 text-slate-600">{h.valid}</td>
                    <td className="px-2"><span className={h.fp_rate >= 0.5 ? 'font-semibold text-rose-600' : h.fp_rate >= 0.25 ? 'text-amber-600' : 'text-slate-600'}>{pct(h.fp_rate)}</span></td>
                    <td className="px-2 text-slate-600">{h.structural_bug}/{h.process_bug}</td>
                    <td className={`px-2 ${trendColor[h.trend] || 'text-slate-400'}`}>{h.trend}</td>
                    <td className="px-2 text-slate-500">{h.top_reasons[0]?.reason ? `${h.top_reasons[0].reason} (${h.top_reasons[0].n})` : '—'}</td>
                    <td className="px-2 text-right">
                      {h.healable && <button onClick={() => setForm({ signal_type: h.signal_type, label: h.label })} className="rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:border-slate-300">Suppress…</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {form && <SuppressForm target={form} onClose={() => setForm(null)} onCreated={() => { setForm(null); load(); }} />}

          <h2 className="mt-7 text-[12px] font-medium uppercase tracking-wide text-slate-400">Active + past suppressions</h2>
          <div className="mt-2 space-y-1.5">
            {supps.length === 0 && <div className="rounded-lg border border-slate-200 bg-white px-3 py-6 text-center text-[13px] text-slate-400">No suppressions yet.</div>}
            {supps.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px]">
                {s.active ? <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" /> : <ShieldOff className="h-4 w-4 shrink-0 text-slate-300" />}
                <span className="font-medium text-slate-800">{s.signal_type}</span>
                <span className="text-slate-500">{s.match_kind === 'subject_contains' ? `contains “${s.discriminator}”` : 'whole type'} · {s.scope}{s.doctor_uid ? ` (${s.doctor_uid})` : ''} · {s.action}</span>
                {s.reason && <span className="truncate text-slate-400">— {s.reason}</span>}
                <button onClick={() => toggle(s.id, !s.active)} className="ml-auto rounded-md border border-slate-200 px-2 py-0.5 text-[11.5px] text-slate-600 hover:border-slate-300">{s.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SuppressForm({ target, onClose, onCreated }: { target: { signal_type: string; label: string }; onClose: () => void; onCreated: () => void }) {
  const [matchKind, setMatchKind] = useState<'type_only' | 'subject_contains'>('subject_contains');
  const [discriminator, setDiscriminator] = useState('');
  const [scope, setScope] = useState<'all' | 'doctor'>('all');
  const [doctorUid, setDoctorUid] = useState('');
  const [action, setAction] = useState<'downgrade' | 'drop'>('downgrade');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const body = () => ({
    signal_type: target.signal_type, match_kind: matchKind, discriminator: discriminator || null,
    scope, doctor_uid: scope === 'doctor' ? doctorUid : null, action, reason: reason || null, created_by: 'care',
  });

  async function doPreview() {
    setBusy(true); setMsg(null);
    try {
      const j = await fetch('/api/opd-triage/suppressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'preview', ...body() }) }).then((r) => r.json());
      if (!j.ok) throw new Error(j.error || 'preview failed');
      setPreview(j.preview);
    } catch (e) { setMsg(String((e as Error).message)); } finally { setBusy(false); }
  }
  async function doCreate(force: boolean) {
    setBusy(true); setMsg(null);
    try {
      const j = await fetch('/api/opd-triage/suppressions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'create', force, ...body() }) }).then((r) => r.json());
      if (!j.ok) { setPreview(j.preview || null); throw new Error(j.error || 'create failed'); }
      onCreated();
    } catch (e) { setMsg(String((e as Error).message)); } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-semibold text-slate-800">Suppress a false-positive class in “{target.label}”</span>
        <button onClick={onClose} className="text-[12px] text-slate-400 hover:text-slate-600">Cancel</button>
      </div>
      <div className="mt-3 grid gap-2.5 text-[12.5px] sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Match</span>
          <select value={matchKind} onChange={(e) => setMatchKind(e.target.value as 'type_only' | 'subject_contains')} className="rounded-md border border-slate-200 px-2 py-1">
            <option value="subject_contains">Subject contains…</option>
            <option value="type_only">Whole signal type</option>
          </select>
        </label>
        {matchKind === 'subject_contains' && (
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Discriminator (substring)</span>
            <input value={discriminator} onChange={(e) => setDiscriminator(e.target.value)} placeholder="e.g. multivitamin" className="rounded-md border border-slate-200 px-2 py-1" />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'doctor')} className="rounded-md border border-slate-200 px-2 py-1">
            <option value="all">All doctors</option>
            <option value="doctor">One doctor</option>
          </select>
        </label>
        {scope === 'doctor' && (
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">doctor_uid</span>
            <input value={doctorUid} onChange={(e) => setDoctorUid(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1" />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Action</span>
          <select value={action} onChange={(e) => setAction(e.target.value as 'downgrade' | 'drop')} className="rounded-md border border-slate-200 px-2 py-1">
            <option value="downgrade">Downgrade to informational</option>
            <option value="drop">Drop entirely</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-slate-500">Reason (why this is a false positive)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-md border border-slate-200 px-2 py-1" />
        </label>
      </div>

      {preview && (
        <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] ${preview.safe ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {preview.safe
              ? <span>Dual-label check passed — removes no validated signal. Would suppress this FP class going forward.</span>
              : <span><strong>Blocked:</strong> would remove {preview.collateral} validated signal(s) a care manager confirmed. Narrow the discriminator or scope. {preview.collateral_examples[0] && <em>e.g. “{preview.collateral_examples[0].subject}”</em>}</span>}
          </div>
        </div>
      )}
      {msg && <div className="mt-2 text-[11.5px] text-rose-600">{msg}</div>}

      <div className="mt-3 flex items-center gap-2">
        <button disabled={busy} onClick={doPreview} className="rounded-lg border border-slate-300 px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-white">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Check (dual-label)'}</button>
        <button disabled={busy || !preview?.safe} onClick={() => doCreate(false)}
          className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white ${preview?.safe && !busy ? 'bg-slate-800 hover:bg-slate-900' : 'cursor-not-allowed bg-slate-300'}`}>Create suppression</button>
        {preview && !preview.safe && (
          <button disabled={busy} onClick={() => doCreate(true)} className="rounded-lg border border-rose-300 px-3 py-1.5 text-[12px] font-medium text-rose-700 hover:bg-rose-50">Override (force)</button>
        )}
      </div>
    </div>
  );
}
