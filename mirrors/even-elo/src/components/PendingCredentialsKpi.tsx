"use client";

import { useEffect, useState } from "react";

/**
 * Home "Pending credentials" KPI — client-driven so it never goes stale against
 * the live PendingVerificationsCard. It (a) fetches the live count on mount (so a
 * fresh load reflects reality even if the server-rendered count drifted), and
 * (b) listens for the card's "epi:pending-count" broadcasts (emitted on load and
 * after each inline verify) so the number updates instantly without a reload.
 */
export default function PendingCredentialsKpi({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/qualifications/pending")
      .then((r) => r.json())
      .then((j) => { if (alive && j.ok) setCount(((j.rows ?? []) as unknown[]).length); })
      .catch(() => undefined);
    const onCount = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d && typeof d.count === "number") setCount(d.count);
    };
    window.addEventListener("epi:pending-count", onCount as EventListener);
    return () => { alive = false; window.removeEventListener("epi:pending-count", onCount as EventListener); };
  }, []);

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Pending credentials</div>
      <div className="text-3xl font-semibold num mt-1.5">{count}</div>
      <div className="text-[11px] text-stone-500 mt-0.5">{count > 0 ? <span className="text-amber-800 font-medium">awaiting verification</span> : "all verified · network"}</div>
    </div>
  );
}
