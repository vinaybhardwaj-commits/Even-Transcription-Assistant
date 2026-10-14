"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaseTable } from "@/components/CaseTable";
import { StreamConfig } from "@/components/EditableCell";

/**
 * OT Coordinator owns 4 streams (PRD §5):
 *   - ot_on_time (Adherence)
 *   - ot_equipment_protocol (Adherence)
 *   - ot_overrun_minutes (Adherence numeric)
 *   - unplanned_return_ot (Outcomes binary)
 *
 * Display order matches mockup screen #3.
 */
const STREAM_IDS = [
  "ot_on_time",
  "ot_equipment_protocol",
  "ot_overrun_minutes",
  "unplanned_return_ot",
];

export default function OTInputPage() {
  const [streams, setStreams] = useState<StreamConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/streams?team=OT")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) {
          setError(j.error ?? "Failed to load streams");
          return;
        }
        // Order by STREAM_IDS list, not alphabetical.
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
              <span className="text-stone-900 font-medium">OT discipline + return-to-OT</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">OT Coordinator entry</h1>
            <p className="text-sm text-stone-500 mt-1">
              4 streams · on-time arrival, equipment per protocol, minutes overrun, unplanned
              return to OT. Cell save fires recompute.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
            {error}
          </div>
        )}

        {streams.length > 0 && (
          <CaseTable streams={streams} expectedTeam="OT" expectedTeamLabel="OT" />
        )}
      </main>
    </>
  );
}
