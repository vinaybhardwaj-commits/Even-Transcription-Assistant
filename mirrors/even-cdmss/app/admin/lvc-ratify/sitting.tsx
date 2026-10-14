'use client';

/**
 * app/admin/lvc-ratify/sitting.tsx — the interactive body of the ratification sitting (§3.5).
 *
 * ⚠️ ACCEPT WRITES PRODUCTION CLINICAL RULES IMMEDIATELY AND THERE IS NO UNDO (D-20). The screen
 * says so, in those words, above the button.
 *
 * RECORD-SET DRIVEN (D-21). Nothing below knows what a "merge" is beyond rendering `absorbs`, which
 * may be empty. Phase 2's 13 protocol rules and Phase 3's batches load into this same component by
 * returning a different record set from /api/admin/lvc-ratify/state — no change here.
 *
 * NO SESSION STATE (§6.13). Progress comes from the server on every load and after every write. The
 * only client state is the current index, the edits in the fields, and the reviewer's name — none
 * of it persisted, none of it in localStorage. A reload re-derives everything.
 *
 * NO BULK ACCEPT (§3.5). There is one accept button and it acts on the rule on screen. Not an
 * oversight — 19 rules reviewed one at a time is the point of the sitting.
 *
 * KEYWORD VALIDATION runs through the SAME exported `keywordError` the write path calls, so the
 * inline rejection on screen and the refusal at the server cannot disagree.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, SkipForward, AlertTriangle, Loader2 } from 'lucide-react';
import { LVC_CATEGORIES, LVC_CATEGORY_LABELS } from '@/lib/opd-lvc-classify-core';
import { keywordError } from '@/lib/lvc-rule-merge';
import { CHANGE_CLASSES, CHANGE_CLASS_LABELS, type ChangeClass } from '@/lib/lvc-merge-compare';

type Progress = 'pending' | 'accepted' | 'partially_applied' | 'rejected' | 'missing';

type Draft = {
  section: string; id: string; statement: string; precondition: string;
  keywords: string[]; category: string; citation_url: string | null; absorbs: string[];
};
type Absorbed = { id: string; statement: string | null; status: string | null; merged_into: string | null; fires: number | null; applied: boolean };
type Previous = { statement: string | null; precondition: string | null; keywords: string[]; category: string | null; citation_url: string | null };
type RuleView = {
  section: string; id: string; draft: Draft;
  current: { statement: string | null; precondition: string | null; keywords: string[]; category: string | null; citation_url: string | null; status: string | null; ratified_by: string | null; ratified_at: string | null; fires: number | null } | null;
  absorbs: Absorbed[]; progress: Progress;
  last_decision: { decision: string; ratified_by: string; created_at: string; reason: string | null } | null;
  /** A-1 — what the rule was before the accept in force. Only sent for an accepted rule. */
  previous: Previous | null;
  /** false = accepted but the payload could not be read ⇒ "not recorded". null = not accepted. */
  previous_recorded: boolean | null;
};
type State = {
  ok?: boolean; error?: string;
  record_set?: { key: string; title: string; blurb: string };
  rules: RuleView[];
  counts?: { total: number; accepted: number; partially_applied: number; rejected: number; pending: number; missing: number };
  rulebook_available?: boolean; fires_available?: boolean; ledger_available?: boolean; merged_into_present?: boolean;
  notes?: string[];
};
type Impact = {
  available: boolean; reason?: string; sampled?: number; notes_read?: number; engine?: string;
  counts?: Record<ChangeClass, number>;
  examples?: Record<ChangeClass, Array<{ note_id: string; subject: string; old_rule_ref: string | null; new_rule_ref: string | null }>>;
};

const PROGRESS_PILL: Record<Progress, { label: string; cls: string }> = {
  accepted: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  partially_applied: { label: 'Partially applied', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  rejected: { label: 'Rejected', cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  pending: { label: 'Not yet reviewed', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  missing: { label: 'Rule not found', cls: 'bg-red-50 text-red-700 ring-red-200' },
};

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());

export default function RatifySitting() {
  const [state, setState] = useState<State | null>(null);
  const [idx, setIdx] = useState(0);
  const [ratifiedBy, setRatifiedBy] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  // Per-rule edits, keyed by section. Cleared on reload — the server is the only memory.
  const [edits, setEdits] = useState<Record<string, Partial<Draft>>>({});
  const [impactOpen, setImpactOpen] = useState(false);      // COLLAPSED BY DEFAULT (D-19)
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);          // A-1 panel, also collapsed by default

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/lvc-ratify/state');
      const j = (await r.json()) as State;
      setState(j);
    } catch (e) {
      setState({ rules: [], error: String((e as Error).message), rulebook_available: false });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rules = state?.rules ?? [];
  const rule = rules[idx] ?? null;

  // The edited record for the rule on screen: the draft, with whatever V has changed on top.
  const edited: Draft | null = useMemo(() => {
    if (!rule) return null;
    return { ...rule.draft, ...(edits[rule.section] ?? {}) };
  }, [rule, edits]);

  const setField = (patch: Partial<Draft>) => {
    if (!rule) return;
    setEdits((e) => ({ ...e, [rule.section]: { ...(e[rule.section] ?? {}), ...patch } }));
  };

  // Inline keyword rejection, from the SAME validator the server calls.
  const keywordErrors = useMemo(
    () => (edited?.keywords ?? []).map((k) => keywordError(k)),
    [edited?.keywords],
  );
  const hasKeywordError = keywordErrors.some(Boolean);

  const go = (next: number) => {
    setIdx(Math.max(0, Math.min(rules.length - 1, next)));
    setMsg(null); setImpact(null); setImpactOpen(false); setPrevOpen(false);
  };

  const runImpact = async () => {
    if (!rule) return;
    setImpactBusy(true);
    try {
      const r = await fetch(`/api/admin/lvc-merge-compare?section=${encodeURIComponent(rule.section)}`);
      setImpact((await r.json()) as Impact);
    } catch (e) {
      setImpact({ available: false, reason: String((e as Error).message) });
    } finally { setImpactBusy(false); }
  };

  const toggleImpact = () => {
    const open = !impactOpen;
    setImpactOpen(open);
    if (open && !impact && !impactBusy) void runImpact();
  };

  const submit = async (decision: 'accept' | 'reject', reason?: string) => {
    if (!rule || !edited) return;
    setBusy(decision); setMsg(null);
    try {
      const r = await fetch('/api/admin/lvc-ratify/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          set: state?.record_set?.key, section: rule.section,
          ratified_by: ratifiedBy, rationale, decision,
          ...(reason ? { reason } : {}),
          statement: edited.statement, precondition: edited.precondition,
          keywords: edited.keywords, category: edited.category, citation_url: edited.citation_url,
        }),
      });
      const j = await r.json();
      if (j.ok && decision === 'accept') {
        setMsg({ tone: 'ok', text: j.ledger === 'skipped_unchanged'
          ? `${rule.section} was already applied — nothing changed, and no duplicate ledger row was written.`
          : `${rule.section} accepted. ${j.merge?.changed ?? 0} row(s) written, ledger appended.` });
      } else if (j.ok) {
        setMsg({ tone: 'ok', text: `${rule.section} rejected. The cluster is unchanged and the reason is on the ledger.` });
      } else {
        setMsg({ tone: 'err', text: j.error || 'the write did not complete — see the row detail below' });
      }
      await load();
    } catch (e) {
      setMsg({ tone: 'err', text: `${String((e as Error).message)} — reload to see what landed` });
    } finally { setBusy(null); }
  };

  const reject = async () => {
    const reason = window.prompt('Why is this rule rejected? (required — it goes on the ledger)');
    if (!reason || !reason.trim()) return;
    await submit('reject', reason.trim());
  };

  if (!state) {
    return <p className="mt-8 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading the live rulebook…</p>;
  }

  if (!rules.length) {
    return (
      <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        No rules to review. {state.error ?? 'The record set is empty or the rulebook could not be read.'}
      </div>
    );
  }

  const c = state.counts;
  const canWrite = state.rulebook_available !== false && state.merged_into_present !== false;
  const acceptBlocked = !ratifiedBy.trim() || !rationale.trim() || hasKeywordError || !canWrite || busy !== null;

  return (
    <div className="mt-6 space-y-5">
      {/* ── notes the reviewer must see before touching anything ── */}
      {(state.notes ?? []).map((n) => (
        <div key={n} className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{n}</span>
        </div>
      ))}

      {/* ── who is sitting ── */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[12px] font-medium text-slate-600">Ratifier — your name goes on every row you accept</span>
            <input
              value={ratifiedBy} onChange={(e) => setRatifiedBy(e.target.value)}
              placeholder="e.g. V (Dr Vinay Bhardwaj)"
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-slate-600">Rationale — recorded on the ledger with each decision</span>
            <input
              value={rationale} onChange={(e) => setRationale(e.target.value)}
              placeholder="e.g. Phase 1 merge sitting, 25 Aug 2026"
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
            />
          </label>
        </div>
      </div>

      {/* ── progress ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[13px]">
        <div className="font-medium text-slate-700">Rule {idx + 1} of {rules.length}</div>
        {c && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-600">
            <span><strong className="text-emerald-700">{c.accepted}</strong> accepted</span>
            {c.partially_applied > 0 && <span><strong className="text-amber-700">{c.partially_applied}</strong> partially applied</span>}
            {c.rejected > 0 && <span><strong>{c.rejected}</strong> rejected</span>}
            <span><strong>{c.pending}</strong> remaining</span>
            {c.missing > 0 && <span className="text-red-700"><strong>{c.missing}</strong> not found</span>}
          </div>
        )}
        <div className="flex gap-1.5">
          <button onClick={() => go(idx - 1)} disabled={idx === 0} className="rounded border border-slate-300 px-2 py-1 text-[12px] disabled:opacity-40">Previous</button>
          <button onClick={() => go(idx + 1)} disabled={idx === rules.length - 1} className="rounded border border-slate-300 px-2 py-1 text-[12px] disabled:opacity-40">Next</button>
        </div>
      </div>

      {/* ── the rule ── */}
      {rule && edited && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-semibold text-slate-700">{rule.section}</span>
              <span className="font-mono text-[11px] text-slate-400">{rule.id}</span>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${PROGRESS_PILL[rule.progress].cls}`}>
              {PROGRESS_PILL[rule.progress].label}
            </span>
          </div>

          <div className="space-y-4 p-4">
            {/* statement — what a doctor reads, so it sits at the top (§3.5) */}
            <label className="block">
              <span className="text-[12px] font-medium text-slate-600">Statement — what the doctor is shown</span>
              <textarea
                value={edited.statement} onChange={(e) => setField({ statement: e.target.value })}
                rows={2} className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </label>

            {/* precondition — large enough for the full applies / unless / does-not-apply text */}
            <label className="block">
              <span className="text-[12px] font-medium text-slate-600">Precondition — applies / unless / does not apply</span>
              <textarea
                value={edited.precondition} onChange={(e) => setField({ precondition: e.target.value })}
                rows={9} className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 font-sans text-[13px] leading-relaxed"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* keywords — inline rejection BEFORE the accept is attempted */}
              <div>
                <span className="text-[12px] font-medium text-slate-600">Keyword phrases — one per line, phrases only</span>
                <textarea
                  value={edited.keywords.join('\n')}
                  onChange={(e) => setField({ keywords: e.target.value.split('\n').map((k) => k.trim()).filter(Boolean) })}
                  rows={5} className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-[12px]"
                />
                {keywordErrors.map((err, i) => err && (
                  <p key={i} className="mt-1 text-[11.5px] text-red-700">{err}</p>
                ))}
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="text-[12px] font-medium text-slate-600">Category</span>
                  <select
                    value={edited.category} onChange={(e) => setField({ category: e.target.value })}
                    className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    {LVC_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{LVC_CATEGORY_LABELS[cat] ?? cat}</option>
                    ))}
                  </select>
                </label>
                <div>
                  <span className="text-[12px] font-medium text-slate-600">Citation — Even Clinical Protocols</span>
                  <p className="mt-1 text-[13px] text-slate-700">
                    {edited.citation_url ?? <span className="text-amber-700">none yet — no protocol section covers this rule</span>}
                  </p>
                </div>
                <div className="text-[12px] text-slate-500">
                  Lifetime findings on this rule: <strong className="text-slate-700">{num(rule.current?.fires)}</strong>
                  {rule.current?.ratified_by && <> · last ratified by {rule.current.ratified_by}</>}
                </div>
              </div>
            </div>

            {/* the evidence for the merge */}
            {rule.absorbs.length > 0 && (
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-[12px] font-semibold text-slate-700">
                  This rule absorbs {rule.absorbs.length} variant{rule.absorbs.length === 1 ? '' : 's'} — each retires pointing at it
                </div>
                <ul className="mt-2 space-y-1.5">
                  {rule.absorbs.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                      {a.applied
                        ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        : <span className="h-3.5 w-3.5 shrink-0" />}
                      <span className="text-slate-800">{a.statement ?? <em className="text-red-700">not found in the rulebook</em>}</span>
                      <span className="font-mono text-[10.5px] text-slate-400">{a.id}</span>
                      <span className="text-slate-500">{num(a.fires)} findings</span>
                      {a.status === 'retired' && !a.applied && <span className="text-amber-700">already retired, not yet merged</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* A-1 — what this rule WAS before the accept in force. READ-ONLY: there is
                deliberately no restore button and no undo here. D-20 stands; this panel exists so
                a correction can be WRITTEN accurately, by reading the previous wording and typing
                it back into the fields above, not so the screen can put it back for you. */}
            {rule.progress === 'accepted' && (
              <div className="rounded border border-slate-200">
                <button onClick={() => setPrevOpen(!prevOpen)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-medium text-slate-700">
                  {prevOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  What this rule was before it was accepted — read-only
                </button>
                {prevOpen && (
                  <div className="space-y-2.5 border-t border-slate-100 px-3 py-2.5 text-[12.5px]">
                    {rule.previous_recorded === false || !rule.previous ? (
                      <p className="text-amber-800">
                        Not recorded — the recovery payload for this accept could not be read. The rule
                        is applied; its previous wording is not recoverable from this screen.
                      </p>
                    ) : (
                      <>
                        <p className="text-slate-500">
                          Recorded at the accept
                          {rule.last_decision?.ratified_by ? <> by {rule.last_decision.ratified_by}</> : null}.
                          Nothing here can be restored automatically — correct the rule by editing the
                          fields above and accepting the correction.
                        </p>
                        <div>
                          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Previous statement</div>
                          <p className="mt-0.5 text-slate-800">{rule.previous.statement ?? <em className="text-slate-400">none</em>}</p>
                        </div>
                        <div>
                          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Previous precondition</div>
                          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-slate-800">
                            {rule.previous.precondition ?? <em className="text-slate-400">none</em>}
                          </p>
                        </div>
                        <div className="grid gap-2.5 sm:grid-cols-2">
                          <div>
                            <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Previous keywords</div>
                            {rule.previous.keywords.length
                              ? <ul className="mt-0.5 font-mono text-[11.5px] text-slate-800">{rule.previous.keywords.map((k, i) => <li key={`${k}-${i}`}>{k}</li>)}</ul>
                              : <p className="mt-0.5 text-slate-400"><em>none</em></p>}
                          </div>
                          <div>
                            <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Previous category</div>
                            <p className="mt-0.5 text-slate-800">{rule.previous.category ?? <em className="text-slate-400">none</em>}</p>
                            <div className="mt-2 text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">Previous citation</div>
                            <p className="mt-0.5 text-slate-800">{rule.previous.citation_url ?? <em className="text-slate-400">none</em>}</p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* impact — COLLAPSED BY DEFAULT, and it does not gate the accept (D-19) */}
            <div className="rounded border border-slate-200">
              <button onClick={toggleImpact} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-medium text-slate-700">
                {impactOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Impact on stored findings — advisory, does not gate the accept
              </button>
              {impactOpen && (
                <div className="border-t border-slate-100 px-3 py-2.5 text-[12.5px]">
                  {impactBusy && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running the comparison…</p>}
                  {!impactBusy && impact && !impact.available && (
                    <p className="text-amber-800">Impact not available — {impact.reason}</p>
                  )}
                  {!impactBusy && impact?.available && (
                    <>
                      <p className="text-slate-500">
                        {num(impact.sampled)} low-value findings from the {num(impact.notes_read)} most recent audits at {impact.engine}.
                        Nothing stored is rewritten — this is what the matcher would say today.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                        {CHANGE_CLASSES.map((k) => (
                          <span key={k} className="text-slate-700">
                            {CHANGE_CLASS_LABELS[k]}: <strong>{num(impact.counts?.[k])}</strong>
                          </span>
                        ))}
                      </div>
                      {CHANGE_CLASSES.filter((k) => k !== 'unchanged' && (impact.counts?.[k] ?? 0) > 0).map((k) => (
                        <div key={k} className="mt-2">
                          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-slate-500">{CHANGE_CLASS_LABELS[k]}</div>
                          <ul className="mt-1 space-y-0.5">
                            {(impact.examples?.[k] ?? []).map((ex, i) => (
                              <li key={`${ex.note_id}-${i}`} className="text-slate-700">
                                <span className="font-mono text-[10.5px] text-slate-400">{ex.note_id}</span>{' '}
                                {ex.subject.slice(0, 120)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── the buttons ── */}
            <div className="border-t border-slate-100 pt-3">
              <p className="flex gap-2 text-[12.5px] text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>Accept writes the live rulebook immediately. There is no undo and no snapshot.</strong>{' '}
                  A mistake is corrected by editing the rule again and accepting the correction; the previous
                  values are kept on the ledger so a correction can be written accurately. Findings already
                  delivered to a doctor never change.
                </span>
              </p>
              {msg && (
                <p className={`mt-2 text-[12.5px] ${msg.tone === 'ok' ? 'text-emerald-700' : msg.tone === 'warn' ? 'text-amber-800' : 'text-red-700'}`}>{msg.text}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void submit('accept')} disabled={acceptBlocked}
                  className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  {busy === 'accept' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Accept {rule.section} — write it
                </button>
                <button
                  onClick={() => go(idx + 1)} disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-[13px] disabled:opacity-40"
                >
                  <SkipForward className="h-3.5 w-3.5" /> Skip — decide later
                </button>
                <button
                  onClick={() => void reject()} disabled={busy !== null || !ratifiedBy.trim()}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-[13px] text-slate-700 disabled:opacity-40"
                >
                  {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  Reject — leave the cluster alone
                </button>
              </div>
              {acceptBlocked && busy === null && (
                <p className="mt-2 text-[11.5px] text-slate-500">
                  {!canWrite ? 'Accepting is disabled until the rulebook is readable and migration 0041 has been applied.'
                    : hasKeywordError ? 'Fix the keyword above before accepting.'
                    : 'Enter your name and a rationale to accept.'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
