/**
 * app/admin/observability/world-model/page.tsx — WM0 slice W0.2: the SPINE WALK readout.
 *
 * One member, one column per calendar day on which they have OPD or lab evidence, each column
 * showing the spine AS IT STOOD THE MORNING OF THAT DAY. The page renders `walkO`'s output and
 * computes nothing clinical of its own.
 *
 * ── WHY THIS RENDERS THE SNAPSHOT DIRECTLY AND NOT `presentMemberState` ─────────────────────────
 *
 * `presentMemberState` is the CLINICIAN view, and it deliberately DROPS `procedures` and
 * `followUps`. This surface exists to show what the spine actually holds, so dropping two slots
 * would defeat its whole purpose — a walk that hides the procedure history cannot be used to check
 * whether the procedure history reconstructs. So the renderer reads the frozen snapshot itself, and
 * every slot including `procedures` and `followUps` is on the page.
 *
 * ── THE TWO LABELS ARE ALWAYS VISIBLE, AND THEY ARE NOT DECORATION ──────────────────────────────
 *
 * `GRAIN_LABEL`  — the walk's grain: a cut is a calendar day, and that day's own evidence is OUT.
 * `HONESTY_CHIP` — C1, verbatim: cuts are dated by CLINICAL date, and result-availability lag is
 *                  NOT modelled. A lab drawn on the 3rd and reported on the 5th sits at the 3rd, so
 *                  a cut can show a value no clinician could yet have seen. Anyone reading a cut as
 *                  "what the doctor knew" without this chip is reading it wrong.
 * Both come from the walker as constants so the page cannot paraphrase them into something softer.
 *
 * ── THE THREE STATUSES ARE RENDERED AS THREE DIFFERENT THINGS ───────────────────────────────────
 *
 * `ok` / `no_prior_history` / `context_fetch_failed` never share a colour or a phrase. An outage
 * must never be able to look like a clean slate; that is the entire point of the enum.
 *
 * Read-only. Admin-gated by the same `isAdminUnlocked` wall as Observability. No API route, no
 * server action, no cookie of its own, no clinician sitemap entry: a server component that calls
 * the walker directly.
 */
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  walkO, resolveWalkSubject, ipdFoldLabelFor,
  WORLD_MODEL_WALK_VERSION, GRAIN_LABEL, HONESTY_CHIP,
  type WalkO, type WalkCut, type WalkCutStatus, type WalkFlags,
} from '@/lib/world-model/walk-o';
import type { MemberStateSnapshot } from '@/lib/member-state/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'World Model · Spine Walk · Observability' };

type SP = { individual_uid?: string; uhid?: string; order?: string };

// ── small presentational atoms ────────────────────────────────────────────────────────────────

const STATUS_META: Record<WalkCutStatus, { label: string; hint: string; cls: string }> = {
  ok: {
    label: 'ok',
    hint: 'the spine reconstructed, with prior evidence',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  no_prior_history: {
    label: 'no prior history',
    hint: 'we looked, and there was nothing before this day',
    cls: 'border-slate-200 bg-slate-50 text-slate-600',
  },
  context_fetch_failed: {
    // Deliberately the loud one. This is "we do not know", not "there was nothing".
    label: 'context fetch failed',
    hint: 'db13 failed — we do NOT know what was there. This is not an empty history.',
    cls: 'border-red-300 bg-red-50 text-red-800',
  },
};

function StatusChip({ status }: { status: WalkCutStatus }) {
  const m = STATUS_META[status];
  return <span title={m.hint} className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${m.cls}`}>{m.label}</span>;
}

function Chip({ children, tone = 'slate', title }: { children: React.ReactNode; tone?: 'slate' | 'amber' | 'brand'; title?: string }) {
  const cls = tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'brand' ? 'border-brand/30 bg-brand/5 text-brand'
    : 'border-slate-200 bg-slate-50 text-slate-600';
  return <span title={title} className={`rounded border px-1.5 py-0.5 text-[10.5px] ${cls}`}>{children}</span>;
}

/** One snapshot slot. `n` is always shown — an empty slot is a fact, not a blank. */
function Slot({ title, n, children }: { title: string; n: number; children?: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{title} <span className="text-slate-300">·</span> {n}</div>
      {n === 0
        ? <div className="text-[12px] italic text-slate-300">none</div>
        : <ul className="mt-0.5 space-y-0.5 text-[12px] text-slate-700">{children}</ul>}
    </div>
  );
}

const day = (d: string) => String(d ?? '').slice(0, 10) || '—';

/**
 * The frozen snapshot, rendered slot by slot — INCLUDING `procedures` and `followUps`, the two
 * `presentMemberState` drops. Nothing here is derived; every line is a field of the snapshot.
 */
function SnapshotBody({ snap }: { snap: MemberStateSnapshot }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
        <Chip>asOf {day(snap.asOf)}</Chip>
        <Chip>{snap.version}</Chip>
        <Chip>{snap.sourceEncounterRefs.length} encounter{snap.sourceEncounterRefs.length === 1 ? '' : 's'}</Chip>
      </div>

      <Slot title="Problems" n={snap.problems.length}>
        {snap.problems.map((p, i) => (
          <li key={i}>
            <span className="font-medium">{p.normalizedConcept.raw}</span>
            <span className="text-slate-400"> · {p.latestDocumentedStatus} · {p.course} · {p.occurrences.length}× · last {day(p.lastDocumentedAt)}</span>
          </li>
        ))}
      </Slot>

      <Slot title="Medications" n={snap.medications.length}>
        {snap.medications.map((m, i) => (
          <li key={i}>
            <span className="font-medium">{m.normalizedConcept.raw}</span>
            <span className="text-slate-400"> · {m.status} · {m.occurrences.length}× · last {day(m.lastSeen)}</span>
          </li>
        ))}
      </Slot>

      <Slot title="Allergies" n={snap.allergies.length}>
        {snap.allergies.map((a, i) => (
          <li key={i}><span className="font-medium">{a.substance.raw}</span><span className="text-slate-400"> · {a.status}</span></li>
        ))}
      </Slot>

      <Slot title="Investigations" n={snap.investigations.length}>
        {snap.investigations.map((inv, i) => {
          const latest = inv.series[inv.series.length - 1];
          return (
            <li key={i}>
              <span className="font-medium">{inv.normalizedAnalyte.raw}</span>
              <span className="text-slate-400"> · {inv.series.length} pt{inv.series.length === 1 ? '' : 's'}{latest ? ` · latest ${latest.value}${inv.unit ? ` ${inv.unit}` : ''} (${day(latest.date)})` : ''}</span>
            </li>
          );
        })}
      </Slot>

      {/* presentMemberState DROPS this slot. The walk shows it — that is the point of the surface. */}
      <Slot title="Procedures" n={snap.procedures.length}>
        {snap.procedures.map((p, i) => (
          <li key={i}>
            <span className="font-medium">{p.normalizedConcept.raw}</span>
            <span className="text-slate-400"> · {p.occurrences.length}× · last {day(p.lastSeen)}
              {p.occurrences[0]?.setting ? ` · ${p.occurrences[0].setting}` : ''}
              {p.occurrences[0]?.laterality ? ` · ${p.occurrences[0].laterality}` : ''}</span>
          </li>
        ))}
      </Slot>

      {/* presentMemberState DROPS this slot too. */}
      <Slot title="Follow-ups" n={snap.followUps.length}>
        {snap.followUps.map((f, i) => (
          <li key={i} className="text-slate-700">{JSON.stringify(f).slice(0, 140)}</li>
        ))}
      </Slot>

      <Slot title="Conflicts" n={snap.conflicts.length}>
        {snap.conflicts.map((c, i) => (
          <li key={i}>
            <span className="font-medium">{c.domain} · {c.type}</span>
            <span className="text-slate-400"> · {c.severity}</span>
          </li>
        ))}
      </Slot>
    </div>
  );
}

function CutCard({ cut }: { cut: WalkCut }) {
  const m = STATUS_META[cut.status];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[13px] font-medium text-slate-900">{cut.date}</div>
        <StatusChip status={cut.status} />
      </div>
      <p className="mt-1 text-[11px] text-slate-400">{m.hint}</p>

      {cut.status === 'ok' && cut.snapshot
        ? <div className="mt-3 border-t border-slate-100 pt-2"><SnapshotBody snap={cut.snapshot} /></div>
        : null}

      {/* C2 — the walk-level fold result, shown BESIDE the cut. These are member-level facts (one
          stay-library read per walk), so they repeat across cuts by design. */}
      {(cut.foldNotes.length > 0 || cut.foldRefused.length > 0) ? (
        <div className="mt-3 border-t border-slate-100 pt-2">
          {cut.foldNotes.length > 0 ? (
            <div>
              <div className="text-[10.5px] font-medium uppercase tracking-wide text-amber-600">Fold notes · {cut.foldNotes.length}</div>
              <ul className="mt-0.5 space-y-0.5 text-[11.5px] text-amber-800">
                {cut.foldNotes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          ) : null}
          {cut.foldRefused.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[10.5px] font-medium uppercase tracking-wide text-amber-600">Fold refusals · {cut.foldRefused.length}</div>
              <ul className="mt-0.5 space-y-0.5 text-[11.5px] text-amber-800">
                {cut.foldRefused.map((r, i) => <li key={i}><span className="font-medium">{r.concept}</span> <span className="text-amber-600">({r.slot}) — {r.reason}</span></li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The flag strip. A flag that is OFF is stated, never omitted — an absent flag reads as "no data". */
function FlagStrip({ flags }: { flags: WalkFlags }) {
  const ipd = ipdFoldLabelFor(flags);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(flags) as (keyof WalkFlags)[]).map((k) => (
        <Chip key={k} tone={flags[k] ? 'brand' : 'slate'}>{k} <span className="font-medium">{flags[k] ? 'on' : 'off'}</span></Chip>
      ))}
      {/* `fold_off` is "we did not look", which is NOT the same claim as "this member has no stays". */}
      <Chip tone={ipd === 'fold_off' ? 'amber' : 'brand'}>
        IPD: {ipd}{ipd === 'fold_off' ? ' — not looked at, NOT “no stays”' : ''}
      </Chip>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────

export default async function WorldModelWalkPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await isAdminUnlocked())) {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
        Access-controlled. <Link href="/admin/observability" className="text-brand hover:underline">Unlock Observability</Link> first.
      </div>
    );
  }

  const sp = await searchParams;
  const individualUidIn = (sp.individual_uid ?? '').trim();
  const uhidIn = (sp.uhid ?? '').trim();
  const newestFirst = sp.order !== 'oldest';
  const asked = Boolean(individualUidIn || uhidIn);

  let subject: Awaited<ReturnType<typeof resolveWalkSubject>> | null = null;
  let walk: WalkO | null = null;
  if (asked) {
    subject = await resolveWalkSubject({ individualUid: individualUidIn, uhid: uhidIn });
    if (subject.individualUid) {
      walk = await walkO(subject.individualUid, new Date().toISOString());
    }
  }
  const cuts = walk ? (newestFirst ? [...walk.cuts].reverse() : walk.cuts) : [];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">World Model · Spine Walk</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
            One cut per calendar day on which this member has OPD or lab evidence, each showing the MemberState spine
            as it stood the morning of that day. Reconstructed by the existing frozen as-of path; this surface computes
            nothing clinical of its own. Read-only, internal.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* WM1 — the shadow agent's readout. Shadow only; nothing there is doctor-facing. */}
          <Link href="/admin/observability/world-model/shadow" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">Shadow Agent →</Link>
          <Link href="/admin/observability" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">← Observability</Link>
        </div>
      </div>

      {/* THE ALWAYS-VISIBLE LABELS — rendered whether or not a walk has been run.
          Two honesty chips now, and they say different things: C1 is about WHEN evidence is dated,
          B.1 is about WHICH evidence exists at all. A reader who trusts the dates can still be
          misled by a lab slot that looks empty because the assembler dropped the rows. */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Chip tone="slate">grain: {GRAIN_LABEL}</Chip>
        <Chip tone="amber">{HONESTY_CHIP}</Chip>
        {/* CAT Design ratification, 31 Aug 2026 (invisible-labs, B.1). A thin `investigations`
            slot is NOT evidence of a member who had no tests — lib/member-state/assemble-core.ts
            skips any joined lab row with no `investigation_name` (the `if (!analyteRaw …) continue`
            at labRowsToEncounters). Recovery is a separate spine PRD; this chip is the interim
            honesty, and it is deliberately ADMIN-ONLY — no doctor-facing banner is implied. */}
        <Chip
          tone="amber"
          title="NULL investigation_name rows (42% of joined lab rows all-time, ongoing) are silently skipped by the frozen assembler. Recovery is a separate spine PRD. Evidence: 31 Aug 2026."
        >
          lab coverage incomplete: rows with no analyte name are dropped at assembly — thin or empty investigations are not evidence the member had no tests
        </Chip>
        <Chip tone="slate">{WORLD_MODEL_WALK_VERSION}</Chip>
      </div>

      <form method="GET" className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col text-[10.5px] text-slate-500">individual_uid
          <input
            name="individual_uid" defaultValue={individualUidIn} placeholder="ind_…" autoFocus
            className="mt-0.5 h-8 w-64 rounded-md border border-slate-200 px-2 font-mono text-[12px]"
          />
        </label>
        <label className="flex flex-col text-[10.5px] text-slate-500">uhid <span className="text-slate-300">(optional)</span>
          <input
            name="uhid" defaultValue={uhidIn} placeholder="resolved via individuals.kx_uhid"
            className="mt-0.5 h-8 w-56 rounded-md border border-slate-200 px-2 font-mono text-[12px]"
          />
        </label>
        <label className="flex flex-col text-[10.5px] text-slate-500">order
          <select name="order" defaultValue={newestFirst ? 'newest' : 'oldest'} className="mt-0.5 h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px]">
            <option value="newest">newest first</option>
            <option value="oldest">oldest first</option>
          </select>
        </label>
        <button className="h-8 rounded-lg bg-brand px-4 text-[12px] font-medium text-white hover:bg-brand-dark">Walk</button>
        <p className="basis-full text-[10.5px] text-slate-400">
          The person key is <code className="rounded bg-slate-100 px-1">individual_uid</code>. A uhid resolves only through
          the exact <code className="rounded bg-slate-100 px-1">individuals.kx_uhid</code> bridge — an ambiguous identity is
          refused, never guessed.
        </p>
      </form>

      {!asked ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Enter an <code className="rounded bg-slate-100 px-1">individual_uid</code> (or a uhid) to walk the spine.
        </div>
      ) : !subject?.individualUid ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <b>Not resolved — refused, not guessed.</b>{' '}
          {subject?.reason === 'uhid_unresolved'
            ? 'That uhid matched no individual on the kx_uhid bridge. No walk was run.'
            : 'That input is not a well-formed individual_uid. No walk was run.'}
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="font-mono text-[12px] text-slate-500">{walk!.individualUid}</div>
            <FlagStrip flags={walk!.flags} />
          </div>

          {/* Enumeration honesty: an outage during enumeration must never render as "no history". */}
          {walk!.enumeration.status === 'context_fetch_failed' ? (
            <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">
              <b>Evidence enumeration failed.</b> db13 could not be read, so we do <b>not</b> know which days this member has
              evidence on. This is <b>not</b> an empty history — no conclusion can be drawn from this screen.
            </div>
          ) : walk!.cuts.length === 0 ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              We looked, and this member has <b>no OPD or lab evidence</b> — so there is no day to cut at. This is knowledge,
              not an outage.
            </div>
          ) : (
            <>
              <p className="mt-3 text-[11.5px] text-slate-400">
                {walk!.cuts.length} cut{walk!.cuts.length === 1 ? '' : 's'} · {newestFirst ? 'newest first' : 'oldest first'} ·
                {' '}{walk!.cuts.filter((c) => c.status === 'ok').length} ok ·
                {' '}{walk!.cuts.filter((c) => c.status === 'no_prior_history').length} no prior history ·
                {' '}{walk!.cuts.filter((c) => c.status === 'context_fetch_failed').length} fetch failed
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {cuts.map((cut) => <CutCard key={cut.date} cut={cut} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
