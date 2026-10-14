'use client';

/**
 * Review Mode session (Gold-Label Review-Mode §2) — full-screen, one FINDING per screen, keyboard-first.
 *
 * Reuses the SHIPPED save/fail/retry state machine from lib/opd-feedback-ux-core (planTap / makeAttempt
 * / revertOnFail / savedLabel) — NOT a fork. Every tap is one optimistic append-only POST to
 * /api/opd-audit/feedback; a failure reverts + surfaces a persistent retry of the exact payload.
 *
 * Keys (§1): 1 TP · 2 Nitpick · 3 False · 4 Contested · after 1: `i` cycles impact tag (TP-only) ·
 * 3/4 open the reason input (Enter saves, Esc skips) · `m` missed-finding flow for THIS NOTE
 * (category via 1–7 + text) · `s` skip (logs nothing, requeues later) · Enter next · space toggles
 * the prescription pane · `?` opens the reviewer guide. Identity is roster-driven and required to
 * start (rides every row as `author`).
 *
 * v1.1 (PDF-context PRD): split view — original prescription PDF (db13 GCS url) in an iframe on the
 * left (~55%, `space` toggles, default on), finding card + tools on the right; the metadata context
 * renders inline always; a floating reviewer guide (<ReviewGuide>) owns the keyboard while open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  planTap, makeAttempt, revertOnFail, savedLabel, type Attempt,
} from '@/lib/opd-feedback-ux-core';
import { IMPACT_TAGS, MISSED_CATEGORIES } from '@/lib/opd-feedback-core';
import { itemKey } from '@/lib/review-queue-core';
import { buildNavigator, nextUnlabeled, type ItemStatus } from '@/lib/review-navigator-core';
import ReviewGuide from './review-guide';
import Navigator from './navigator';

type QueueItem = {
  audit_id: string; finding_ref: string; signal_type: string; domain: string;
  subject: string; rationale: string; verdict: string; note_date: string; doctor_uid: string;
  citation_ids?: number[]; queue: 'fresh' | 'disagreement';
  disagreement_type?: string; disagreement_reason?: string;
  uid?: string; prescription_url?: string | null;   // v1.1 PDF-context passthrough
};
type QueueResp = {
  ok: boolean; engine?: string; roster?: string[]; disagreement_enabled?: boolean;
  items?: QueueItem[]; stats?: { labeled_today?: number }; error?: string;
};
// Gamification stats (GET /api/care/review-stats) — every block is fail-safe/optional.
type Badge = { author: string; streak?: number; agreement_pct?: number; pairs?: number };
type StatsResp = {
  ok: boolean; degraded?: boolean;
  goal: { target: number; label: string; weekly_target: number };
  roster?: string[];
  team: { total: number; week: number };
  badges: Badge[];
  me?: { week: number; personal_weekly_target: number; streak: number };
};

const VERDICT_PILLS: { key: string; digit: string; label: string; on: string }[] = [
  { key: 'true_positive', digit: '1', label: 'True positive', on: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
  { key: 'nitpick', digit: '2', label: 'Nitpick', on: 'border-slate-400 bg-slate-100 text-slate-700' },
  { key: 'false', digit: '3', label: 'False', on: 'border-red-400 bg-red-50 text-red-700' },
  { key: 'contested', digit: '4', label: 'Contested', on: 'border-violet-400 bg-violet-50 text-violet-700' },
];
const IMPACT_LABELS: Record<string, string> = { changes_management: 'Changes management', chart_hygiene: 'Chart hygiene' };
const DIS_TONE: Record<string, string> = {
  tier_differs: 'bg-amber-100 text-amber-700', teacher_only: 'bg-sky-100 text-sky-700', student_only: 'bg-purple-100 text-purple-700',
};

const post = async (body: Record<string, unknown>): Promise<void> => {
  const r = await fetch('/api/opd-audit/feedback', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `status ${r.status}`);
};

export default function ReviewSession({ study }: { study?: string } = {}) {
  const [phase, setPhase] = useState<'identify' | 'reviewing'>('identify');
  const [roster, setRoster] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [disEnabled, setDisEnabled] = useState(false);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // navigator state (§3.2): per-item status (keyed by review-queue-core.itemKey) + the reviewer's own
  // saved verdict per item, so revisiting a labeled item shows its saved state (append-only, unchanged).
  const [status, setStatus] = useState<Record<string, ItemStatus>>({});
  const [savedVerdicts, setSavedVerdicts] = useState<Record<string, string>>({});

  // session stats
  const [labeledToday, setLabeledToday] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const sessionStart = useRef<number>(0);
  // gamification (fail-safe: null → surface renders exactly as before). teamTotal/weekMine track
  // optimistically off the same counted-save increments as labeledToday.
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [teamTotal, setTeamTotal] = useState(0);
  const [weekMine, setWeekMine] = useState(0);

  // per-finding UI state (reset on idx change)
  const [selected, setSelected] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedMeta, setSavedMeta] = useState<string | null>(null);
  const [failed, setFailed] = useState<Attempt | null>(null);
  const [errMsg, setErrMsg] = useState('');
  // v1.1 — PDF pane (default on, `space` toggles; persists across findings) + per-finding iframe error
  const [pdfOpen, setPdfOpen] = useState(true);
  const [pdfError, setPdfError] = useState(false);
  // reviewer guide overlay — while open it owns the keyboard (review keys suspended in the handler below)
  const [guideOpen, setGuideOpen] = useState(false);

  // reason input (3/4) + missed flow
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState('');
  const [missedOpen, setMissedOpen] = useState(false);
  const [missedCat, setMissedCat] = useState<string | null>(null);
  const [missedText, setMissedText] = useState('');
  const [missedSaved, setMissedSaved] = useState(false);

  // Study-lane banner (U3): flask glyph + lane name + the exact sentence. Violet family per the
  // existing Tailwind idiom (DIS_TONE). Rendered on BOTH screens; null when unset — the DOM is
  // byte-identical to today without ?study=.
  const studyBanner = study ? (
    <div className="mb-3 flex items-center gap-2 rounded-lg bg-purple-100 px-3 py-2 text-[12.5px] text-purple-700">
      <span aria-hidden>⚗️</span>
      <span><b className="font-semibold">Study lane: {study}</b> — Labels here do not enter production figures</span>
    </div>
  ) : null;

  const current = items[idx] || null;
  const modalOpen = reasonOpen || missedOpen;
  const currentKey = current ? itemKey(current) : null;

  // navigator view (pure core) + jump-to-item by key
  const nav = useMemo(() => buildNavigator(
    items.map((it) => ({ key: itemKey(it), subject: it.subject, signal_type: it.signal_type, doctor_uid: it.doctor_uid, note_date: it.note_date, queue: it.queue })),
    status,
  ), [items, status]);
  const selectByKey = useCallback((key: string) => {
    const i = items.findIndex((it) => itemKey(it) === key);
    if (i >= 0) setIdx(i);
  }, [items]);

  // ── roster bootstrap (identity picker is required to start) ───────────────────
  useEffect(() => {
    let live = true;
    fetch('/api/care/review-queue?reviewer=__bootstrap__&n=1', { cache: 'no-store' })
      .then((r) => r.json()).then((j: QueueResp) => {
        if (!live) return;
        setRoster(Array.isArray(j.roster) && j.roster.length ? j.roster : ['V', 'Zaki']);
        setDisEnabled(!!j.disagreement_enabled);
      }).catch(() => { if (live) setRoster(['V', 'Zaki']); });
    return () => { live = false; };
  }, []);

  // Gamification stats — team block + badges on the identity screen; refetched per reviewer on begin().
  // Fully fail-safe: on any error `stats` stays null and the surface renders exactly as before.
  const loadStats = useCallback(async (who?: string) => {
    try {
      const r = await fetch(`/api/care/review-stats${who ? `?reviewer=${encodeURIComponent(who)}` : ''}`, { cache: 'no-store' });
      const j = (await r.json()) as StatsResp;
      if (j && j.ok) { setStats(j); setTeamTotal(j.team?.total ?? 0); setWeekMine(j.me?.week ?? 0); }
    } catch { /* leave stats as-is (identity screen renders as today) */ }
  }, []);
  useEffect(() => { void loadStats(); }, [loadStats]);

  const loadQueue = useCallback(async (who: string) => {
    setLoading(true); setLoadErr(null);
    try {
      // Study-lane wiring (U2): the lane rides the queue fetch so the exclusion is study-scoped
      // (route :149). Absent ⇒ the URL is byte-identical to today.
      const r = await fetch(`/api/care/review-queue?reviewer=${encodeURIComponent(who)}&n=120${study ? `&study=${encodeURIComponent(study)}` : ''}`, { cache: 'no-store' }); // §3.3 working set
      const j = (await r.json()) as QueueResp;
      if (!j.ok) throw new Error(j.error || 'failed to load queue');
      setItems(j.items || []);
      setIdx(0);
      setStatus({}); setSavedVerdicts({});   // fresh queue → reset navigator status
      setLabeledToday(j.stats?.labeled_today ?? 0);
      setDisEnabled(!!j.disagreement_enabled);
    } catch (e) { setLoadErr(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [study]);

  function begin(who: string) {
    setReviewer(who);
    setPhase('reviewing');
    sessionStart.current = Date.now();
    setSessionCount(0);
    void loadQueue(who);
    void loadStats(who);   // refetch with ?reviewer= to get the `me` block (own week + streak)
  }

  // reset per-finding state whenever the current finding changes. `selected` is SEEDED from the saved
  // verdict so revisiting a labeled item shows its saved state (§3.2). pdfOpen persists (session pref);
  // pdfError resets so a new note's iframe gets a fresh try.
  useEffect(() => {
    setSelected(currentKey ? (savedVerdicts[currentKey] ?? null) : null);
    setImpact(null); setBusy(false); setSavedMeta(null);
    setFailed(null); setErrMsg(''); setPdfError(false);
    setReasonOpen(false); setReasonText(''); setMissedOpen(false); setMissedCat(null); setMissedText(''); setMissedSaved(false);
  }, [idx, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter / auto-advance: jump to the next UNLABELED item in flattened navigator order (§3.2); when
  // none remain the queue-clear moment shows (done, below).
  const advance = useCallback(() => {
    const next = nextUnlabeled(nav.order, status, currentKey);
    if (next) selectByKey(next);
  }, [nav.order, status, currentKey, selectByKey]);

  // skip: mark 'skipped' (sinks to the end of its section via the core) + advance.
  const skip = useCallback(() => {
    if (!currentKey) return;
    setStatus((s) => ({ ...s, [currentKey]: 'skipped' }));
    const next = nextUnlabeled(nav.order, { ...status, [currentKey]: 'skipped' }, currentKey);
    if (next) selectByKey(next);
  }, [currentKey, nav.order, status, selectByKey]);

  const savePillPost = useCallback(async (attempt: Attempt) => {
    if (!current) return;
    setBusy(true); setFailed(null); setErrMsg('');
    try {
      await post({
        scope: 'finding', auditId: current.audit_id, finding_ref: current.finding_ref,
        signal_type: current.signal_type || null, verdict: attempt.verdict, comment: attempt.comment, author: reviewer,
        // U2: one session, one lane — the retry path replays through here too. Guarded spread, not
        // `study ?? null`: §2.3's byte-identical contract requires the unset body to carry NO study
        // key at all (a "study":null field would change the request bytes; the parser treats both
        // identically, so the lane semantics are unchanged either way).
        ...(study ? { study } : {}),
      });
      setSavedMeta(savedLabel(reviewer, new Date()));
      setSessionCount((c) => c + 1);
      setLabeledToday((c) => c + 1);
      setTeamTotal((t) => t + 1); setWeekMine((w) => w + 1); // §2.2 counted-save increment
      // navigator: mark this item labeled + remember the verdict for revisit (§3.2). Append-only writes
      // unchanged — this is presentation state only. Auto-advance stays on Enter (existing behavior).
      const k = itemKey(current);
      setStatus((s) => ({ ...s, [k]: 'labeled' }));
      setSavedVerdicts((v) => ({ ...v, [k]: attempt.verdict }));
    } catch (e) {
      setSelected(revertOnFail(attempt));
      setFailed(attempt);
      setErrMsg(String((e as Error).message).slice(0, 60));
    }
    setBusy(false);
  }, [current, reviewer, study]);

  const tapVerdict = useCallback((key: string) => {
    if (!current || busy) return;
    const plan = planTap(selected, key);
    if (plan.noop) return;
    setSelected(key);
    setImpact(null);
    if (key === 'false' || key === 'contested') { setReasonOpen(true); setReasonText(''); }
    else setReasonOpen(false);
    void savePillPost(makeAttempt(plan.prev, key, null));
  }, [current, busy, selected, savePillPost]);

  const cycleImpact = useCallback(() => {
    if (!current || busy || selected !== 'true_positive') return;
    const order: (string | null)[] = [null, ...IMPACT_TAGS];
    const nextTag = order[(order.indexOf(impact) + 1) % order.length];
    setImpact(nextTag);
    if (nextTag) {
      void post({ scope: 'impact', auditId: current.audit_id, finding_ref: current.finding_ref, signal_type: current.signal_type || null, verdict: nextTag, author: reviewer, ...(study ? { study } : {}) })
        .catch(() => { /* impact is a soft second tap; failure is non-blocking */ });
    }
  }, [current, busy, selected, impact, reviewer, study]);

  const saveReason = useCallback(() => {
    if (!current || !selected) return;
    const txt = reasonText.trim();
    setReasonOpen(false);
    if (txt) void savePillPost(makeAttempt(selected, selected, txt));
  }, [current, selected, reasonText, savePillPost]);

  const saveMissed = useCallback(async () => {
    if (!current) return;
    const txt = missedText.trim();
    if (!txt) return; // core requires a comment on missed
    // F6 (A10.1): the core now REJECTS a missed row without a category, so gate here rather than
    // let Enter produce a 400. Never defaulted — an auto-picked classifier would silently mislabel
    // the recall denominator it feeds.
    if (!missedCat) { setErrMsg('pick a category (1–7) first'); return; }
    try {
      await post({ scope: 'missed', auditId: current.audit_id, verdict: 'missed', comment: txt, category: missedCat, author: reviewer, ...(study ? { study } : {}) });
      setMissedSaved(true); setMissedOpen(false); setMissedText(''); setMissedCat(null); setErrMsg('');
      setSessionCount((c) => c + 1); setLabeledToday((c) => c + 1);
      setTeamTotal((t) => t + 1); setWeekMine((w) => w + 1); // §2.2 counted-save increment
    } catch (e) { setErrMsg(String((e as Error).message).slice(0, 60)); }
  }, [current, missedText, missedCat, reviewer, study]);

  // ── keyboard ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'reviewing') return;
    const onKey = (e: KeyboardEvent) => {
      // The guide owns the keyboard while open — ALL review keys suspended (§2.5). The guide's own
      // effect handles Esc-to-close; we never register a second handler for the review keys.
      if (guideOpen) return;
      // while a text input is focused, let the input own the keys (its own handlers save/skip)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '?') { e.preventDefault(); setGuideOpen(true); return; } // `?` opens the guide
      if (missedOpen) {
        if (e.key >= '1' && e.key <= '7') { e.preventDefault(); setMissedCat(MISSED_CATEGORIES[Number(e.key) - 1]); }
        else if (e.key === 'Escape') { e.preventDefault(); setMissedOpen(false); }
        return;
      }
      if (reasonOpen) { if (e.key === 'Escape') { e.preventDefault(); setReasonOpen(false); } return; }
      switch (e.key) {
        case '1': case '2': case '3': case '4':
          e.preventDefault(); tapVerdict(VERDICT_PILLS[Number(e.key) - 1].key); break;
        case 'i': case 'I': e.preventDefault(); cycleImpact(); break;
        case 'm': case 'M': e.preventDefault(); setMissedOpen(true); setMissedCat(null); setMissedText(''); break;
        case 's': case 'S': e.preventDefault(); skip(); break;
        case 'Enter': e.preventDefault(); advance(); break;
        case ' ': e.preventDefault(); setPdfOpen((o) => !o); break; // v1.1: space toggles the PDF pane
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, guideOpen, modalOpen, reasonOpen, missedOpen, tapVerdict, cycleImpact, skip, advance]);

  const lpm = useMemo(() => {
    const mins = (Date.now() - sessionStart.current) / 60000;
    return mins > 0.05 ? (sessionCount / mins).toFixed(1) : '—';
  }, [sessionCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── identity gate ───────────────────────────────────────────────────────────
  if (phase === 'identify') {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <h1 className="text-[22px] font-semibold text-slate-900">Review Mode</h1>
        <p className="mt-1 text-[13px] text-slate-500">Keyboard-first finding triage. Pick your reviewer identity to start — it rides every label.</p>

        {studyBanner && <div className="mt-4">{studyBanner}</div>}

        {/* team progress block (§2.1) — omitted entirely when stats are absent (fail-safe) */}
        {stats && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span className="font-medium text-slate-700">{stats.goal.label}</span>
              <span className="tabular-nums text-slate-600"><b className="text-slate-800">{stats.team.total}</b> / {stats.goal.target}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.max(1, Math.min(100, (stats.team.total / Math.max(1, stats.goal.target)) * 100))}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">this week <b className="text-slate-700">{stats.team.week}</b> / {stats.goal.weekly_target}</div>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {roster.map((who) => (
            <button key={who} onClick={() => begin(who)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-left text-[14px] font-medium text-slate-800 hover:border-sky-300 hover:bg-sky-50">
              {who}<span className="text-[11px] text-slate-400">start →</span>
            </button>
          ))}
          {roster.length === 0 && <div className="text-[12px] text-slate-400">Loading roster…</div>}
        </div>

        {/* quiet badges row (§2.1) — one entry per roster member who has a streak and/or agreement */}
        {stats && stats.badges.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-slate-500">
            {stats.badges.map((b) => (
              <span key={b.author} className="inline-flex items-center gap-1.5">
                <span className="font-medium text-slate-600">{b.author}</span>
                {b.streak != null && <span className="text-amber-600">🔥 {b.streak}-day streak</span>}
                {b.agreement_pct != null && <span className="text-sky-600">🤝 {b.agreement_pct}% agreement</span>}
              </span>
            ))}
          </div>
        )}
        <p className="mt-4 text-[11px] text-slate-400">Roster is set in app_settings <code>review_roster</code>. Disagreement queue: {disEnabled ? 'ON' : 'off (serving fresh findings)'}.</p>
      </div>
    );
  }

  // ── reviewing ─────────────────────────────────────────────────────────────────
  // queue-clear fires when ALL sections are exhausted — no item is still 'unlabeled' (§3.2).
  const done = !loading && items.length > 0 && !items.some((it) => (status[itemKey(it)] ?? 'unlabeled') === 'unlabeled');
  return (
    <div className="w-full px-6 py-5" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {studyBanner}
      {/* rail */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2 text-[12px] text-slate-500">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-white">{reviewer}</span>
          <button onClick={() => setPhase('identify')} className="text-[11px] text-slate-400 hover:text-slate-600">switch</button>
        </div>
        <div className="flex items-center gap-3">
          <span>Today <b className="text-slate-700">{labeledToday}</b></span>
          <span>Session <b className="text-slate-700">{sessionCount}</b></span>
          <span>{lpm}/min</span>
          {/* gamification chips (§2.2) — team goal, and own weekly (own session only) */}
          {stats && <span className="text-slate-400">team <b className="text-slate-600">{teamTotal}</b>/{stats.goal.target}</span>}
          {stats?.me && <span className="text-slate-400">wk <b className="text-slate-600">{weekMine}</b>/{stats.me.personal_weekly_target}</span>}
          <span className="text-slate-400">{Math.min(idx + 1, items.length)}/{items.length}</span>
          <button onClick={() => loadQueue(reviewer)} className="rounded border border-slate-200 px-2 py-0.5 text-[11px] hover:border-slate-300">reload</button>
        </div>
      </div>

      {loading ? (
        <div className="mt-20 text-center text-[13px] text-slate-400">Loading queue…</div>
      ) : loadErr ? (
        <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{loadErr}</div>
      ) : done ? (
        <div className="mt-20 text-center">
          <div className="text-[15px] font-medium text-emerald-700">✓ Queue clear</div>
          <p className="mt-1 text-[12.5px] text-slate-500">
            {stats
              ? <>{sessionCount} labeled this session — you moved the team to {teamTotal}/{stats.goal.target}.{stats.me && stats.me.streak > 0 ? ` 🔥 ${stats.me.streak}-day streak.` : ''}</>
              : <>{sessionCount} labeled this session. Nice.</>}
          </p>
          <button onClick={() => loadQueue(reviewer)} className="mt-4 rounded-lg bg-slate-800 px-4 py-2 text-[13px] font-medium text-white hover:bg-slate-900">Load more</button>
        </div>
      ) : current ? (
        <div className={`grid items-start gap-4 ${pdfOpen ? 'grid-cols-[320px_minmax(0,1fr)_400px]' : 'grid-cols-[320px_minmax(0,1fr)]'}`}>
          {/* left pane — finding navigator (§3.2). Mouse-first; no new keys. */}
          <Navigator nav={nav} currentKey={currentKey} onSelect={selectByKey} />

          {/* middle pane — original prescription PDF (§3.1); iframe keyed by url so same-note
              consecutive findings do NOT reload it. `space` toggles this pane. */}
          {pdfOpen && (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2 text-[11.5px] text-slate-500">
                <span className="truncate">{current.uid ? current.uid.slice(0, 8) : '—'} · {current.note_date}</span>
                <a href={`/api/opd-audit/export-pdf?id=${current.audit_id}`} target="_blank" rel="noopener" className="shrink-0 text-sky-700 hover:underline">Download note+audit PDF</a>
              </div>
              {current.prescription_url && !pdfError ? (
                <iframe key={current.prescription_url} src={`${current.prescription_url}#navpanes=0&view=FitH`} title="Original prescription"
                  onError={() => setPdfError(true)}
                  className="h-[80vh] w-full rounded-lg border border-slate-200 bg-white" />
              ) : (
                <div className="flex h-[80vh] w-full flex-col items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-center">
                  <p className="text-[13px] text-slate-500">Original prescription unavailable</p>
                  <a href={`/api/opd-audit/export-pdf?id=${current.audit_id}`} target="_blank" rel="noopener" className="mt-2 text-[12px] text-sky-700 hover:underline">Download note+audit PDF</a>
                </div>
              )}
            </div>
          )}

          {/* right pane — the finding card + verdict/impact/missed tools (behavior unchanged) */}
          <div>
          {/* finding card */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{current.signal_type || 'finding'}</span>
              <span className="rounded-full bg-slate-50 px-2 py-0.5 text-slate-500">{current.domain}</span>
              <span className="rounded-full bg-slate-50 px-2 py-0.5 text-slate-500">{current.verdict}</span>
              {current.queue === 'disagreement' && current.disagreement_type && (
                <span className={`rounded-full px-2 py-0.5 font-medium ${DIS_TONE[current.disagreement_type] || 'bg-slate-100 text-slate-600'}`}>
                  ⚡ {current.disagreement_reason || current.disagreement_type}
                </span>
              )}
              <span className="ml-auto text-slate-400">{current.note_date}</span>
            </div>
            <h2 className="mt-2 text-[16px] font-semibold leading-snug text-slate-900">{current.subject}</h2>
            {current.rationale && <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">{current.rationale}</p>}

            {/* metadata context — now ALWAYS inline (§2.3); the source prescription sits alongside */}
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-600">
              <div>Doctor <span className="text-slate-500">{current.doctor_uid || '—'}</span> · signal_type <span className="text-slate-500">{current.signal_type}</span></div>
              <div className="mt-0.5">finding_ref <code className="text-slate-400">{current.finding_ref}</code></div>
              {current.citation_ids && current.citation_ids.length > 0 && <div className="mt-0.5">Citations: {current.citation_ids.join(', ')}</div>}
            </div>
          </div>

          {/* verdict strip */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {VERDICT_PILLS.map((p) => (
              <button key={p.key} onClick={() => tapVerdict(p.key)} disabled={busy}
                className={`rounded-full border px-3 py-1.5 text-[13px] font-medium ${selected === p.key ? p.on : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                <span className="mr-1 text-[10px] text-slate-400">{p.digit}</span>{p.label}
              </button>
            ))}
            {busy && <span className="text-[11px] text-slate-400">saving…</span>}
            {failed && <button onClick={() => { setSelected(failed.verdict); void savePillPost(failed); }} className="text-[11px] font-semibold text-red-600 hover:underline">Not saved — retry</button>}
            {failed && errMsg && <span className="text-[10px] text-red-400">{errMsg}</span>}
            {!failed && savedMeta && <span className="text-[11px] text-slate-400">{savedMeta}</span>}
          </div>

          {/* impact tag (TP only) */}
          {selected === 'true_positive' && (
            <div className="mt-2 flex items-center gap-2 text-[12px]">
              <span className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Impact <span className="text-slate-300">(i)</span></span>
              {IMPACT_TAGS.map((t) => (
                <button key={t} onClick={cycleImpact}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] ${impact === t ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-500'}`}>
                  {IMPACT_LABELS[t]}
                </button>
              ))}
            </div>
          )}

          {/* reason input (3/4) */}
          {reasonOpen && (
            <div className="mt-2 flex items-center gap-2">
              <input autoFocus value={reasonText} onChange={(e) => setReasonText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveReason(); } else if (e.key === 'Escape') { e.preventDefault(); setReasonOpen(false); } }}
                placeholder={selected === 'false' ? 'Why is this wrong? (Enter saves · Esc skips)' : 'Why contested? (Enter saves · Esc skips)'}
                className="h-8 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-[12.5px] text-slate-700 outline-none focus:border-sky-400" />
            </div>
          )}

          {/* missed flow (this note) */}
          <div className="mt-4 border-t border-slate-100 pt-3">
            {!missedOpen ? (
              <button onClick={() => { setMissedOpen(true); setMissedCat(null); setMissedText(''); }} className="text-[12px] text-slate-500 hover:text-sky-700">
                + Flag a missed finding on this note <span className="text-slate-300">(m)</span>
              </button>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3">
                <div className="flex flex-wrap gap-1.5">
                  {MISSED_CATEGORIES.map((c, i) => (
                    <button key={c} onClick={() => setMissedCat(c)}
                      className={`rounded-full border px-2 py-1 text-[11px] ${missedCat === c ? 'border-sky-400 bg-sky-50 text-sky-800' : 'border-slate-200 text-slate-500'}`}>
                      <span className="mr-1 text-[9px] text-slate-400">{i + 1}</span>{c}
                    </button>
                  ))}
                  {!missedCat && <span className="self-center text-[10px] font-medium text-amber-600">category required</span>}
                </div>
                <input autoFocus value={missedText} onChange={(e) => setMissedText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveMissed(); } else if (e.key === 'Escape') { e.preventDefault(); setMissedOpen(false); } }}
                  placeholder={missedCat ? 'What should the audit have caught? (required · Enter saves)' : 'Pick a category above (1–7) first — then describe what was missed'}
                  className="mt-2 h-8 w-full rounded-lg border border-slate-200 bg-white px-3 text-[12.5px] text-slate-700 outline-none focus:border-sky-400" />
                <div className="mt-1.5 flex items-center gap-2">
                  <button onClick={() => void saveMissed()} disabled={!missedText.trim()}
                    className={`rounded-lg px-3 py-1 text-[12px] font-medium text-white ${missedText.trim() ? 'bg-slate-800 hover:bg-slate-900' : 'cursor-not-allowed bg-slate-300'}`}>Save missed</button>
                  <button onClick={() => setMissedOpen(false)} className="text-[11px] text-slate-400 hover:text-slate-600">cancel</button>
                </div>
              </div>
            )}
            {missedSaved && <span className="ml-2 text-[11px] text-emerald-600">✓ missed flag saved</span>}
          </div>

          {/* footer hints */}
          <div className="mt-6 flex items-center justify-between text-[11px] text-slate-400">
            <span>1 TP · 2 Nitpick · 3 False · 4 Contested · i impact · m missed · s skip · space prescription · ? guide</span>
            <button onClick={advance} className="rounded-lg border border-slate-200 px-3 py-1 font-medium text-slate-600 hover:border-slate-300">Next (⏎)</button>
          </div>
          </div>
        </div>
      ) : (
        <div className="mt-20 text-center text-[13px] text-slate-400">Nothing in the queue.</div>
      )}

      {/* floating reviewer guide (§2.5) — owns the keyboard while open (review keys suspended above) */}
      <ReviewGuide open={guideOpen} onOpen={() => setGuideOpen(true)} onClose={() => setGuideOpen(false)} />
    </div>
  );
}
