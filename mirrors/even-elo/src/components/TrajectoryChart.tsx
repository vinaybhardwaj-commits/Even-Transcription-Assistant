interface TrajectoryPoint {
  composite: number;
  computed_at: string;
  tier: string;
}

interface TrajectoryChartProps {
  points: TrajectoryPoint[];
  /** Final tier for the highlighted dot. */
  currentTier?: string;
}

const TIER_COLORS: Record<string, string> = {
  distinguished: "#16a34a",
  standard: "#2563eb",
  watch: "#d97706",
  pip: "#ea580c",
  suspension_review: "#dc2626",
  no_recent_activity: "#71717a",
};

/**
 * 90-day composite trajectory with tier threshold dashed lines.
 * Locked from EVEN-ELO-MOCKUPS.html /vc/[id] mockup screen #2.
 *
 * Tier thresholds (PRD §6.3):
 *   75 → distinguished
 *   60 → standard
 *   45 → watch
 *   30 → pip
 */
export function TrajectoryChart({ points, currentTier }: TrajectoryChartProps) {
  const width = 280;
  const height = 110;

  if (points.length === 0) {
    return (
      <div className="text-xs text-stone-500">No snapshot history yet.</div>
    );
  }

  // Y-axis: 0 (bottom) → 100 (top).
  const yFor = (composite: number) => {
    const clamped = Math.max(0, Math.min(100, composite));
    return height - (clamped / 100) * height;
  };

  // X-axis: equally spaced points.
  const xFor = (i: number) =>
    points.length === 1 ? width / 2 : (i / (points.length - 1)) * width;

  const pointsStr = points.map((p, i) => `${xFor(i)},${yFor(p.composite)}`).join(" ");

  const lastIdx = points.length - 1;
  const lastTier = currentTier ?? points[lastIdx].tier;

  return (
    <div>
      <svg width="100%" height={height + 20} viewBox={`0 0 ${width + 30} ${height + 20}`}>
        {/* Tier threshold dashed lines */}
        {[
          { y: 75, color: "#dcfce7", label: "75" },
          { y: 60, color: "#dbeafe", label: "60" },
          { y: 45, color: "#fef3c7", label: "45" },
          { y: 30, color: "#ffedd5", label: "30" },
        ].map((t) => (
          <g key={t.label}>
            <line
              x1="0"
              y1={yFor(t.y)}
              x2={width}
              y2={yFor(t.y)}
              stroke={t.color}
              strokeDasharray="2,3"
              strokeWidth="1"
            />
            <text x={width + 4} y={yFor(t.y) + 3} fontSize="9" fill={TIER_COLORS[Object.keys(TIER_COLORS)[["75","60","45","30"].indexOf(t.label)]]}>
              {t.label}
            </text>
          </g>
        ))}

        {/* Trajectory line */}
        {points.length >= 2 && (
          <polyline
            points={pointsStr}
            stroke="#0f766e"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Current dot */}
        <circle
          cx={xFor(lastIdx)}
          cy={yFor(points[lastIdx].composite)}
          r="3.5"
          fill={TIER_COLORS[lastTier] ?? "#71717a"}
          stroke="white"
          strokeWidth="1.5"
        />
      </svg>
      <div className="text-xs text-stone-500 mt-2 num">
        {points.length} snapshot{points.length === 1 ? "" : "s"} in last 90 days · current{" "}
        <span className="font-medium" style={{ color: TIER_COLORS[lastTier] }}>
          {points[lastIdx].composite.toFixed(1)}
        </span>
      </div>
    </div>
  );
}
