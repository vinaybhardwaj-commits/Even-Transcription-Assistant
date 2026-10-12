import * as React from "react";
import type { EncIsolation } from "@/lib/enc/queries";
import { BOUNDARY_COLOR } from "@/lib/enc/view";

/**
 * ENC sections, rendered per consult on /admin/rooms/[roomId]/[date]#consult-<uid> (contract UI item 3): Isolation, Parts, Rx check.
 * Each section renders nothing when its data is absent; with no isolation row at all the component renders nothing.
 * Ids, times, counts and flags only. The audio player and transcript stay in EncounterDetailAdminClient.
 */
const card = "bg-even-white rounded-xl border border-even-ink-200 p-4";
const h = "text-label font-semibold text-even-navy-800 mb-2";
const k = "text-even-ink-500";

function fmtIst(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 5.5 * 3600_000).toISOString().slice(11, 19);
}
function fmtSec(s: number): string {
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

export function EncIsolationSections({ iso }: { iso: EncIsolation | null }) {
  if (!iso) return null;
  const lanes = Object.entries(iso.lanes);
  const parts = iso.parts && iso.parts.length > 0 ? iso.parts : null;
  return (
    <div className="space-y-4 mb-4" data-testid="enc-sections">
      <section className={card} aria-label="Isolation">
        <p className={h}>Isolation</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
          <dt className={k}>Boundary source</dt>
          <dd className="text-even-navy-800">{BOUNDARY_COLOR[iso.boundary_source]?.label ?? iso.boundary_source}</dd>
          <dt className={k}>Edges (IST)</dt>
          <dd className="text-even-navy-800">{fmtIst(iso.t_start)} to {fmtIst(iso.t_end)}</dd>
          <dt className={k}>Confidence</dt>
          <dd className="text-even-navy-800">{iso.confidence !== null ? `${Math.round(iso.confidence * 100)}%` : "-"}</dd>
          <dt className={k}>Room source</dt>
          <dd className="text-even-navy-800">{iso.room_source ?? "-"}</dd>
          <dt className={k}>Status</dt>
          <dd className="text-even-navy-800">{iso.status}{iso.skip_reason ? ` (${iso.skip_reason})` : ""}</dd>
          {lanes.length > 0 ? (
            <>
              <dt className={k}>Lanes</dt>
              <dd className="flex flex-wrap gap-1.5">
                {lanes.map(([name, on]) => (
                  <span
                    key={name}
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${on ? "bg-green-50 text-green-700 border-green-200" : "bg-even-ink-100 text-even-navy-800/70 border-even-ink-200"}`}
                  >
                    {name} {on ? "done" : "not run"}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {parts ? (
        <section className={card} aria-label="Parts">
          <p className={h}>Parts</p>
          <div className="overflow-x-auto">
            <table className="w-full text-caption min-w-[320px]">
              <thead className="text-left text-even-navy-800/60">
                <tr>
                  <th className="py-1 pr-3 font-medium">Part</th>
                  <th className="py-1 pr-3 font-medium">From</th>
                  <th className="py-1 pr-3 font-medium">To</th>
                  <th className="py-1 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={`${p.part}-${i}`} className="border-t border-even-ink-100">
                    <td className="py-1 pr-3 text-even-navy-800">{p.part}</td>
                    <td className="py-1 pr-3">{fmtSec(p.t0)}</td>
                    <td className="py-1 pr-3">{fmtSec(p.t1)}</td>
                    <td className="py-1">{p.score !== null && p.score !== undefined ? p.score.toFixed(2) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {iso.rx ? (
        <section className={card} aria-label="Rx check">
          <p className={h}>Rx check</p>
          <p className="text-caption">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${iso.rx.matched ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200"}`}
            >
              {iso.rx.matched ? "matched" : "not matched"}
            </span>
            {iso.rx.rx_ref ? <span className="ml-2 text-even-ink-500">ref {iso.rx.rx_ref}</span> : null}
          </p>
          {iso.rx.mismatch && iso.rx.mismatch.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Mismatch codes">
              {iso.rx.mismatch.map((c) => (
                <li key={c} className="text-[11px] px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">{c}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
