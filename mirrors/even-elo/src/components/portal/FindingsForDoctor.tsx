"use client";

import { useCallback, useEffect, useState } from "react";
import type { NoteClass } from "@/lib/doctor-audits";
import type { CardResponse, DoctorCard } from "@/lib/doctor-card";
import { UNLINKED_TEXT } from "@/lib/finding-labels";
import { FindingCard } from "@/components/portal/FindingCard";

/**
 * Portal "Findings" panel — the documentation and prescribing findings for this physician.
 *
 * The server returns doctor cards only (see src/lib/doctor-card.ts); this component lists them with
 * the shared FindingCard. Private reactions and workflow responses have separate flags, so
 * PORTAL_FINDINGS_RESPOND can stay dark while the read-only list remains available.
 *
 * ⚠️ AN OUTAGE IS NOT AN EMPTY HISTORY. Three states are deliberately distinguishable:
 *   · unlinked    — you are signed in, your profile has not been linked yet.
 *   · no findings — we asked, and there is nothing for you.
 *   · unavailable — we could not reach the system that knows. NOT "you have none".
 * Collapsing the third into the second would tell a doctor they are clear when nobody checked.
 *
 * Note-type filter chips (All | OPD | Discharge summary | OT) re-fetch via the BFF with an optional
 * `note_class`. Selection is local state.
 */

interface FindingsData {
  ok: boolean;
  mapped: boolean;
  cards?: DoctorCard[];
  error?: string;
}

const chipCls = (on: boolean) =>
  `px-3 py-2 rounded-lg text-[12.5px] font-medium border disabled:opacity-50 ${
    on ? "bg-brand text-white border-brand" : "bg-white border-stone-200 text-stone-600"
  }`;

/** Filter chip values. `all` omits the query param so the mixed list comes back. */
type NoteClassFilter = "all" | NoteClass;

const NOTE_CLASS_FILTERS: ReadonlyArray<readonly [NoteClassFilter, string]> = [
  ["all", "All"],
  ["opd", "OPD"],
  ["discharge_summary", "Discharge summary"],
  ["ot", "OT"],
];

function Shell({ children, count }: { children: React.ReactNode; count?: number | "…" }) {
  return (
    <section className="bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Findings{" "}
          {count !== undefined && (
            <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">
              {count}
            </span>
          )}
        </h2>
      </div>
      {children}
    </section>
  );
}

export function FindingsForDoctor({
  reactions = false,
  respond = false,
}: {
  reactions?: boolean;
  respond?: boolean;
}) {
  const [data, setData] = useState<FindingsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [noteClassFilter, setNoteClassFilter] = useState<NoteClassFilter>("all");

  const load = useCallback(() => {
    setFailed(false);
    const qs =
      noteClassFilter === "all"
        ? ""
        : `?note_class=${encodeURIComponent(noteClassFilter)}`;
    fetch(`/api/portal/findings${qs}`)
      .then((r) => r.json())
      .then((j: FindingsData) => setData(j))
      .catch(() => setFailed(true));
  }, [noteClassFilter]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // After a response only the response line changes: the card keeps its context line, Basis section
  // and note link (the card the server hands back after a write can be thinner than the listed one).
  const markResponded = useCallback((id: string, response: CardResponse) => {
    setData((d) =>
      d
        ? {
            ...d,
            cards: (d.cards ?? []).map((x) => (x.id === id ? { ...x, response, can_respond: false } : x)),
          }
        : d,
    );
  }, []);

  const filterChips = (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by note type">
      {NOTE_CLASS_FILTERS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setNoteClassFilter(value)}
          className={chipCls(noteClassFilter === value)}
          aria-pressed={noteClassFilter === value}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (failed || (data && data.ok === false)) {
    // Reaching here means we could not get an answer — from the network or from upstream. Say so.
    return (
      <Shell>
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-sm text-stone-600">Findings are temporarily unavailable.</div>
        </div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell count="…">
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-center text-sm text-stone-400">Loading…</div>
        </div>
      </Shell>
    );
  }

  if (!data.mapped) {
    return (
      <Shell>
        <div className="px-5 py-4 text-sm text-stone-600">{UNLINKED_TEXT}</div>
      </Shell>
    );
  }

  const cards = data.cards ?? [];

  if (cards.length === 0) {
    return (
      <Shell count={0}>
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-sm text-stone-600">No findings for you right now.</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell count={cards.length}>
      <div className="px-5 py-4 space-y-3">
        {filterChips}
        <div className="space-y-2.5">
          {cards.map((c) => (
            <FindingCard
              key={c.id}
              card={c}
              reactions={reactions}
              respond={respond}
              onChanged={load}
              onResponded={markResponded}
            />
          ))}
        </div>
      </div>
    </Shell>
  );
}
