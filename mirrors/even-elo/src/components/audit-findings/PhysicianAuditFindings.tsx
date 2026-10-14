"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FindingsTable } from "@/components/audit-findings/FindingsTable";
import type { BucketCounts, FindingRow } from "@/lib/audit-findings";

/**
 * "Audit findings" section on a physician's profile: this doctor's routed threads from CDMSS, same
 * columns as the worklist, each linking to the thread. Staff only; renders nothing when the viewer
 * has no access (the API answers 401/403).
 */
export function PhysicianAuditFindings({ physicianId }: { physicianId: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "hidden" }
    | { kind: "error"; message: string }
    | { kind: "ok"; mapped: boolean; rows: FindingRow[]; counts: BucketCounts }
  >({ kind: "loading" });

  useEffect(() => {
    let live = true;
    fetch(`/api/physicians/${physicianId}/audit-findings`)
      .then(async (r) => ({ code: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ code, body }) => {
        if (!live) return;
        if (code === 401 || code === 403) setState({ kind: "hidden" });
        else if (body.ok) setState({ kind: "ok", mapped: !!body.mapped, rows: body.rows ?? [], counts: body.counts });
        else setState({ kind: "error", message: body.message ?? "Audit findings could not be loaded." });
      })
      .catch(() => live && setState({ kind: "error", message: "Audit findings could not be loaded." }));
    return () => {
      live = false;
    };
  }, [physicianId]);

  if (state.kind === "hidden") return null;

  return (
    <section className="rounded-xl border border-stone-200 bg-white">
      <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
        <h2 className="text-sm font-semibold">
          Audit findings{" "}
          <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">
            {state.kind === "ok" ? state.rows.length : "…"}
          </span>
          {state.kind === "ok" && state.counts.attention > 0 ? (
            <span className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
              {state.counts.attention} need attention
            </span>
          ) : null}
        </h2>
        <Link href="/audit-findings" className="text-[12px] font-medium text-brand">Audit findings →</Link>
      </div>
      <div className="px-5 py-4">
        {state.kind === "loading" ? (
          <div className="py-4 text-center text-sm text-stone-400">Loading…</div>
        ) : state.kind === "error" ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">{state.message}</div>
        ) : !state.mapped ? (
          <div className="py-4 text-center text-sm text-stone-400">
            Not linked to a CDMSS doctor yet, so no routed findings can be shown.{" "}
            <Link href="/audit-findings/mapping" className="font-medium text-brand hover:underline">Doctor mapping review</Link>
          </div>
        ) : state.rows.length === 0 ? (
          <div className="py-4 text-center text-sm text-stone-500">No findings have been routed to this doctor.</div>
        ) : (
          <FindingsTable rows={state.rows} showDoctor={false} />
        )}
      </div>
    </section>
  );
}
