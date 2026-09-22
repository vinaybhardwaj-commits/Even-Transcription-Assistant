"use client";

import type { Attention } from "@/components/admin/bench-live/types";

const PILL = "inline-block px-2 py-0.5 rounded-full text-caption font-semibold";

export function BenchAttentionList({
  items,
  hasRooms,
  onSelect,
}: {
  items: Attention[];
  hasRooms: boolean;
  onSelect?: (roomId: string) => void;
}) {
  if (items.length === 0) {
    return hasRooms ? <p className="text-caption text-success-700">Nothing needs attention.</p> : null;
  }
  return (
    <div className="rounded-lg border border-even-ink-200 divide-y divide-even-ink-100">
      <p className="px-3 py-2 text-caption uppercase tracking-wide text-even-ink-500">Needs your attention</p>
      {items.map((item, index) => (
        <button
          type="button"
          key={`${item.roomId}-${item.title}-${index}`}
          className="w-full min-h-11 px-3 py-2 flex items-start gap-3 text-left hover:bg-even-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-even-blue-400"
          onClick={() => onSelect?.(item.roomId)}
        >
          <span className={`${PILL} ${item.severity === "red" ? "bg-danger-100 text-danger-700" : "bg-warning-100 text-warning-700"}`}>
            {item.severity === "red" ? "act now" : "watch"}
          </span>
          <div className="min-w-0">
            <p className="text-body text-even-navy-800">
              <span className="font-semibold">{item.room}</span> — {item.title}
            </p>
            <p className="text-caption text-even-ink-500">{item.detail}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
