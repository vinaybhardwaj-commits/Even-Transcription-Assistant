"use client";

import { useCallback, useEffect, useState } from "react";
import type { CardResponse, DoctorCard } from "@/lib/doctor-card";
import { FindingCard } from "@/components/portal/FindingCard";

/**
 * Findings from reviewed notes (discharge summaries, OT notes and other stored note reviews),
 * rendered with the same shared card as the main Findings list. The server returns doctor cards
 * only; this component renders nothing at all when there are none.
 */
export function LocalDocumentAuditsForDoctor({ respond = false }: { respond?: boolean }) {
  const [cards, setCards] = useState<DoctorCard[] | null>(null);

  const load = useCallback(() => {
    fetch("/api/portal/document-audits")
      .then((r) => r.json())
      .then((j) => setCards(j.ok && Array.isArray(j.cards) ? (j.cards as DoctorCard[]) : []))
      .catch(() => setCards([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Only the response line changes; the rest of the card stays as listed.
  const markResponded = useCallback((id: string, response: CardResponse) => {
    setCards((cs) => (cs ? cs.map((x) => (x.id === id ? { ...x, response, can_respond: false } : x)) : cs));
  }, []);

  if (cards === null || cards.length === 0) return null;

  return (
    <section className="bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-3.5 border-b border-stone-100">
        <h2 className="text-sm font-semibold">
          Note findings{" "}
          <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">
            {cards.length}
          </span>
        </h2>
      </div>
      <div className="px-5 py-4 space-y-2.5">
        {cards.map((c) => (
          <FindingCard
            key={c.id}
            card={c}
            respond={respond}
            onChanged={load}
            onResponded={markResponded}
          />
        ))}
      </div>
    </section>
  );
}
