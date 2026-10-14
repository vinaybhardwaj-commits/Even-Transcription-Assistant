import { Tier, TIER_ORDER, TIER_BAR_COLOR } from "./TierChip";

interface TierDistributionBarProps {
  /** Tier counts keyed by tier id. */
  distribution: Record<string, number>;
}

const TIER_LABELS: Record<Tier, string> = {
  distinguished: "Distinguished",
  standard: "Standard",
  watch: "Watch",
  pip: "PIP",
  suspension_review: "Susp.",
  no_recent_activity: "No activity",
};

/**
 * Stacked horizontal bar showing tier counts as proportional segments.
 * Locked from EVEN-ELO-MOCKUPS.html leaderboard hero strip.
 */
export function TierDistributionBar({ distribution }: TierDistributionBarProps) {
  const tiersInOrder = TIER_ORDER.filter((t) => (distribution[t] ?? 0) > 0);
  const total = tiersInOrder.reduce((sum, t) => sum + (distribution[t] ?? 0), 0);

  if (total === 0) {
    return (
      <div className="card p-5 bg-white border border-stone-200 rounded-xl">
        <div className="text-sm font-medium mb-3">Tier distribution</div>
        <div className="text-sm text-stone-500">No VCs scored yet.</div>
      </div>
    );
  }

  return (
    <div className="card p-5 bg-white border border-stone-200 rounded-xl">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Tier distribution</div>
        <div className="text-xs text-stone-500 num">
          {total} VC{total === 1 ? "" : "s"} total
        </div>
      </div>
      <div className="flex h-7 rounded-md overflow-hidden">
        {tiersInOrder.map((tier) => {
          const n = distribution[tier];
          const widthPct = (n / total) * 100;
          return (
            <div
              key={tier}
              className={`${TIER_BAR_COLOR[tier]} flex items-center justify-center text-white text-xs font-semibold`}
              style={{ width: `${widthPct}%` }}
              title={`${n} ${TIER_LABELS[tier]}`}
            >
              {widthPct >= 8 && (
                <span>
                  {n} {TIER_LABELS[tier]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
