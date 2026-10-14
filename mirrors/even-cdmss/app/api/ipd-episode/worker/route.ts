export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * 800 s, matching app/api/ipd-audit/worker/route.ts. THE ARITHMETIC BELOW IS MEASURED, NOT
 * ESTIMATED, and it replaces a set of guesses that were wrong in the dangerous direction.
 *
 * ⚠️ WHAT THE OLD COMMENT SAID, AND WHAT IT COST. It claimed "~520 s worst case per episode" from
 * an invented ~25 s per checkpoint. On 2026-09-03 IPNO-416 (LOS 3, 5 checkpoints, 269 billing
 * rows, 17 labs) hit FUNCTION_INVOCATION_TIMEOUT at the 800 s cap and left NO audit row and NO
 * skip row — the episode vanished. The stale number had silently capped which episodes this engine
 * could audit, and nothing re-derived it when round 8 raised max_tokens from 3000 to 8000, which
 * made every checkpoint response longer and therefore slower to generate.
 *
 * MEASURED, same deployment, same day:
 *
 *   IP-1313   LOS 0   2 checkpoints    ~60 billing rows    156 s   completed
 *   IP-1286   LOS 2   4 checkpoints   ~204 billing rows    227 s   completed
 *   IPNO-416  LOS 3   5 checkpoints   ~269 billing rows   >800 s   TIMED OUT
 *
 * One extra checkpoint cannot cost 3.5×, so the driver is EVENT VOLUME, not checkpoint count:
 * every checkpoint re-rendered the entire order stream, making the prompt cost O(checkpoints ×
 * events) — quadratic in an episode's size.
 *
 * TWO CHANGES ADDRESS IT, and the ceiling must be re-derived after either one moves:
 *   · checkpoints now run 3 AT A TIME (they are independent by construction), so checkpoint wall
 *     time is roughly ceil(n/3) × the slowest one rather than the sum;
 *   · the PROMPTS read a rolled-up order stream — pharmacy and consumable lines collapse to one
 *     line per day — so per-checkpoint prompt size stops scaling with billing volume. real_course
 *     and the resolver still see every event.
 *
 * THE CEILING, STATED IN THE UNITS THAT ACTUALLY BIND:
 *   · checkpoints: 8 is the maximum the plan can produce, but NOT as "7 daily + 1 episode".
 *     Decision 43 replaced the calendar plan with event anchors — the first 24 hours, each
 *     procedure day and its follow-ups, the pre-discharge window, and the episode — so the count
 *     now varies with what happened rather than with length of stay, and a long admission can
 *     produce fewer checkpoints than a short one with more surgery. MAX_CHECKPOINTS caps it at 8.
 *     At 3-way concurrency that is 3 waves.
 *   · events: the prompt-side count, not the assembled count. `prompt_events` and
 *     `assembled_events` are both recorded on every audit row; if prompt_events climbs back above
 *     ~150 for a large episode, this arithmetic needs redoing before the next cohort run.
 *   · the three judge passes remain STRICTLY SEQUENTIAL and are not bounded by any of this.
 *
 * ⚠️ AND A TIMEOUT IS NO LONGER SILENT. An `in_progress` skip row is written before the model work
 * starts and survives the invocation dying, so an episode that vanished mid-flight is visible in
 * the data and retryable once the marker goes stale.
 *
 * ⚠️ maxDuration, max, the concurrency and the leg count are coupled. Changing any one without
 * redoing the measurements above is how this route ended up in a box it could not fit.
 */
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings, setSetting } from '@/lib/mini-backfill';
import { fetchClosedEpisodes, isEncounterId } from '@/lib/ipd-episode/db13';
import {
  IPD_EPISODE_ENGINE_VERSION, IPD_EPISODE_ENGINE_VERSION_PRIOR, auditedAtByEncounter,
  auditedEncounterIds, skipIsRetryable, skipRows, inProgressIsStale,
} from '@/lib/ipd-episode/store';
import { runEpisodeAudit, runEpisodeBatch, MAX_CANDIDATES_EXAMINED } from '@/lib/ipd-episode/run';

/**
 * The soft lock. `app_settings` key `ipd_episode_lock`, written at the start of a tick and released
 * in `finally`, so the TTL only decides what happens when a tick DIES without releasing.
 *
 * ⚠️ ITS OWN TTL, AND THE ARITHMETIC IS THE WHOLE REASON. The IPD module's shared helper
 * (lib/mini-backfill's `lockHeld` / MB_LOCK_TTL_MS) uses 210 s, sized for a tick that audits two
 * OPD notes inside a 300 s function cap. THIS route's box is 800 s and one episode can legitimately
 * run past 400 s (and IPNO-416 ran past 800) — so a shared 210 s TTL declared a perfectly healthy
 * tick dead at the four-minute mark
 * and let a second tick start beside it. Two ticks each holding three Opus calls is exactly the
 * request storm the IPD discharge worker's header documents at length.
 *
 * 780 s sits just under the 800 s box: long enough that no tick which is still inside its own
 * invocation is ever called stale, short enough that a crashed tick's lock clears before the next
 * cadence rather than wedging the worker until someone clears the key by hand.
 *
 * The lock is advisory, not a queue. If it ever were bypassed, the (encounter_id, engine_version)
 * unique index still makes a duplicate audit an UPSERT of the same row — never a second one.
 */
const LOCK_KEY = 'ipd_episode_lock';

/** 780 s. Coupled to `maxDuration` above: raise the box and this must move with it, in the same
 *  commit — a TTL shorter than the work it guards is the defect this constant exists to fix.
 *  Module-local, not exported: Next.js allows a route file to export only its handlers and route
 *  config, so the contract test reads this file as source (the idiom this build already uses for
 *  the PHI and no-id-rewriting assertions). */
const IPD_EPISODE_LOCK_TTL_MS = 780 * 1000;

/**
 * ROUND 13 ITEM 1 — THE BOX, AS A WALL-CLOCK DEADLINE THE MODEL CALLS CAN READ.
 *
 * `maxDuration` above is the only place that knows how long this invocation may live, and until
 * now nothing downstream could see it. IP-1483 spent 763 s inside an 800 s box on three diff
 * attempts that could not all fit, and the function was killed with no audit row and no skip row.
 *
 * The deadline is `maxDuration` minus a reserve, and the reserve is what the work AFTER the last
 * model call still needs: persisting the audit row and its checkpoint rows, writing the response,
 * and releasing the lock in `finally`. 40 s is generous for three Neon statements — deliberately
 * so, because the cost of overshooting the reserve is the failure this exists to prevent, while
 * the cost of overshooting it is one refused call.
 *
 * DERIVED FROM `maxDuration`, never restated: the two move together or the guard is a lie.
 *
 * Module-local, not exported — Next.js allows a route file to export only its handlers and route
 * config, so the contract test reads this file as source, exactly as it does for `lockHeld`.
 */
const PERSIST_RESERVE_MS = 40 * 1000;
function invocationDeadlineAt(startedAt: number, maxDurationSeconds: number = maxDuration): number {
  return startedAt + maxDurationSeconds * 1000 - PERSIST_RESERVE_MS;
}

/** True when a lock fresher than the TTL exists — i.e. another tick is still running. Local, not
 *  the 210 s shared helper: see the note above. */
function lockHeld(lockTs: string | null, now: Date = new Date(), ttlMs: number = IPD_EPISODE_LOCK_TTL_MS): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < ttlMs;
}

/** Execution guard (this route spends LLM compute): Vercel Cron, Bearer/query CRON_SECRET, or a
 *  logged-in admin session. Byte-identical in shape to the IPD discharge worker's. */
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/**
 * The candidate QUEUE. "Un-audited" is decided by the audit
 * TABLE, not by a cursor — the table is the watermark, so a missed tick self-heals and a caught-up
 * run is a cheap no-op. A skip row past its 14-day retry window is excluded here rather than
 * attempted and re-skipped.
 *
 * ⚠️ NOT TRUNCATED TO `max`. It used to be, and that was the bug: a batch of two candidates that
 * both failed selection audited nothing and reported a full tick. The queue is now handed whole to
 * `runEpisodeBatch`, which stops when `max` episodes have actually reached the model stages —
 * or when it has examined `MAX_CANDIDATES_EXAMINED` of them, so a cohort where nothing qualifies
 * cannot make a tick walk the entire list.
 *
 * The db13 query already drops episodes with no progress note (§3.1 condition 2), so the queue is
 * mostly real candidates before this filter runs at all.
 */
async function candidateQueue(): Promise<{ encounterId: string; dischargedAt: string | null }[]> {
  const [closed, audited, skips, priorAudits] = await Promise.all([
    fetchClosedEpisodes(2000),
    auditedEncounterIds(),
    skipRows(),
    auditedAtByEncounter(IPD_EPISODE_ENGINE_VERSION_PRIOR),
  ]);
  const done = new Set(audited);
  const stale = new Set(skips.filter((s) => !skipIsRetryable(s.discharged_at)).map((s) => s.encounter_id));
  // An episode marked in_progress is either RUNNING RIGHT NOW in another invocation or was killed
  // by one. Skip it until the marker is stale; then it is a dead invocation and worth retrying.
  const running = new Set(
    skips.filter((s) => s.reason === 'in_progress' && !inProgressIsStale(s.last_seen)).map((s) => s.encounter_id),
  );
  const out: { encounterId: string; dischargedAt: string | null }[] = [];
  for (const c of closed) {
    if (done.has(c.encounterId) || stale.has(c.encounterId) || running.has(c.encounterId)) continue;
    out.push({ encounterId: c.encounterId, dischargedAt: c.dischargeDateTime });
  }

  // ⚠️ DECISION 56 — THE ALREADY-READ COHORT COMES FIRST, OLDEST READING FIRST. The version bump
  // makes every 0.1 row non-current at 0.2, so all twenty-eight episodes V has read requalify. They
  // are re-audited BEFORE anything new, in the order they were originally read, so the cohort under
  // discussion is the first thing to come back comparable — including the seven rows still carrying
  // the withdrawn `d-1`, which is how those get corrected without a hand-run.
  //
  // Everything else follows by discharge date DESCENDING: newest admissions first, which is the
  // opposite of §3.1's original ascending sweep and deliberate — an audit of last week is worth more
  // to a reader than an audit of last year, and the backlog is now large enough that the order
  // decides what actually gets read.
  return out.sort((a, b) => {
    const pa = priorAudits[a.encounterId];
    const pb = priorAudits[b.encounterId];
    if (pa && pb) return pa.localeCompare(pb);          // both read at 0.1 — oldest reading first
    if (pa) return -1;                                   // read at 0.1 outranks never read
    if (pb) return 1;
    return String(b.dischargedAt ?? '').localeCompare(String(a.dischargedAt ?? ''));
  });
}

/**
 * DECISION 53 (V, 2026-09-05) — THE NIGHTLY CRON, AND THE ONE THING THAT STOPS IT.
 *
 * `?auto=1` is the cron's entry point and the ONLY caller that is flag-gated. A manual
 * `?encounter=` spot check still runs with the flag off, because that is an orchestrator reading a
 * named episode on purpose; an unattended sweep is not. So the guard is on `auto`, not on the route.
 *
 * ⚠️ IT RETURNS 200, NOT 403, AND IT RETURNS BEFORE THE LOCK. A cron firing 49 times a night into a
 * disabled engine must be free and must not look like a failure in the Vercel log — a 4xx every ten
 * minutes is an alert nobody can act on. It also must not take the lock or read db13, or a disabled
 * engine would still cost a query per tick and could block a manual run.
 *
 * ⚠️ THE FLAG IS NO LONGER WHAT DECIDES THIS (decision 48). The gate reading decided it. The flag is
 * the switch that carries the decision, and this guard is where the switch is read.
 *
 * IDEMPOTENCE IS INHERITED, NOT ADDED. `candidateQueue` excludes every encounter that already has a
 * row at THIS engine version, so a second call for an audited episode selects a different one or
 * reports `caughtUp`. Nothing here retries a lost HTTP response: Step C's IPNO-531 returned an empty
 * body after its row was written, and a retry on that shape would re-audit an episode that had
 * already succeeded. The row is the record; the response is not.
 */
const AUTO_MAX = 1;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const auto = p.get('auto') === '1';
  if (auto && process.env.IPD_EPISODE_AUDIT_ENABLED !== '1') {
    return NextResponse.json({ ok: true, mode: 'auto', disabled: true, engine: IPD_EPISODE_ENGINE_VERSION });
  }
  const deadlineAt = invocationDeadlineAt(startedAt);
  // ONE episode per cron call. The window fires every ten minutes and an episode can run past six
  // minutes, so a tick that audited two could still be inside the box when the next one starts —
  // the lock would hold it off, but the night's throughput would come from the lock's TTL rather
  // than from a number anyone chose.
  const max = auto ? AUTO_MAX : Math.max(1, Math.min(5, Number(p.get('max') || 2)));
  const one = p.get('encounter');

  // The lock is checked BEFORE any db13 read: a held lock must cost nothing.
  const settings = await getSettings([LOCK_KEY]).catch(() => ({} as Record<string, string>));
  if (lockHeld(settings[LOCK_KEY] || null)) {
    return NextResponse.json({ ok: true, locked: true, engine: IPD_EPISODE_ENGINE_VERSION });
  }
  await setSetting(LOCK_KEY, new Date().toISOString()).catch(() => {});

  try {
    // ?encounter= — run ONE named episode, whatever the sweep would have chosen. Used for the
    // orchestrator's spot checks. The id is shape-checked and never rewritten.
    if (one) {
      if (!isEncounterId(one)) {
        return NextResponse.json({ ok: false, error: 'bad encounter id' }, { status: 400 });
      }
      const r = await runEpisodeAudit({ encounterId: one, deadlineAt });
      return NextResponse.json({ ok: true, mode: 'encounter', engine: IPD_EPISODE_ENGINE_VERSION, processed: 1, results: [r] });
    }

    const queue = await candidateQueue();
    if (!queue.length) {
      return NextResponse.json({
        ok: true, mode: auto ? 'auto' : 'sweep', engine: IPD_EPISODE_ENGINE_VERSION, caughtUp: true,
        queueLength: 0, candidatesExamined: 0, audited: 0, skipped: 0,
        skippedByReason: {}, errors: 0, processed: 0, results: [],
      });
    }

    // SEQUENTIAL, deliberately (see the box arithmetic above). No concurrency knob exists.
    // A selection skip costs one db13 read and does NOT consume a slot — `max` bounds model spend,
    // which is the only thing the box is short of.
    // The SAME deadline for every episode in the tick, not a per-episode share of it: an episode
    // that finishes early leaves its unspent time to the next one, and an episode that cannot fit
    // in what remains is refused at its first model call rather than half-run.
    const { results, tally } = await runEpisodeBatch(
      queue, max, (i) => runEpisodeAudit({ ...i, deadlineAt }),
    );

    return NextResponse.json({
      ok: true,
      mode: auto ? 'auto' : 'sweep',
      engine: IPD_EPISODE_ENGINE_VERSION,
      // What this tick actually did, per §5 of the review: how many candidates were looked at, how
      // many were audited, how many were skipped and for exactly which reason, how many errored.
      queueLength: queue.length,
      candidatesExamined: tally.candidatesExamined,
      audited: tally.audited,
      skipped: tally.skipped,
      skippedByReason: tally.skippedByReason,
      errors: tally.errors,
      // `capReached` says a tick stopped on MAX_CANDIDATES_EXAMINED rather than on `max` — i.e. it
      // walked 50 candidates without filling the batch, which means the queue is mostly unqualified
      // and is worth knowing rather than inferring from a low audited count.
      examineCap: MAX_CANDIDATES_EXAMINED,
      capReached: tally.capReached,
      caughtUp: tally.exhausted && tally.audited === 0,
      processed: results.length,
      results,
    });
  } catch (e) {
    // Even the top-level catch answers 200: this route is triggered by hand and by cron, and a
    // 500 tells a caller nothing a recorded error does not (§8: no path returns a 500).
    return NextResponse.json({ ok: false, engine: IPD_EPISODE_ENGINE_VERSION, error: String((e as Error).message) });
  } finally {
    await setSetting(LOCK_KEY, '').catch(() => {});
  }
}
