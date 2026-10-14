import { Tier, TIER_BAR_COLOR } from "./TierChip";

interface ScoreBarProps {
  /** 0–100 component score, or null for insufficient data. */
  value: number | null;
  /** Tier driving the bar colour (overall composite tier, not per-component). */
  tier: Tier | string;
  /** Optional width in px. Default 100. */
  width?: number;
}

/**
 * Horizontal 0–100 progress bar with tier-coloured fill + numeric label.
 * Locked from EVEN-ELO-MOCKUPS.html leaderboard table.
 */
export function ScoreBar({ value, tier, width = 100 }: ScoreBarProps) {
  if (value === null) {
    return (
      <div className="flex items-center gap-2">
        <div
          className="bg-stone-100 rounded h-1.5"
          style={{ width: `${width}px` }}
        />
        <span className="text-[11px] text-stone-400 num">—</span>
      </div>
    );
  }
  const fillColor = TIER_BAR_COLOR[tier as Tier] ?? "bg-tier-none-bar";
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div
        className="bg-stone-100 rounded h-1.5 overflow-hidden"
        style={{ width: `${width}px` }}
      >
        <div className={`${fillColor} h-full rounded`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-stone-500 num tabular-nums">{Math.round(value)}</span>
    </div>
  );
}
