'use client';

// Care-Call Capture — the CM Call panel on the episode brief (/care/[uid]), below the walled
// commercial card. Mockup is normative for copy/layout. Read-only w.r.t. the clinical record: every
// answer is stored raw then derived into typed clinical-state/1.2 assertions (patient-reported
// provenance) — advisory evidence that never overrides the note. DARK behind CARE_CALL_ENABLED
// (mount is flag-gated in CareBriefSplit; this component assumes it's allowed to render).

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Phone, ShieldAlert } from 'lucide-react';
import type { AskItem, AskResponse, Disposition } from '@/lib/care-call-core';

type Chip = [label: string, value: string];
const MED_CHIPS: Chip[] = [['Yes, taking it', 'reported_taking'], ['Never bought it', 'not_taking'], ['Started, then stopped', 'stopped'], ["Can't say", 'unknown']];
const STOP_CHIPS: Chip[] = [['Side effect', 'side_effect'], ['Cost', 'cost'], ['Felt better', 'felt_better'], ['Ran out', 'ran_out'], ['Other…', 'other']];
const FOLLOWUP_CHIPS: Chip[] = [['Will book / booked', 'committed'], ['Already done — here', 'already_done_inhouse'], ['Already done — outside', 'already_done_outside'], ["Doesn't want it", 'declined'], ['Undecided', 'undecided']];
const COMPLAINT_CHIPS: Chip[] = [['Resolved', 'resolved'], ['Improving', 'improving'], ['Same', 'unchanged'], ['Worse', 'worse']];
const ALLERGY_CHIPS: Chip[] = [['None', 'denied'], ['Yes…', 'reported_allergy']];
const OUTSIDE_CHIPS: Chip[] = [['Will send', 'will_send'], ["Doesn't have it", 'doesnt_have'], ['Declines', 'declined']];
const DISPOSITION_CHIPS: Chip[] = [['Connected', 'connected'], ['No answer', 'no_answer'], ['Wrong number', 'wrong_number'], ['Refused', 'refused'], ['Call later', 'call_later']];

const CHIPS: Record<string, Chip[]> = { MED_STATUS: MED_CHIPS, FOLLOWUP_ACTION: FOLLOWUP_CHIPS, COMPLAINT_STATUS: COMPLAINT_CHIPS, ALLERGY_CONFIRM: ALLERGY_CHIPS, OUTSIDE_RECORDS: OUTSIDE_CHIPS };
const FAM_TAG: Record<string, string> = { MED_STATUS: 'med', FOLLOWUP_ACTION: 'follow-up · care gap', COMPLAINT_STATUS: 'complaint', ALLERGY_CONFIRM: 'allergies · not on file', OUTSIDE_RECORDS: 'outside records' };

interface Answer { answer?: string; reason?: string; targetDate?: string | null; freeText?: string; skipped?: boolean }
interface AsksResp { asks: AskItem[]; overflow: { family: string; subject: string }[]; degraded: boolean; attempt_next: number; prior: { attempt: number; disposition: string }[]; keys?: { presc_uid: string; individual_uid: string; uhid?: string | null; note_date?: string | null } }

function escalationLine(ask: AskItem, ans?: string): string | null {
  if (ask.family === 'COMPLAINT_STATUS' && ans === 'worse') return "Since it's gotten worse, I'd recommend a review with the doctor — shall I help you book that visit?";
  if (ask.family === 'MED_STATUS' && ask.meta?.highAlert && (ans === 'stopped' || ans === 'not_taking')) return "It's important the doctor knows you've stopped this medicine — shall I book a quick review?";
  return null;
}

export default function CallPanel({ prescUid }: { prescUid: string }) {
  const [data, setData] = useState<AsksResp | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [ans, setAns] = useState<Record<string, Answer>>({});
  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ attempt: number } | null>(null);

  const load = useCallback(() => {
    setLoadState('loading'); setAns({}); setDisposition(null); setSaved(null);
    fetch(`/api/care-call/askset?uid=${encodeURIComponent(prescUid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: AsksResp) => { setData(j); setLoadState('ready'); })
      .catch(() => setLoadState('error'));
  }, [prescUid]);
  useEffect(load, [load]);

  const set = (id: string, patch: Answer) => setAns((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  const save = async () => {
    if (!disposition || !data) return;
    setSaving(true);
    const responses: AskResponse[] = (data.asks || []).map((a) => {
      const v = ans[a.id];
      if (!v || v.skipped || v.answer == null) return { askId: a.id, family: a.family, subject: a.subject, state: 'skipped' as const };
      return { askId: a.id, family: a.family, subject: a.subject, state: 'answered' as const, answer: v.answer, reason: v.reason, targetDate: v.targetDate ?? null, freeText: v.freeText, highAlert: a.meta?.highAlert };
    });
    for (const o of data.overflow || []) responses.push({ askId: `${o.family}:overflow`, family: o.family as AskItem['family'], subject: o.subject, state: 'not_generated' as const });
    const k = data.keys;
    try {
      const r = await fetch('/api/care-call/outcome', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: (globalThis.crypto?.randomUUID?.() || `${prescUid}-${responses.length}-${disposition}`),
          presc_uid: k?.presc_uid || prescUid, individual_uid: k?.individual_uid || '', uhid: k?.uhid ?? null, note_date: k?.note_date ?? null,
          disposition, responses, served_ask_ids: (data.asks || []).map((a) => a.id),
        }),
      });
      const j = await r.json();
      if (r.ok && j.ok) setSaved({ attempt: j.attempt });
    } finally { setSaving(false); }
  };

  if (loadState === 'error') return null;
  const answeredCount = data ? (data.asks || []).filter((a) => ans[a.id]?.answer != null && !ans[a.id]?.skipped).length : 0;
  const total = data ? (data.asks || []).length : 0;

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border-[1.5px] border-teal-600 bg-white">
      <div className="flex items-center justify-between bg-teal-50 px-4 py-2.5">
        <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-teal-800"><Phone className="h-3.5 w-3.5" /> Call panel · ask before you close</h2>
        <span className="text-[11px] font-bold text-teal-800">{saved ? `Attempt ${saved.attempt} saved` : data ? `${answeredCount} of ${total} answered` : ''}</span>
      </div>

      {loadState === 'loading' && <div className="flex items-center gap-2 px-4 py-5 text-[12.5px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Building the ask-set…</div>}

      {saved ? (
        <div className="px-4 py-4 text-[12.5px] text-slate-600">
          Attempt {saved.attempt} · {disposition?.replace('_', ' ')} · {answeredCount} answered.{' '}
          <button type="button" onClick={load} className="font-semibold text-teal-700 underline">New attempt</button>
        </div>
      ) : data ? (
        <>
          <div className="px-4 pb-1 pt-1">
            <div className="mb-1 text-[10.5px] font-bold text-teal-800">Attempt {data.attempt_next}</div>
            {data.degraded && <div className="mb-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-800">Episode details unavailable — logging the call only.</div>}

            {(data.asks || []).map((a) => {
              const v = ans[a.id] || {};
              const isMed = a.family === 'MED_STATUS';
              const tag = isMed && a.meta?.highAlert ? '▲ med · high-alert' : FAM_TAG[a.family];
              const esc = escalationLine(a, v.answer);
              return (
                <div key={a.id} className="border-b border-slate-200 py-3 last:border-b-0">
                  <div className={`mb-1 flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-wide ${isMed && a.meta?.highAlert ? 'text-red-600' : 'text-slate-400'}`}>
                    {tag}
                    <button type="button" onClick={() => set(a.id, { skipped: true, answer: undefined })} className="ml-auto text-[11px] font-normal normal-case text-slate-400 underline">skip</button>
                  </div>
                  <div className="mb-2 text-[13.5px] leading-snug text-slate-800">{a.question}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(CHIPS[a.family] || []).map(([label, value]) => {
                      const sel = v.answer === value && !v.skipped;
                      const warn = value === 'worse' || value === 'stopped' || value === 'not_taking';
                      return (
                        <button key={value} type="button" onClick={() => set(a.id, { answer: value, skipped: false })}
                          className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${sel ? (warn ? 'border-red-600 bg-red-600 text-white' : 'border-teal-600 bg-teal-600 text-white') : 'border-slate-200 bg-white text-slate-600'}`}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {isMed && v.answer === 'stopped' && (
                    <div className="mt-2 text-[11.5px] text-slate-600">Why stopped?{' '}
                      {STOP_CHIPS.map(([label, value]) => (
                        <button key={value} type="button" onClick={() => set(a.id, { reason: value })} className={`ml-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${v.reason === value ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{label}</button>
                      ))}
                    </div>
                  )}
                  {a.family === 'FOLLOWUP_ACTION' && v.answer === 'committed' && (
                    <div className="mt-2 text-[11.5px] text-slate-600">Target date: <input type="date" value={v.targetDate ?? ''} onChange={(e) => set(a.id, { targetDate: e.target.value })} className="rounded-md border border-slate-200 px-2 py-1 text-[12px]" /></div>
                  )}
                  {a.family === 'ALLERGY_CONFIRM' && v.answer === 'reported_allergy' && (
                    <input placeholder="substance / reaction" value={v.freeText ?? ''} onChange={(e) => set(a.id, { freeText: e.target.value })} className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1 text-[12px]" />
                  )}
                  {isMed && v.answer === 'stopped' && <div className="mt-1.5 text-[11px] italic text-slate-400">Saved as: stopped{v.reason ? ` · reason ${v.reason.replace('_', '-')}` : ''} · patient-reported — the doctor&apos;s note is not changed.</div>}
                  {a.family === 'ALLERGY_CONFIRM' && v.answer === 'denied' && <div className="mt-1.5 text-[11px] italic text-slate-400">&ldquo;None&rdquo; is saved as a dated documented-negative — not left blank.</div>}
                  {esc && <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><b className="font-bold">Escalation flagged.</b> Read: &ldquo;{esc}&rdquo; · Flag goes to today&apos;s escalation list.</span></div>}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-[#f8f7f4] px-4 py-3">
            <span className="text-[11px] font-bold text-slate-600">Call:</span>
            {DISPOSITION_CHIPS.map(([label, value]) => (
              <button key={value} type="button" onClick={() => setDisposition(value as Disposition)} className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${disposition === value ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{label}</button>
            ))}
            <button type="button" disabled={!disposition || saving} onClick={save} className="ml-auto rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40">
              {saving ? 'Saving…' : 'Save call outcome'}
            </button>
          </div>
          <div className="px-4 py-2 text-[10.5px] leading-relaxed text-slate-400">
            Partial saves allowed — abandoning mid-call still records what was asked. Skip ≠ &ldquo;can&apos;t say&rdquo;: skip means not-asked. Every answer is stored raw, then derived into typed assertions (care-call/0.1 · ask-set/0.1) with provenance patient-via-care-manager — advisory evidence that never overrides the clinical record.
          </div>
        </>
      ) : null}
    </div>
  );
}
