export interface HeadlineStat {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "danger" | "ok" | "muted";
  compact?: boolean;
}

const TONE: Record<NonNullable<HeadlineStat["tone"]>, string> = {
  default: "text-stone-900",
  danger: "text-red-700",
  ok: "text-emerald-700",
  muted: "text-stone-500",
};

/**
 * Shared headline stats strip (Sprint 0.1). Later modules pass their own stats;
 * this component does not fetch.
 */
export function HeadlineStrip({ stats }: { stats: HeadlineStat[] }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-xl border border-stone-200 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        >
          <div className="text-[11px] font-medium leading-snug text-stone-500">{stat.label}</div>
          <div
            className={
              "num mt-1 font-bold leading-none tracking-tight " +
              (stat.compact ? "pt-1 text-[1.05rem] " : "text-[1.55rem] ") +
              TONE[stat.tone ?? "default"]
            }
          >
            {stat.value}
          </div>
          {stat.hint ? <div className="mt-1 text-[11px] text-stone-500">{stat.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}
