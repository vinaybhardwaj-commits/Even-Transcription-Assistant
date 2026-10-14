"use client";

/** Portal Home: What's new / Coming soon (portal_announcements) + Councils teaser (R5 PRD §4-5). */

export interface Announcement {
  id: string;
  title: string;
  body: string | null;
}
export interface AnnData {
  whats_new: Announcement[];
  coming_soon: Announcement[];
}

export function HomeExtras({ ann }: { ann: AnnData | null }) {
  if (!ann || (ann.whats_new.length === 0 && ann.coming_soon.length === 0)) return null;
  return (
    <section className="bg-white border border-stone-200 rounded-xl p-5">
      {ann.whats_new.length > 0 && (
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-brand mb-2">What&apos;s new</h2>
          <div className="space-y-2.5">
            {ann.whats_new.map((a) => (
              <div key={a.id}>
                <div className="text-sm font-semibold">{a.title}</div>
                {a.body && <div className="text-[13px] text-stone-500 leading-snug">{a.body}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      {ann.coming_soon.length > 0 && (
        <div className={ann.whats_new.length > 0 ? "mt-4 pt-4 border-t border-stone-100" : ""}>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400 mb-2">Coming soon</h2>
          <div className="space-y-2.5">
            {ann.coming_soon.map((a) => (
              <div key={a.id} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-300" />
                <div>
                  <div className="text-sm font-medium text-stone-700">{a.title}</div>
                  {a.body && <div className="text-[12.5px] text-stone-400 leading-snug">{a.body}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
