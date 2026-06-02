"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { submitRecoveredEncounter } from "@/lib/submit-from-store";
import {
  listEncounterSummaries,
  purgeEncounter,
  type EncounterSummary,
} from "@/lib/chunk-store";

/**
 * Surfaces abandoned recordings on HomeShell mount. An "abandoned"
 * recording is any encounter_id with chunks in IndexedDB whose newest
 * chunk is >30s old (newer ones are probably an active tab).
 *
 * Actions (for now):
 *   - Discard  → purge from IndexedDB, remove from list
 *   - Keep     → no-op (Submit-from-recovered-chunks lands in 1.F.7)
 *
 * Per PRD §4.18 (dropout tolerance) the eventual full flow is:
 *   crash → reload → recovery modal → "Submit anyway" → uploads
 *   accumulated chunks to R2 → triggers pipeline on the partial audio.
 */

const STALE_MS = 30_000; // 30s — protect against tripping on a sibling tab
const POLL_MS = 60_000;  // re-check every minute in case user keeps tab open

type Props = { slug: string; className?: string };

export function RecoveryModal({ slug, className = "" }: Props) {
  const [items, setItems] = React.useState<EncounterSummary[]>([]);
  const [dismissed, setDismissed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submittingId, setSubmittingId] = React.useState<string | null>(null);
  const router = useRouter();

  const refresh = React.useCallback(async () => {
    try {
      const all = await listEncounterSummaries();
      const now = Date.now();
      setItems(all.filter((s) => now - s.last_ts > STALE_MS));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const onDiscard = React.useCallback(
    async (encounter_id: string) => {
      try {
        await purgeEncounter(encounter_id);
        setItems((prev) => prev.filter((s) => s.encounter_id !== encounter_id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const onSubmitRecovered = React.useCallback(
    async (s: EncounterSummary) => {
      setSubmittingId(s.encounter_id);
      setError(null);
      const span = Math.round((s.last_ts - s.first_ts) / 1000);
      const durationSeconds = Math.max(1, span > 0 ? span : Math.round(s.chunk_count * 0.25));
      const r = await submitRecoveredEncounter({ slug, encounterId: s.encounter_id, durationSeconds });
      if (r.ok) {
        setItems((prev) => prev.filter((x) => x.encounter_id !== s.encounter_id));
        router.push(`/${slug}/encounter/${r.encounterId}`);
      } else {
        setError(`Couldn't submit ${s.encounter_id.slice(0, 10)}…: ${r.error}`);
        setSubmittingId(null);
      }
    },
    [slug, router],
  );

  if (dismissed) return null;
  if (items.length === 0 && !error) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Recover unfinished recordings"
      className={`fixed inset-x-0 bottom-0 z-40 px-4 pb-4 sm:px-6 sm:pb-6 ${className}`}
    >
      <div className="mx-auto max-w-md rounded-xl border border-warning-500 bg-warning-100/40 backdrop-blur p-4 shadow-card-hover">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-label text-even-navy-800">
              {items.length === 1
                ? "Unfinished recording found"
                : `${items.length} unfinished recordings`}
            </p>
            <p className="text-caption text-even-ink-500 mt-0.5">
              These were captured locally but never submitted.
            </p>
          </div>
          <button
            type="button"
            aria-label="Hide for now"
            onClick={() => setDismissed(true)}
            className="text-even-ink-400 hover:text-even-ink-700 text-display leading-none"
          >
            ×
          </button>
        </div>

        {error ? (
          <p className="text-caption text-danger-700 mb-3">{error}</p>
        ) : null}

        <ul className="space-y-2 max-h-[40vh] overflow-y-auto">
          {items.map((s) => {
            const ageMin = Math.max(
              1,
              Math.round((Date.now() - s.last_ts) / 60_000),
            );
            const sizeKb = (s.total_bytes / 1024).toFixed(1);
            return (
              <li
                key={s.encounter_id}
                className="flex items-center justify-between rounded-md bg-even-white border border-even-ink-100 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-body text-even-navy-800 truncate">
                    {s.encounter_id.slice(0, 14)}…
                  </p>
                  <p className="text-caption text-even-ink-500">
                    {s.chunk_count} chunks · {sizeKb} KB · {ageMin}m ago
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={submittingId !== null}
                    onClick={() => void onSubmitRecovered(s)}
                    aria-label={`Submit recording ${s.encounter_id}`}
                  >
                    {submittingId === s.encounter_id ? "Submitting…" : "Submit"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={submittingId !== null}
                    onClick={() => void onDiscard(s.encounter_id)}
                    aria-label={`Discard recording ${s.encounter_id}`}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="text-caption text-even-ink-400 mt-3 text-center">
          Submit uploads the recovered audio and generates the note. Discard
          removes it permanently.
        </p>
      </div>
    </div>
  );
}
