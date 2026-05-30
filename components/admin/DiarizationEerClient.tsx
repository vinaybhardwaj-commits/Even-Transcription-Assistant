"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

type Item = {
  encounter_id: string;
  patient: string | null;
  recorded_at: string;
  speaker_idx: number | null;
  name: string | null;
  confidence: number | null;
  label: "correct" | "incorrect" | null;
};
type Stats = {
  total_diarized: number;
  clinician_matched: number;
  avg_confidence: number | null;
  min_confidence: number | null;
  labeled_correct: number;
  labeled_incorrect: number;
  eer: number | null;
  eer_threshold: number | null;
  labels_needed: number;
};

export function DiarizationEerClient() {
  const [items, setItems] = React.useState<Item[]>([]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/diarization-eer", { cache: "no-store" });
      const j = await r.json();
      setItems(j.items ?? []);
      setStats(j.stats ?? null);
    } finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const label = React.useCallback(async (encounter_id: string, speaker_idx: number, is_correct: boolean) => {
    setBusy(`${encounter_id}:${speaker_idx}`);
    try {
      await fetch("/api/admin/diarization-eer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encounter_id, speaker_idx, is_correct }),
      });
      await load();
    } finally { setBusy(null); }
  }, [load]);

  return (
    <div className="space-y-5">
      <p className="text-caption text-even-ink-500">
        Speaker-identification accuracy. Label each clinician auto-match as correct or wrong to build ground truth; EER is computed once there are enough labels of each kind, to validate/tune the 0.70 batch / 0.78 live thresholds.
      </p>

      {stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            ["Diarized encounters", String(stats.total_diarized)],
            ["Clinician auto-matched", String(stats.clinician_matched)],
            ["Avg match confidence", stats.avg_confidence != null ? `${(stats.avg_confidence * 100).toFixed(1)}%` : "—"],
            ["Labeled (✓/✗)", `${stats.labeled_correct} / ${stats.labeled_incorrect}`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-even-ink-100 bg-even-white p-3">
              <p className="text-caption text-even-ink-500">{k}</p>
              <p className="text-heading text-even-navy-800">{v}</p>
            </div>
          ))}
          <div className="rounded-xl border border-even-blue-200 bg-even-blue-50 p-3 col-span-2 md:col-span-4">
            <p className="text-caption text-even-ink-500">Equal Error Rate (EER)</p>
            {stats.eer != null ? (
              <p className="text-heading text-even-navy-800">{(stats.eer * 100).toFixed(1)}% <span className="text-caption text-even-ink-500">at threshold {(stats.eer_threshold ?? 0).toFixed(3)}</span></p>
            ) : (
              <p className="text-body text-even-ink-500">Not enough labels yet — need ~{stats.labels_needed} more (≥3 correct and ≥3 incorrect).</p>
            )}
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="text-body text-even-ink-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-body text-even-ink-400">No encounters with a clinician auto-match yet. They appear here once an enrolled clinician records and diarization identifies them.</p>
      ) : (
        <div className="rounded-xl border border-even-ink-100 bg-even-white divide-y divide-even-ink-50">
          {items.map((it) => (
            <div key={it.encounter_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link href={`/admin/encounters/${it.encounter_id}`} className="text-label text-even-blue-600 hover:underline">{it.patient || it.encounter_id}</Link>
              <span className="text-caption text-even-ink-400">{it.recorded_at.slice(0, 16)}</span>
              <span className="text-caption text-even-ink-600">{it.name}</span>
              {it.confidence != null ? <span className="text-caption text-even-ink-500">{(it.confidence * 100).toFixed(0)}%</span> : null}
              <span className="ml-auto flex items-center gap-2">
                {it.label ? (
                  <span className={`text-caption rounded-full px-2 py-0.5 ${it.label === "correct" ? "bg-success-100 text-success-700" : "bg-danger-100 text-danger-700"}`}>{it.label}</span>
                ) : null}
                <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => it.speaker_idx != null && void label(it.encounter_id, it.speaker_idx, true)}>✓ Correct</Button>
                <Button variant="secondary" size="sm" disabled={busy != null} onClick={() => it.speaker_idx != null && void label(it.encounter_id, it.speaker_idx, false)}>✗ Wrong</Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
