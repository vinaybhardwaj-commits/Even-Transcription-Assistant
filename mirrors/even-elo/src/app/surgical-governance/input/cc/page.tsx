"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaseTable } from "@/components/CaseTable";
import { StreamConfig } from "@/components/EditableCell";

/**
 * Customer Care owns 4 streams (PRD §5):
 *   - nps_discharge (Outcomes, numeric 0–10, excluded, higher_better, floor 6 / target 9)
 *   - nps_day7 (Outcomes, numeric 0–10, excluded, higher_better, floor 6 / target 9)
 *   - complaint_raised (Outcomes, binary, no_event, lower_better)
 *   - family_comm_done (Outcomes, binary, unknown, higher_better)
 *
 * Display order matches mockup screen #3 (CC variant).
 */
const STREAM_IDS = [
  "nps_discharge",
  "nps_day7",
  "complaint_raised",
  "family_comm_done",
];

export default function CustomerCareInputPage() {
  const [streams, setStreams] = useState<StreamConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/streams?team=CC")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) {
          setError(j.error ?? "Failed to load streams");
          return;
        }
        const byId = new Map((j.streams as StreamConfig[]).map((s) => [s.id, s]));
        const ordered = STREAM_IDS.map((id) => byId.get(id)).filter(Boolean) as StreamConfig[];
        setStreams(ordered);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2">
              <Link href="/surgical-governance/input/cases" className="hover:text-stone-900">
                Input forms
              </Link>
              <span>/</span>
              <span className="text-stone-900 font-medium">Customer Care</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">
              NPS, complaints &amp; family communication
            </h1>
            <p className="text-sm text-stone-500 mt-1">
              4 streams · NPS at discharge (0–10), NPS Day-7 (0–10), complaint raised,
              family communication completed. NPS floor 6 = score 0, target 9 = score 100.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
            {error}
          </div>
        )}

        {streams.length > 0 && (
          <CaseTable streams={streams} expectedTeam="CC" expectedTeamLabel="Customer Care" />
        )}
      </main>
    </>
  );
}
