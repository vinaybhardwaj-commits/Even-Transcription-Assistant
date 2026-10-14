'use client';

/**
 * components/case-ask/CaseAskPanel.tsx — the shared Ask chrome for the OPD note-audit case and the
 * IPD discharge-audit case (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §3.4).
 *
 * §3.4 says to reuse the STRUCTURE of `AskTheAgent` in components/care/ReadmissionCasePage.tsx and
 * NOT to import it — so this file was written against that component as a reference and shares no
 * code with it. One composer per case; questions go in the box; the thread is loaded from the server
 * on mount and survives a reload.
 *
 * ⚠️ ONE component, not two. PRD §7 names "Ask panel components under app/admin/opd-audit/[id]/ and
 * app/admin/ipd-audit/[id]/", and those two files exist — they are the per-surface mounts that carry
 * each surface's endpoint, id and suggestions. The chrome itself lives here ONCE, because two
 * hand-maintained copies of the same 100 lines is exactly how the OPD box and the IPD box end up
 * telling an auditor two different things about what chat can do. Flagged in the P1 report.
 *
 * FORBIDDEN IN THIS CHROME (memo §12.2, PRD §3.3), and absent by construction: a recompute /
 * re-audit control, a MemberState write affordance, a gold-pill row as the only way to talk, and any
 * patient name / UHID / encounter id — this component never receives one, because the route never
 * assembles one. The gold pills stay exactly where they are on the page, untouched by this panel.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ASK_PER_LOAD_LIMIT, ASK_QUESTION_MAX_CHARS, CASE_ASK_ADVISORY, CASE_ASK_SUGGESTIONS,
  CASE_ASK_THREAD_UNAVAILABLE_COPY, CASE_ASK_WITHHELD_COPY, CASE_ASK_WORKING_COPY,
  extractCitedIds, type CaseAskThreadTurn, type CaseAskType,
} from '@/lib/case-ask-core';

interface ThreadPayload {
  ok?: boolean;
  turns?: CaseAskThreadTurn[];
  threadError?: string | null;
  remainingToday?: number;
  itemIds?: string[];
  error?: string;
}
interface AnswerPayload {
  ok?: boolean;
  withheld?: boolean;
  answer?: string;
  citedIds?: string[];
  copy?: string;
  reason?: string;
  persisted?: boolean;
  remainingToday?: number;
  error?: string;
}

interface Entry { question: string; answer: string | null; withheld: boolean; copy?: string }

/** Fold the stored thread into the rendered pairs. A user turn opens a pair; the next agent turn
 *  closes it — withheld or not, because the SURFACE shows the whole argument including the turns the
 *  agent could not answer (only the MODEL is spared them). A trailing user turn with no answer is
 *  shown too: his question was stored even though the reply was lost. */
function entriesFromThread(turns: readonly CaseAskThreadTurn[]): Entry[] {
  const out: Entry[] = [];
  let open: string | null = null;
  for (const t of [...turns].sort((a, b) => a.turnIndex - b.turnIndex)) {
    if (t.role === 'user') {
      if (open != null) out.push({ question: open, answer: null, withheld: false });
      open = String(t.content ?? '');
      continue;
    }
    if (open != null) {
      out.push(t.withheld
        ? { question: open, answer: null, withheld: true, copy: String(t.content ?? CASE_ASK_WITHHELD_COPY) }
        : { question: open, answer: String(t.content ?? ''), withheld: false });
      open = null;
    }
  }
  if (open != null) out.push({ question: open, answer: null, withheld: false });
  return out;
}

/** Render an answer with its [F3] markers set apart from the prose. Code already verified every
 *  marker resolves to a stored item on this case before the answer was shown at all — this is
 *  presentation of that fact, not a second check. */
function Answer({ text, known }: { text: string; known: Set<string> }) {
  const parts = text.split(/(\[[A-Z]{1,4}\d{1,4}(?:\s*[,;/]\s*[A-Z]{1,4}\d{1,4})*\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const ids = /^\[/.test(p) ? extractCitedIds(p) : [];
        if (!ids.length) return <span key={i}>{p}</span>;
        return (
          <span key={i}>
            {ids.map((id) => (
              <span
                key={id}
                title={known.has(id) ? 'cites an item on this case' : 'cited item'}
                className="mx-0.5 rounded border border-slate-200 bg-slate-50 px-1 text-[10.5px] font-medium text-slate-600"
              >{id}</span>
            ))}
          </span>
        );
      })}
    </>
  );
}

export default function CaseAskPanel({
  caseType, query, endpoint,
}: {
  caseType: CaseAskType;
  /**
   * WHICH CASE this box is about, as the endpoint names it. The per-note surfaces send
   * `{ audit_id }`; the stewardship room sends `{ case, key }`, because a physician case and a
   * department case are two grains on one route (A3) and one id field cannot say which.
   *
   * It is a bag rather than a fixed pair on purpose: the chrome does not know, and must not learn,
   * what identifies a case on any particular surface. It forwards what the mount handed it — as the
   * GET query string and, verbatim, as the POST body beside the question — so a new grain is a new
   * mount, never an edit here. What the chrome DOES still own is the rule that the server is the
   * thread's truth: no history is ever sent, whatever this bag contains.
   */
  query: Readonly<Record<string, string>>;
  /** O4 — each surface has its OWN admin-gated endpoint; the panel is told which. */
  endpoint: string;
}) {
  // One stable string for the effect dependency and the request: a fresh object literal from the
  // mount would otherwise re-fetch the thread on every parent render.
  const qs = new URLSearchParams(query).toString();
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [threadErr, setThreadErr] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [remainingToday, setRemainingToday] = useState<number | null>(null);
  // The citable ids come from the SERVER, which minted them: the chrome never re-derives the
  // minting rule, so a tooltip here cannot disagree with the gate that actually checked the answer.
  const [itemIds, setItemIds] = useState<string[]>([]);
  const left = Math.max(0, ASK_PER_LOAD_LIMIT - asked);
  const known = new Set(itemIds);
  const ceilingReached = remainingToday === 0;
  const disabled = busy || left <= 0 || ceilingReached;

  // The stored thread. A failure here is not something the auditor must act on: the box still works
  // and the next turn still persists, so it says exactly that. Before migration 0046 has run this is
  // simply an empty thread — the fail-safe store returns one rather than throwing.
  useEffect(() => {
    let alive = true;
    fetch(`${endpoint}?${qs}`)
      .then((r) => r.json() as Promise<ThreadPayload>)
      .then((j) => {
        if (!alive || !j?.ok) return;
        setEntries(entriesFromThread(j.turns ?? []));
        setThreadErr(j.threadError ?? null);
        setRemainingToday(typeof j.remainingToday === 'number' ? j.remainingToday : null);
        setItemIds(Array.isArray(j.itemIds) ? j.itemIds : []);
      })
      .catch(() => { if (alive) setThreadErr(CASE_ASK_THREAD_UNAVAILABLE_COPY); });
    return () => { alive = false; };
  }, [qs, endpoint]);

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || busy || left <= 0) return;
    setBusy(true); setErr(null);
    try {
      // No history in the body: the server reads the thread it stored.
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...query, question: text }),
      });
      const j = (await r.json()) as AnswerPayload;
      if (!r.ok || !j.ok) throw new Error(String(j.error || `status ${r.status}`));
      setEntries((xs) => [...xs, j.withheld
        ? { question: text, answer: null, withheld: true, copy: j.copy ?? CASE_ASK_WITHHELD_COPY }
        : { question: text, answer: j.answer ?? '', withheld: false }]);
      if (typeof j.remainingToday === 'number') setRemainingToday(j.remainingToday);
      if (j.persisted === false) setThreadErr(CASE_ASK_THREAD_UNAVAILABLE_COPY);
      setAsked((n) => n + 1);
      setQ('');
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
    // `query` is read through `qs` for identity: the bag's CONTENT is what selects a case, and a
    // parent that rebuilds an equal object must not invalidate this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, busy, endpoint, left]);

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-slate-800">Ask the agent</span>
        <span className="text-[11px] text-slate-500">
          {entries.length} saved turn{entries.length === 1 ? '' : 's'} on this case
        </span>
      </div>
      <div className="px-4 py-3">
        {entries.length > 0 && (
          <div className="mb-3 space-y-3">
            {entries.map((e, i) => (
              <div key={i}>
                <div className="text-[12.5px] font-medium text-slate-800">Q · {e.question}</div>
                {e.answer == null
                  ? (
                    <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
                      {e.withheld ? (e.copy ?? CASE_ASK_WITHHELD_COPY) : 'No answer was stored for this question.'}
                    </div>
                  )
                  : (
                    <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-slate-800">
                      <Answer text={e.answer} known={known} />
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
        {busy && <p className="mb-2 text-[12px] italic text-slate-500">{CASE_ASK_WORKING_COPY}</p>}
        {err && <p className="mb-2 text-[12px] text-red-700">{err}</p>}
        {threadErr && <p className="mb-2 text-[11.5px] italic text-amber-800">{CASE_ASK_THREAD_UNAVAILABLE_COPY}</p>}

        <div className="flex flex-wrap gap-1.5">
          {CASE_ASK_SUGGESTIONS[caseType].map((sug) => (
            <button key={sug} type="button" disabled={disabled} onClick={() => void ask(sug)}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11.5px] text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">{sug}</button>
          ))}
        </div>

        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
          <input type="text" value={q} maxLength={ASK_QUESTION_MAX_CHARS} disabled={disabled}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              ceilingReached ? 'Daily limit reached on this case — it opens again after midnight IST'
                : left <= 0 ? `Question limit reached for this page load (${ASK_PER_LOAD_LIMIT}) — reload to ask more`
                  : 'Ask about this case'}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] text-slate-800 disabled:bg-slate-50 disabled:text-slate-400" />
          <button type="submit" disabled={disabled || !q.trim()}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:border-brand/40 hover:text-brand disabled:opacity-50">Ask</button>
        </form>

        {/* §3.4 — the advisory copy, verbatim. It is the honest description of this box: answers are
            citation-checked against what the case already stored, and nothing said here rescores. */}
        <p className="mt-2 text-[10.5px] italic text-slate-500">
          {CASE_ASK_ADVISORY} · {left} of {ASK_PER_LOAD_LIMIT} questions left on this page load
          {remainingToday != null && ` · ${remainingToday} answers left today on this case`}
        </p>
      </div>
    </div>
  );
}
