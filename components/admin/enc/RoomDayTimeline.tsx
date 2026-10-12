import * as React from "react";
import Link from "next/link";
import type { EncIsolation, EncRoomDay } from "@/lib/enc/queries";
import { BOUNDARY_COLOR, buildTimeline, topAlert, type TapeSpan } from "@/lib/enc/view";
import { StatusChip } from "@/components/admin/enc/DailyCoverageClient";

/**
 * The ENC timeline strip on /admin/rooms/[roomId]/[date] (contract UI item 2). Pure render from props, no state.
 * Lanes: tape coverage, PQM visits (red = no cut encounter over it), encounters coloured by boundary_source.
 * Red on the tape lane = a span with no recording. Click an encounter to jump to its Isolation / Parts / Rx sections on the same page (#consult-<uid>).
 * Renders nothing when there is no ENC data for the day (before W1 lands, or a room with no export).
 */
export function RoomDayTimeline({ roomId, date, day, isolations, tape }: { roomId: string; date: string; day: EncRoomDay | null; isolations: EncIsolation[]; tape: TapeSpan[] }) {
  if (!day && isolations.length === 0) return null;
  const m = buildTimeline(date, isolations, tape);
  const alert = day ? topAlert(day.alerts) : null;
  const pos = (s: { left: number; width: number }) => ({ left: `${s.left}%`, width: `${s.width}%` });
  const laneCls = "relative h-6 rounded bg-even-ink-100";
  return (
    <section aria-label="Encounter timeline" className="bg-even-white rounded-xl border border-even-ink-200 p-4 mb-4" data-testid="enc-timeline">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <p className="text-label font-semibold text-even-navy-800">Encounters</p>
        {day ? <StatusChip status={day.status} /> : null}
        {day ? (
          <span className="text-caption text-even-ink-500">
            {day.visits} visits - {day.isolated} isolated - {day.not_isolated} not isolated
          </span>
        ) : null}
        {alert ? <span className="text-caption text-red-600">{alert.message}</span> : null}
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[480px] space-y-1.5">
          <div className="relative h-4 ml-16 text-[10px] text-even-ink-500" aria-hidden="true">
            {m.hourTicks.map((t) => (
              <span key={`${t.label}-${t.left}`} className="absolute -translate-x-1/2" style={{ left: `${t.left}%` }}>{t.label}</span>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-even-ink-500">Tape</span>
            <div className={`${laneCls} flex-1`} aria-label="Tape coverage">
              {m.tape.map((s, i) => (
                <span key={`t${i}`} className="absolute inset-y-0 rounded bg-even-blue-200" style={pos(s)} title="recorded" />
              ))}
              {m.tapeGaps.map((s, i) => (
                <span key={`g${i}`} className="absolute inset-y-0 rounded border border-red-400 bg-red-100" style={pos(s)} title="no recording" data-gap="tape" />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-even-ink-500">Visits</span>
            <div className={`${laneCls} flex-1`} aria-label="PQM visits">
              {m.visits.map((v) => (
                <span
                  key={v.id}
                  className={`absolute inset-y-1 rounded ${v.isolated ? "bg-even-navy-800/60" : "bg-red-200 border border-red-500"}`}
                  style={pos(v)}
                  title={v.isolated ? "visit, isolated" : "visit with no isolated encounter"}
                  data-gap={v.isolated ? undefined : "visit"}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-even-ink-500">Cut</span>
            <div className={`${laneCls} flex-1`} aria-label="Isolated encounters">
              {m.encounters.map((e) => (
                <Link
                  key={e.id}
                  href={`/admin/rooms/${roomId}/${date}#consult-${e.id}`}
                  className={`absolute inset-y-0 rounded ${BOUNDARY_COLOR[e.boundary_source].bar} opacity-90 hover:opacity-100 focus:outline focus:outline-2 focus:outline-even-navy-800`}
                  style={pos(e)}
                  title={`${e.label} - show isolation details`}
                  aria-label={`Encounter, boundary ${e.label}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-even-ink-500" aria-label="Legend">
        {(Object.keys(BOUNDARY_COLOR) as Array<keyof typeof BOUNDARY_COLOR>).map((k) => (
          <li key={k} className="inline-flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded ${BOUNDARY_COLOR[k].bar}`} aria-hidden="true" />
            {BOUNDARY_COLOR[k].label}
          </li>
        ))}
        <li className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded border border-red-500 bg-red-100" aria-hidden="true" />gap</li>
      </ul>
      {m.unisolatedVisits > 0 ? (
        <p className="text-caption text-red-600 mt-2">{m.unisolatedVisits} visit(s) have no isolated encounter.</p>
      ) : null}
    </section>
  );
}
