/**
 * BenchConsultMarks — read-only "Consult marks" block on the admin bench
 * session page (Ambient Brain Kickoff C, decision C4). Server-rendered under
 * the chunk strip: heading "Consult marks (n)", one row per bench_event of
 * kind 'consult_mark' — HH:MM:SS (IST) + delivery status. No actions.
 *
 * Query: lib/bench listBenchConsultMarks (shared with the timeline.md generator,
 * Kickoff D). Fail-safe: on any query error (e.g. 0043 not applied yet) the
 * block renders nothing.
 * Snapshot at page render — reload to refresh (the chunk strip above polls;
 * this block does not).
 */

import { listBenchConsultMarks, type BenchConsultMarkRow as MarkRow } from "@/lib/bench";

function fmtIstHms(t: string | Date): string {
  return new Date(t).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export async function BenchConsultMarks({ sessionId }: { sessionId: string }) {
  let rows: MarkRow[];
  try {
    rows = await listBenchConsultMarks(sessionId);
  } catch {
    return null;
  }

  return (
    <section className="eta-card p-5 mt-4" data-testid="consult-marks">
      <p className="text-label font-semibold text-even-navy-800 mb-2">
        Consult marks ({rows.length})
      </p>
      {rows.length === 0 ? (
        <p className="text-caption text-even-ink-400">No consult marks</p>
      ) : (
        <ul className="divide-y divide-even-ink-100">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline gap-4 py-1.5 text-body">
              <span className="font-mono tabular-nums text-even-ink-800">{fmtIstHms(r.at)}</span>
              <span
                className={
                  r.brain_status === "sent" ? "text-success-700" : "text-even-ink-500"
                }
              >
                {r.brain_status === "sent" ? "brain cue sent" : "saved locally — brain unreachable"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
