/**
 * Tier classification chip — locked from EVEN-ELO-MOCKUPS.html.
 * Tier strings come from PRD §6.3 + the engine in `src/lib/scoring/compose.ts`.
 */

export type Tier =
  | "distinguished"
  | "standard"
  | "watch"
  | "pip"
  | "suspension_review"
  | "no_recent_activity";

const STYLES: Record<Tier, { bg: string; text: string; label: string }> = {
  distinguished: { bg: "bg-tier-dist-bg", text: "text-tier-dist-text", label: "Distinguished" },
  standard: { bg: "bg-tier-std-bg", text: "text-tier-std-text", label: "Standard" },
  watch: { bg: "bg-tier-watch-bg", text: "text-tier-watch-text", label: "Watch" },
  pip: { bg: "bg-tier-pip-bg", text: "text-tier-pip-text", label: "PIP" },
  suspension_review: {
    bg: "bg-tier-susp-bg",
    text: "text-tier-susp-text",
    label: "Suspension review",
  },
  no_recent_activity: {
    bg: "bg-tier-none-bg",
    text: "text-tier-none-text",
    label: "No recent activity",
  },
};

interface TierChipProps {
  tier: Tier | string;
  size?: "sm" | "md";
}

export function TierChip({ tier, size = "md" }: TierChipProps) {
  const cfg = STYLES[tier as Tier] ?? STYLES.no_recent_activity;
  const sizing = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${cfg.bg} ${cfg.text} ${sizing}`}
    >
      {cfg.label}
    </span>
  );
}

export const TIER_TEXT_COLOR: Record<Tier, string> = {
  distinguished: "text-tier-dist-text",
  standard: "text-tier-std-text",
  watch: "text-tier-watch-text",
  pip: "text-tier-pip-text",
  suspension_review: "text-tier-susp-text",
  no_recent_activity: "text-tier-none-text",
};

export const TIER_BAR_COLOR: Record<Tier, string> = {
  distinguished: "bg-tier-dist-bar",
  standard: "bg-tier-std-bar",
  watch: "bg-tier-watch-bar",
  pip: "bg-tier-pip-bar",
  suspension_review: "bg-tier-susp-bar",
  no_recent_activity: "bg-tier-none-bar",
};

export const TIER_ORDER: Tier[] = [
  "distinguished",
  "standard",
  "watch",
  "pip",
  "suspension_review",
  "no_recent_activity",
];
