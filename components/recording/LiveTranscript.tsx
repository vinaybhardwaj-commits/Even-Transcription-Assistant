"use client";

import * as React from "react";

/**
 * LiveTranscript — renders accumulated final utterances + the currently
 * in-flight interim utterance. Finals are dark + solid; interim is
 * lighter gray + italic so the doctor can see what's not yet committed.
 *
 * Auto-scrolls to bottom as new content arrives.
 */
export function LiveTranscript({
  finals,
  interim,
  empty,
  cleanedById,
}: {
  finals: { id: string; text: string }[];
  interim: string;
  empty?: string;
  /**
   * Optional map of utterance_id → cleaned text (post-llama3.1:8b).
   * When present, the cleaned version is shown instead of the raw one.
   * Raw is the fallback while cleanup is still in flight.
   */
  cleanedById?: Record<string, string>;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finals, interim]);

  if (finals.length === 0 && !interim) {
    return (
      <div className="rounded-md border border-dashed border-even-ink-200 bg-even-ink-50/30 p-6 text-body text-even-ink-400 italic text-center">
        {empty ?? "Say something — your words will appear here as you speak."}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="overflow-y-auto rounded-md border border-even-ink-100 bg-even-ink-50/40 p-4 text-body max-h-[40vh]"
      aria-live="polite"
      aria-atomic="false"
      role="log"
    >
      {finals.map((u) => {
        const text = cleanedById?.[u.id] ?? u.text;
        const isClean = cleanedById?.[u.id] !== undefined;
        return (
          <p
            key={u.id}
            className={`mb-2 leading-relaxed ${isClean ? "text-even-ink-800" : "text-even-ink-700"}`}
            title={isClean && text !== u.text ? `raw: ${u.text}` : undefined}
          >
            {text}
          </p>
        );
      })}
      {interim ? (
        <p className="text-even-ink-400 italic mb-0 leading-relaxed">
          {interim}
        </p>
      ) : null}
    </div>
  );
}
