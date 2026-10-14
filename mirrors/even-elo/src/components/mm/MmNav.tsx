"use client";

/**
 * M&M case-section nav + the shared chip/badge primitives for the /mm module.
 *
 * The six sections are tabs within one case workspace page, not routes: only
 * "Review" has a backend today, and routing to five empty pages would imply
 * five destinations that do not exist. Section state lives in MmCaseClient.
 *
 * NOW / NEXT / LATER badges mirror the mockup's build-stage legend
 * (MM-WORKSPACE-MOCKUP-v1-10-JUL-2026.html).
 */

export type MmStage = "now" | "next" | "later";

export type MmSectionKey = "sources" | "timeline" | "nodes" | "causation" | "review" | "outputs";

export interface MmSection {
  key: MmSectionKey;
  label: string;
  stage: MmStage;
}

export const MM_SECTIONS: MmSection[] = [
  { key: "sources", label: "Sources", stage: "next" },
  { key: "timeline", label: "Timeline", stage: "later" },
  { key: "nodes", label: "Decision nodes", stage: "later" },
  { key: "causation", label: "Causation", stage: "later" },
  { key: "review", label: "Review", stage: "now" },
  { key: "outputs", label: "Outputs", stage: "later" },
];

const BADGE_STYLE: Record<MmStage, string> = {
  now: "bg-emerald-600 text-white",
  next: "bg-amber-600 text-white",
  later: "bg-stone-500 text-white",
};

export function Badge({ stage }: { stage: MmStage }) {
  return (
    <span
      className={
        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] align-middle " +
        BADGE_STYLE[stage]
      }
    >
      {stage}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-stone-100 text-stone-600",
  in_review: "bg-amber-50 text-amber-700",
  ratified: "bg-emerald-50 text-emerald-700",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold " +
        (STATUS_STYLE[status] || "bg-stone-100 text-stone-600")
      }
    >
      {status}
    </span>
  );
}

export function OutcomeChip({ outcome }: { outcome: string }) {
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold " +
        (outcome === "death" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700")
      }
    >
      {outcome}
    </span>
  );
}

/** A section that has no backend yet: names what will appear, and when. */
export function EmptySection({
  title,
  stage,
  lead,
  bullets,
  foot,
}: {
  title: string;
  stage: MmStage;
  lead: string;
  bullets: string[];
  foot?: string;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <Badge stage={stage} />
      </div>
      <p className="text-[13px] text-stone-500">{lead}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-stone-600">
        {bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <div className="mt-4 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center text-[12.5px] text-stone-400">
        Nothing here yet — this section is built by a later kickoff. No placeholder clinical content is shown.
      </div>
      {foot && <p className="mt-3 text-[11.5px] italic text-stone-400">{foot}</p>}
    </div>
  );
}

export default function MmNav({
  active,
  onSelect,
}: {
  active: MmSectionKey;
  onSelect: (k: MmSectionKey) => void;
}) {
  return (
    <div className="sticky top-[56px] z-30 -mx-8 mb-6 border-b border-stone-200 bg-white/85 px-8 backdrop-blur">
      <nav className="flex items-center gap-1 overflow-x-auto py-2.5">
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">Case</span>
        {MM_SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            className={
              "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition " +
              (active === s.key
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-100 hover:text-stone-900")
            }
          >
            {s.label}
            {s.stage !== "now" && (
              <span
                className={
                  "rounded px-1 py-px text-[9px] font-bold uppercase " +
                  (active === s.key ? "bg-white/20 text-white" : "bg-stone-100 text-stone-400")
                }
              >
                {s.stage}
              </span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
