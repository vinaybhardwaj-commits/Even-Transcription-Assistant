import Link from "next/link";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import type { ModuleTile, OverviewViewModel, TileChip } from "@/lib/overview-modules";

const CHIP: Record<TileChip, string> = {
  live: "bg-emerald-100 text-emerald-800",
  live_route: "bg-emerald-100 text-emerald-800",
  proposed: "bg-violet-100 text-violet-800",
  stale: "bg-orange-100 text-orange-900",
  empty: "bg-stone-100 text-stone-600",
  partial: "bg-amber-50 text-amber-800",
  not_loaded: "bg-stone-100 text-stone-600",
};

const GROUPS: Array<{ id: ModuleTile["group"]; label: string }> = [
  { id: "people", label: "People" },
  { id: "clinical", label: "Clinical quality" },
  { id: "safety", label: "Safety & feedback" },
];

function Tile({ tile }: { tile: ModuleTile }) {
  const proposed = tile.chip === "proposed";
  const empty = tile.chip === "empty";
  const className =
    "block rounded-xl border bg-white px-4 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)] " +
    (proposed ? "border-dashed border-stone-300 " : "border-stone-200 ") +
    (empty ? "bg-stone-50 " : "") +
    (tile.href ? "transition hover:border-brand hover:shadow-md" : "");
  const inner = (
    <>
      <h3 className="flex flex-wrap items-center gap-2 text-[0.95rem] font-semibold text-stone-900">
        {tile.title}
        <span className={"inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide " + CHIP[tile.chip]}>
          {tile.chipLabel}
        </span>
      </h3>
      <p className="mt-1.5 text-[13px] leading-snug text-stone-500">{tile.body}</p>
      <div className={"mt-2.5 text-[12px] font-semibold " + (tile.href ? "text-brand" : "text-stone-400")}>{tile.meta}</div>
    </>
  );
  if (!tile.href) {
    return (
      <div className={className} title={proposed ? "Proposed — no volumes" : undefined}>
        {inner}
      </div>
    );
  }
  return (
    <Link href={tile.href} className={className}>
      {inner}
    </Link>
  );
}

export function OverviewModules({ model }: { model: OverviewViewModel }) {
  const stats: HeadlineStat[] = model.headline.map((item) => ({
    label: item.label,
    value: item.value,
    hint: item.hint,
    tone: item.tone === "danger" ? "danger" : item.tone === "muted" ? "muted" : "default",
  }));

  return (
    <section aria-label="Programme overview">
      <h1 className="text-[1.55rem] font-bold tracking-tight text-stone-900">Overview</h1>
      <p className="mb-5 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
        Programme home — tiles route to live modules with real counts, or to proposed and empty surfaces labeled honestly.
      </p>
      <HeadlineStrip stats={stats} />
      <div className="mb-5 rounded-[10px] border border-teal-200 bg-teal-50 px-4 py-3 text-[13.5px] leading-relaxed text-teal-900">
        <strong className="font-semibold text-teal-800">Honesty rule: </strong>
        {model.banner}
      </div>
      {GROUPS.map((group) => (
        <div key={group.id} className="mb-2">
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-stone-500">{group.label}</div>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {model.tiles
              .filter((tile) => tile.group === group.id)
              .map((tile) => (
                <Tile key={tile.id} tile={tile} />
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}
