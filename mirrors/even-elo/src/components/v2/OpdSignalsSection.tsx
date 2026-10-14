"use client";

import { useEffect, useState } from "react";

/**
 * Physician profile "Signals" section (PRD v1.4 §6.5). Reads the per-doctor
 * appearance history reconstructed from EPI's snapshot store (partial — top-5
 * cap per signal/day). The CDMSS per-doctor endpoint has shipped and backs the
 * portal's Findings panel; it answers a different question and does not replace
 * this section's cohort-appearance view.
 * Advisory framing is contractual: supportive, non-punitive; small-n caveat.
 */

interface Appearance {
  day: string;
  signal: string;
  label: string;
  severity: string;
  doctor_value: number | null;
  n: number;
  cohort_value: number | null;
  unit: string;
}
interface Iv {
  signal_label: string | null;
  kind: string;
  note: string | null;
  done_on: string;
  actor_email: string | null;
}

export function OpdSignalsSection({ physicianId }: { physicianId: string }) {
  const [data, setData] = useState<{
    mapped: boolean;
    appearances: Appearance[];
    interventions: Iv[];
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`/api/physicians/${physicianId}/opd-signals`)
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [physicianId]);

  if (failed) return null;

  return (
    <section className="bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          OPD signals{" "}
          <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">
            {data?.appearances.length ?? "…"}
          </span>
        </h2>
        <a href="/opd-governance" className="text-[12px] text-brand font-medium">OPD Governance →</a>
      </div>
      {!data ? (
        <div className="px-5 py-6 text-center text-sm text-stone-400">Loading…</div>
      ) : !data.mapped ? (
        <div className="px-5 py-6 text-center text-sm text-stone-400">
          Not yet linked to the OPD audit (no CDMSS mapping). Run the doctor mapping from OPD Governance.
        </div>
      ) : data.appearances.length === 0 ? (
        <div className="px-5 py-6 text-center text-sm text-stone-500">
          Not named in any OPD governance signal in the last 90 days. ✓
        </div>
      ) : (
        <div className="px-5 py-4">
          <p className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[11.5px] leading-snug text-sky-900">
            Advisory documentation-process signals for supportive, non-punitive follow-up — not a
            performance score. Small per-doctor samples; interpret with care.
          </p>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wide text-stone-400 border-b border-stone-200">
                <th className="py-1.5 pr-3">Day</th>
                <th className="py-1.5 pr-3">Signal</th>
                <th className="py-1.5 pr-3">This doctor</th>
                <th className="py-1.5">Cohort</th>
              </tr>
            </thead>
            <tbody>
              {data.appearances.slice(0, 12).map((a, i) => (
                <tr key={i} className="border-b border-stone-50">
                  <td className="py-1.5 pr-3 text-stone-500">{a.day}</td>
                  <td className="py-1.5 pr-3 font-medium">
                    {a.label}{" "}
                    <span className={"ml-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase " + (a.severity === "act_now" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700")}>
                      {a.severity === "act_now" ? "act now" : "watch"}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 font-semibold">
                    {a.doctor_value ?? "—"}
                    <span className="text-stone-400 font-normal"> {a.unit} · n {a.n}</span>
                  </td>
                  <td className="py-1.5 text-stone-500">{a.cohort_value ?? "—"} {a.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.interventions.length > 0 && (
            <div className="mt-3 border-t border-stone-100 pt-2.5">
              <div className="text-[10.5px] uppercase tracking-wide text-stone-400 mb-1.5">Linked interventions</div>
              {data.interventions.slice(0, 5).map((iv, i) => (
                <div key={i} className="text-[12px] text-stone-600">
                  ◆ {iv.done_on} · {iv.kind.replace(/_/g, " ")}{iv.signal_label ? ` · ${iv.signal_label}` : ""}
                  {iv.note ? <span className="text-stone-400"> — {iv.note}</span> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
