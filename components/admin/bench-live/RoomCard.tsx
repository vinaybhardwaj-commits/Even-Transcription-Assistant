"use client";

import * as React from "react";
import type { Level } from "@/components/admin/bench-live/types";

const CARD_EDGE: Record<Level, string> = {
  ok: "border-even-ink-200 bg-even-white",
  amber: "border-warning-200 bg-warning-50",
  red: "border-danger-200 bg-danger-50",
  unknown: "border-even-ink-200 bg-even-ink-50",
};

/**
 * The interaction and visual boundary for one fleet card. The operational body remains composed
 * by the polling shell while it is split into smaller command and vital panels.
 */
export function RoomCard({
  id,
  name,
  level,
  selected,
  onSelect,
  children,
}: {
  id: string;
  name: string;
  level: Level;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      id={`bench-room-${id}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      aria-label={`Select ${name}`}
      className={`text-left rounded-xl border p-4 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-even-blue-400 ${CARD_EDGE[level]} ${selected ? "ring-2 ring-even-blue-400" : "hover:bg-even-ink-50"}`}
    >
      {children}
    </div>
  );
}
