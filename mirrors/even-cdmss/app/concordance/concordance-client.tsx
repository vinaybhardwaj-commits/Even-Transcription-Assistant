'use client';
import { useState } from 'react';
import { FlaskConical, User, Building2, HelpCircle, ShieldCheck, ArrowRight, RotateCcw } from 'lucide-react';

type WhoKnows = 'report' | 'you' | 'lab';
type NextQuestion = { stop: boolean; question: string; whoKnows: WhoKnows; why: string; options: string[]; confidence?: number };
type Belief = { cause: string; branch: 'A' | 'B'; weight: number };
type InterviewState = {
  result: string; context0: string; belief: Belief[];
  turns: { question: string; whoKnows: WhoKnows; answer: string }[];
  openGaps: { gap: string }[]; status: string; askedCount: number; unknownStreak: number; leadConfidence: number;
};
type Parsed = {
  verdict: string | null; confidence: string | null; branchAText: string; branchBText: string;
  decisiveGap: string; voiText: string; nextStep: string; grounding: string;
};
type ApiResp = { ok: boolean; done?: boolean; state?: InterviewState; question?: NextQuestion; verdict?: { parsed: Parsed }; error?: string };

const CAP = 6;
const WHO: Record<WhoKnows, { label: string; Icon: typeof User }> = {
  report: { label: 'From the report', Icon: FlaskConical },
  you: { label: "You'll know this", Icon: User },
  lab: { label: 'Ask the lab', Icon: Building2 },
};

const VERDICT_LABEL: Record<string, string> = {
  concordant: 'Concordant',
  'discordant-likely-error': 'Discordant — likely a lab error',
  'discordant-likely-real': 'Discordant — likely real',
  indeterminate: 'Indeterminate',
};

export default function ConcordanceClient() {
  const [screen, setScreen] = useState<'intake' | 'interview' | 'report'>('intake');
  const [result, setResult] = useState('');
  const [context, setContext] = useState('');
  const [state, setState] = useState<InterviewState | null>(null);
  const [question, setQuestion] = useState<NextQuestion | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function call(body: unknown): Promise<ApiResp> {
    const r = await fetch('/api/concordance/interview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }

  function apply(resp: ApiResp) {
    if (!resp.ok) { setError(resp.error || 'Something went wrong'); return; }
    setError('');
    if (resp.state) setState(resp.state);
    if (resp.done && resp.verdict) { setParsed(resp.verdict.parsed); setScreen('report'); }
    else if (resp.question) { setQuestion(resp.question); setScreen('interview'); }
  }

  async function start() {
    if (!result.trim()) { setError('Enter a result to check.'); return; }
    setBusy(true); try { apply(await call({ result, context })); } catch { setError('Network error.'); } finally { setBusy(false); }
  }
  async function answer(a: string) {
    if (!state || !question) return;
    setBusy(true); setFreeText('');
    try { apply(await call({ state, question, answer: a })); } catch { setError('Network error.'); } finally { setBusy(false); }
  }
  function reset() {
    setScreen('intake'); setResult(''); setContext(''); setState(null); setQuestion(null); setParsed(null); setError(''); setFreeText('');
  }

  const card = 'rounded-xl border border-slate-200 bg-white';

  if (screen === 'intake') {
    return (
      <div className={card + ' p-6'}>
        <label className="block text-[13px] font-medium text-slate-700">Lab result</label>
        <p className="mt-0.5 text-[12px] text-slate-400">Just the test name and value — units and reference range are optional; we infer them from the test and the number (and ask if it's ambiguous).</p>
        <input value={result} onChange={(e) => setResult(e.target.value)}
          placeholder="e.g. Potassium 6.8  ·  or  Calcium 11.8"
          className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-[14px] outline-none focus:border-brand" />
        <label className="mt-4 block text-[13px] font-medium text-slate-700">One line of clinical context <span className="text-slate-400">(optional)</span></label>
        <input value={context} onChange={(e) => setContext(e.target.value)}
          placeholder="e.g. 56F, ambulatory, asymptomatic, routine check"
          className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-[14px] outline-none focus:border-brand" />
        {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
        <button onClick={start} disabled={busy}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-dark disabled:opacity-60">
          {busy ? 'Starting…' : 'Start check'} <ArrowRight className="h-4 w-4" />
        </button>
        <p className="mt-4 text-[12px] text-slate-400">Advisory only — not a release authorization. Each check starts fresh; nothing is looked up from prior checks.</p>
      </div>
    );
  }

  if (screen === 'interview' && question && state) {
    const who = WHO[question.whoKnows];
    const pct = Math.min(100, Math.round((state.askedCount / CAP) * 100));
    const top = [...state.belief].sort((a, b) => b.weight - a.weight).slice(0, 2);
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className={card + ' p-6'}>
          <div className="mb-4 h-1 rounded-full bg-slate-100"><div className="h-1 rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] text-slate-400"><HelpCircle className="h-3.5 w-3.5" /> Why we're asking: {question.why}</div>
          <p className="font-serif text-[22px] leading-snug text-slate-900">{question.question}</p>
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-brand/40 px-2.5 py-1 text-[12px] text-brand">
            <who.Icon className="h-3.5 w-3.5" /> {who.label}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {question.options.map((o) => (
              <button key={o} onClick={() => answer(o)} disabled={busy}
                className="rounded-lg border border-slate-200 px-3 py-2.5 text-left text-[14px] hover:border-brand hover:bg-brand-faint disabled:opacity-60">{o}</button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="Or type an answer…"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-[14px] outline-none focus:border-brand" />
            <button onClick={() => freeText.trim() && answer(freeText.trim())} disabled={busy || !freeText.trim()}
              className="rounded-lg border border-slate-200 px-3 py-2 text-[14px] hover:bg-slate-50 disabled:opacity-50">Send</button>
          </div>
          <button onClick={() => answer('I do not have this')} disabled={busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-[14px] text-slate-500 hover:bg-slate-50 disabled:opacity-60">
            <HelpCircle className="h-4 w-4" /> I don't have this
          </button>
          {busy && <p className="mt-3 text-[13px] text-slate-400">Thinking…</p>}
          {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
        </div>

        <div className={card + ' h-fit p-4'}>
          <div className="mb-2 text-[12px] text-slate-400">Reasoning so far</div>
          {top.map((b) => (
            <div key={b.cause} className="mb-2">
              <div className="flex items-center justify-between text-[12px]"><span className={b.branch === 'B' ? 'text-slate-800' : 'text-slate-500'}>{b.branch} · {b.cause}</span></div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.round(b.weight * 100)}%` }} /></div>
            </div>
          ))}
          <div className="mt-3 border-t border-slate-100 pt-3 text-[12px] text-slate-500">
            {state.turns.length} asked{state.openGaps.length ? ` · ${state.openGaps.length} gap${state.openGaps.length > 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>
    );
  }

  if (screen === 'report' && parsed) {
    const v = parsed.verdict || 'indeterminate';
    return (
      <div>
        <div className={card + ' p-6'}>
          <div className="text-[12px] uppercase tracking-wide text-slate-400">Concordance verdict</div>
          <p className="mt-1 font-serif text-[26px] leading-tight text-slate-900">{VERDICT_LABEL[v] || v}</p>
          {parsed.confidence && <span className="mt-2 inline-block rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">Confidence: {parsed.confidence}</span>}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-[12px] font-medium text-slate-500">Branch A — could it be a lab error?</div>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">{parsed.branchAText || '—'}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-[12px] font-medium text-slate-500">Branch B — could it be real?</div>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">{parsed.branchBText || '—'}</p>
            </div>
          </div>
          {parsed.decisiveGap && (
            <div className="mt-4 rounded-lg bg-brand-faint p-3">
              <div className="text-[12px] font-medium text-brand">Decisive gap</div>
              <p className="mt-1 text-[13px] text-slate-700">{parsed.decisiveGap}</p>
            </div>
          )}
          {parsed.nextStep && <p className="mt-4 text-[13px] text-slate-700"><span className="font-medium">Next step:</span> {parsed.nextStep}</p>}
          {parsed.voiText && <p className="mt-3 whitespace-pre-wrap text-[12px] text-slate-500">{parsed.voiText}</p>}
          <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4 text-[12px] text-slate-400">
            <ShieldCheck className="h-4 w-4" /> Advisory only — not a release authorization. The clinician decides.
          </div>
        </div>
        <button onClick={reset} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-[14px] hover:bg-slate-50">
          <RotateCcw className="h-4 w-4" /> New check
        </button>
      </div>
    );
  }

  return <div className="text-[14px] text-slate-500">Loading…</div>;
}
