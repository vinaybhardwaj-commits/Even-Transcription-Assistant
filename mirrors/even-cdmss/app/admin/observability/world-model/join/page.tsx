/**
 * app/admin/observability/world-model/join/page.tsx — WM3: the join's readout.
 *
 * What the record held before a note, what result arrived after it, and what the record held once
 * that result had landed. This page counts those rows and, for one individual, shows O_before and
 * O_after side by side.
 *
 * ⚠️ THE TWO HONESTIES ON THIS PAGE ARE DIFFERENT, AND BOTH ARE RENDERED UNCONDITIONALLY.
 *   · O_before and O_after are as-of reconstructions and carry the walk's chip: dated by CLINICAL
 *     date, result-availability lag NOT modelled.
 *   · Y is the one place the lag IS modelled, and `y_visible_rule` says which rule produced each
 *     one. A `test_date_only` row is one whose lag COULD NOT be modelled — pre-13-July-2023, or a
 *     null _create_time — and must never be read as one whose was. It is shown on every triple.
 *
 * ⚠️ `context_fetch_failed` is counted as itself, never folded into a zero. An outage during a
 * capture is "we could not read", not "there was nothing".
 *
 * Read-only. Admin-gated by the same `isAdminUnlocked` wall as the World Model walk. Every read is
 * fail-safe: a failed count renders as an honest dash, never as a zero.
 */
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { GRAIN_LABEL, HONESTY_CHIP } from '@/lib/world-model/walk-o';
import { JOIN_SCHEMA_VERSION } from '@/lib/cognition/schema';
import { Y_HORIZON_DAYS } from '@/lib/cognition/join-sweep';
import { joinCounts, listTriplesForIndividual, getSnapshot, type JoinCounts, type TripleRow, type SnapshotRow } from '@/lib/cognition/join-store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Join · World Model · Observability' };

type SP = { individual_uid?: string };

/** The sentence that must never be edited into something softer. */
const O_BEFORE_CHIP = 'O_before is the state before the day of the note. Same-day results are not in it.';

/** The second sentence of the same kind: a count over these rows is a count over three different
 *  populations unless the reader separates them, and the era card is where they separate. */
const ERA_CHIP = 'current = opened from an eligible shadow event · stale = opened from one the burden policy refused as stale_era · unaudited = opened from a raw db13 note the audit engine never saw. Do not sum them into one rate without saying which denominator you mean.';

function Chip({ children, tone = 'slate', title }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'brand' | 'red'; title?: string }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'brand' ? 'border-brand/30 bg-brand/5 text-brand'
    : tone === 'red' ? 'border-red-300 bg-red-50 text-red-800'
    : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span title={title} className={`rounded border px-1.5 py-0.5 text-[10.5px] ${cls}`}>{children}</span>;
}

function Counts({ title, hint, rows }: { title: string; hint?: string; rows: { k: string; n: number }[] | null }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
      {rows === null ? <div className="mt-2 text-[12px] text-red-700">Could not read — this is not zero.</div>
        : rows.length === 0 ? <div className="mt-2 text-[12px] italic text-slate-300">none yet</div>
          : (
            <ul className="mt-2 space-y-1 text-[12px]">
              {rows.map((r) => (
                <li key={r.k} className="flex items-baseline justify-between gap-2">
                  <span className={r.k === 'context_fetch_failed' ? 'text-red-700' : 'text-slate-700'}>{r.k}</span>
                  <span className="font-mono text-slate-500">{r.n}</span>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

// ── the snapshot renderer ─────────────────────────────────────────────────────────────────────
// The walk page's slot idiom, carried here rather than imported: that page is a server component
// whose contract in this build is one added link. Every slot shows its count — an empty slot is a
// fact, a missing line would read as no data.
interface Concept { raw?: string }
interface Snapshot {
  asOf?: string; version?: string; sourceEncounterRefs?: unknown[];
  problems?: { normalizedConcept?: Concept; latestDocumentedStatus?: string; occurrences?: unknown[] }[];
  medications?: { normalizedConcept?: Concept; status?: string; occurrences?: unknown[] }[];
  allergies?: { substance?: Concept; status?: string }[];
  investigations?: { normalizedAnalyte?: Concept; unit?: string; series?: { value?: unknown; date?: string }[] }[];
  procedures?: { normalizedConcept?: Concept; occurrences?: unknown[] }[];
  followUps?: unknown[];
  conflicts?: { domain?: string; type?: string; severity?: string }[];
}

const day = (d?: string | null) => String(d ?? '').slice(0, 10) || '—';

function Slot({ title, n, children }: { title: string; n: number; children?: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title} <span className="text-slate-300">·</span> {n}</div>
      {n === 0 ? <div className="text-[12px] italic text-slate-300">none</div>
        : <ul className="mt-0.5 space-y-0.5 text-[12px] text-slate-700">{children}</ul>}
    </div>
  );
}

function SnapshotBody({ snap }: { snap: Snapshot }) {
  const problems = snap.problems ?? []; const medications = snap.medications ?? [];
  const allergies = snap.allergies ?? []; const investigations = snap.investigations ?? [];
  const procedures = snap.procedures ?? []; const followUps = snap.followUps ?? [];
  const conflicts = snap.conflicts ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
        <Chip>asOf {day(snap.asOf)}</Chip>
        {snap.version ? <Chip>{snap.version}</Chip> : null}
        <Chip>{(snap.sourceEncounterRefs ?? []).length} encounter{(snap.sourceEncounterRefs ?? []).length === 1 ? '' : 's'}</Chip>
      </div>
      <Slot title="Problems" n={problems.length}>
        {problems.map((p, i) => (
          <li key={i}><span className="font-medium">{p.normalizedConcept?.raw}</span>
            <span className="text-slate-400"> · {p.latestDocumentedStatus} · {(p.occurrences ?? []).length}×</span></li>
        ))}
      </Slot>
      <Slot title="Medications" n={medications.length}>
        {medications.map((m, i) => (
          <li key={i}><span className="font-medium">{m.normalizedConcept?.raw}</span>
            <span className="text-slate-400"> · {m.status} · {(m.occurrences ?? []).length}×</span></li>
        ))}
      </Slot>
      <Slot title="Allergies" n={allergies.length}>
        {allergies.map((a, i) => <li key={i}><span className="font-medium">{a.substance?.raw}</span><span className="text-slate-400"> · {a.status}</span></li>)}
      </Slot>
      <Slot title="Investigations" n={investigations.length}>
        {investigations.map((inv, i) => {
          const series = inv.series ?? []; const latest = series[series.length - 1];
          return (
            <li key={i}><span className="font-medium">{inv.normalizedAnalyte?.raw}</span>
              <span className="text-slate-400"> · {series.length} pt{series.length === 1 ? '' : 's'}
                {latest ? ` · latest ${String(latest.value)}${inv.unit ? ` ${inv.unit}` : ''} (${day(latest.date)})` : ''}</span></li>
          );
        })}
      </Slot>
      <Slot title="Procedures" n={procedures.length}>
        {procedures.map((p, i) => <li key={i}><span className="font-medium">{p.normalizedConcept?.raw}</span><span className="text-slate-400"> · {(p.occurrences ?? []).length}×</span></li>)}
      </Slot>
      <Slot title="Follow-ups" n={followUps.length}>
        {followUps.map((f, i) => <li key={i} className="text-slate-700">{JSON.stringify(f).slice(0, 140)}</li>)}
      </Slot>
      <Slot title="Conflicts" n={conflicts.length}>
        {conflicts.map((c, i) => <li key={i}><span className="font-medium">{c.domain} · {c.type}</span><span className="text-slate-400"> · {c.severity}</span></li>)}
      </Slot>
    </div>
  );
}

/** One side of the pair. A non-`ok` capture renders its status and NOT an empty state. */
function SnapshotPane({ title, asOf, snap }: { title: string; asOf: string | null; snap: SnapshotRow | null }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title}</div>
        <Chip>as_of {day(asOf)}</Chip>
      </div>
      {snap == null ? <p className="mt-2 text-[12px] italic text-slate-300">not captured</p>
        : snap.cut_status === 'context_fetch_failed'
          ? <p className="mt-2 text-[12px] text-red-700">context fetch failed — we do <b>not</b> know what was there. This is not an empty record.</p>
          : snap.cut_status === 'no_prior_history'
            ? <p className="mt-2 text-[12px] text-slate-500">no prior history — we looked, and there was nothing before this day.</p>
            : <div className="mt-2"><SnapshotBody snap={(snap.snapshot_json ?? {}) as Snapshot} /></div>}
    </div>
  );
}

function hours(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(1)} h`;
}

/**
 * O_before stability (N5). The memo's threshold is 95%; the number is shown and NOT coloured —
 * a threshold rendered as a traffic light invites the reader to stop at the colour, and this is a
 * measurement somebody has to look at.
 *
 * A null rate is "not measured" (every sampled row failed to read), never 0%.
 */
function StabilityCard({ s }: { s: JoinCounts['stability'] | undefined }) {
  const rate = s?.match_rate == null ? null : `${(s.match_rate * 100).toFixed(1)}%`;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">O_before stability</div>
      {s === undefined ? <div className="mt-2 text-[12px] text-red-700">Could not read — this is not zero.</div>
        : s === null ? <div className="mt-2 text-[12px] italic text-slate-300">not yet run</div>
          : (
            <>
              <div className="mt-0.5 font-serif text-[24px] font-semibold text-slate-900">
                {s.matched_n}/{s.sample_n}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                {rate == null ? 'match rate not measured — every sampled read failed' : `${rate} of those we could re-read`}
                {s.failed_n > 0 ? ` · ${s.failed_n} could not be re-read` : ''}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">run at {day(s.run_at)} · threshold 95%</div>
            </>
          )}
    </div>
  );
}

export default async function JoinPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await isAdminUnlocked())) {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
        Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.
      </div>
    );
  }

  const counts: JoinCounts | null = await joinCounts().catch(() => null);
  const sp = await searchParams;
  const uid = (sp.individual_uid ?? '').trim();

  let triples: TripleRow[] = [];
  let readFailed = false;
  const snapshots = new Map<string, SnapshotRow | null>();
  if (uid) {
    try {
      triples = await listTriplesForIndividual(uid);
      for (const t of triples) {
        for (const id of [t.o_before_id, t.o_after_id]) {
          if (id && !snapshots.has(id)) snapshots.set(id, await getSnapshot(id));
        }
      }
    } catch { readFailed = true; }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">World Model · Join</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
            For each headache note this build can see — audited and current-era, audited under a superseded engine, or
            never audited at all: what the record held before it, the first result that became visible after it, and what
            the record held once that result had landed. Read-only, internal. Nothing here is doctor-facing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/admin/observability/world-model" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">← Spine Walk</Link>
          <Link href="/admin/observability" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">← Observability</Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Chip tone="slate">grain: {GRAIN_LABEL}</Chip>
        <Chip tone="amber">{HONESTY_CHIP}</Chip>
        <Chip tone="amber">{O_BEFORE_CHIP}</Chip>
        <Chip tone="slate">Y horizon: {Y_HORIZON_DAYS} days</Chip>
        <Chip tone="amber" title={ERA_CHIP}>three populations, three denominators</Chip>
        <Chip tone="slate">{JOIN_SCHEMA_VERSION}</Chip>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Counts title="Triples by Y status" hint="pending is “not yet known”; missing is a conclusion" rows={counts?.triplesByYStatus ?? null} />
        <Counts title="Triples by provenance" hint="reconstructed = opened looking backwards" rows={counts?.triplesByProvenance ?? null} />
        <Counts title="Triples by resolve status" rows={counts?.triplesByResolveStatus ?? null} />
        <Counts title="Snapshots by cut status" hint="a failed capture is counted, never folded into a zero" rows={counts?.snapshotsByCutStatus ?? null} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Counts title="Triples by era status" hint="current = audited, current era · stale = audited under a superseded engine · unaudited = never audited" rows={counts?.triplesByEraStatus ?? null} />
        <Counts title="Triples by trigger kind" hint="opd_note_audited = the shadow agent judged it · opd_note_matched = the raw rule matched it" rows={counts?.triplesByTriggerKind ?? null} />
        <StabilityCard s={counts === null ? undefined : counts.stability} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Present with O_after ok" value={counts ? String(counts.presentWithOAfterOk) : '—'} hint="complete triples" />
        <Stat label="Reactions attached" value={counts ? String(counts.reactionsAttached) : '—'} hint="a doctor pressed something on this signal" />
        <Stat label="Y lag — visible" value={counts ? hours(counts.lag.visibleMedianH) : '—'} hint={counts ? `p90 ${hours(counts.lag.visibleP90H)} · visible_at − event_at` : 'could not read'} />
        <Stat label="Y lag — test date" value={counts ? hours(counts.lag.testMedianH) : '—'} hint={counts ? `p90 ${hours(counts.lag.testP90H)} · test_date − event_at` : 'could not read'} />
      </div>

      <form method="GET" className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col text-[10.5px] text-slate-500">individual_uid
          <input name="individual_uid" defaultValue={uid} placeholder="ind_…"
            className="mt-0.5 h-8 w-64 rounded-md border border-slate-200 px-2 font-mono text-[12px]" />
        </label>
        <button className="h-8 rounded-lg bg-brand px-4 text-[12px] font-medium text-white hover:bg-brand-dark">Show triples</button>
      </form>

      {!uid ? null : readFailed ? (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">
          Could not read this individual&apos;s triples. This is <b>not</b> an empty result.
        </div>
      ) : triples.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          We looked, and this individual has <b>no triples</b> under {JOIN_SCHEMA_VERSION}.
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {triples.map((t) => (
            <div key={t.id} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12px] font-medium text-slate-900">{t.event_ref}</span>
                <Chip>event {day(t.event_at)}</Chip>
                <Chip tone={t.y_status === 'present' ? 'brand' : t.y_status === 'pending' ? 'slate' : 'amber'}>Y: {t.y_status}</Chip>
                <Chip>{t.provenance}</Chip>
                <Chip tone={t.resolve_status === 'resolved' ? 'slate' : 'amber'}>{t.resolve_status}</Chip>
                {t.y_visible_rule
                  ? <Chip tone={t.y_visible_rule === 'greatest_v1' ? 'brand' : 'amber'}
                      title={t.y_visible_rule === 'greatest_v1'
                        ? 'visibility is the later of test date and creation time'
                        : 'the lag could NOT be modelled for this row — read it as a test date, not as a visibility'}>
                      {t.y_visible_rule}
                    </Chip>
                  : null}
                {t.reaction_ref ? <Chip tone="brand">reaction attached</Chip> : null}
              </div>
              {t.y_status === 'present' ? (
                <p className="mt-1.5 text-[11.5px] text-slate-500">
                  Y {t.y_kind} <span className="font-mono">{t.y_ref}</span> · test {day(t.y_test_date)} ·
                  {' '}created {day(t.y_create_time)} · visible {day(t.y_visible_at)}
                </p>
              ) : null}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <SnapshotPane title="O_before" asOf={t.o_before_id ? (snapshots.get(t.o_before_id)?.as_of ?? null) : null}
                  snap={t.o_before_id ? (snapshots.get(t.o_before_id) ?? null) : null} />
                <SnapshotPane title="O_after" asOf={t.o_after_as_of}
                  snap={t.o_after_id ? (snapshots.get(t.o_after_id) ?? null) : null} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
