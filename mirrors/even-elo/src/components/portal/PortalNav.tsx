"use client";

/**
 * Portal navigation (R5 PRD §2) — five destinations, two renderings:
 * phones get a fixed bottom tab bar (thumb-reach, safe-area inset),
 * desktop (lg+) keeps a top pill row. One IA, responsive chrome.
 */

export type Dest = "home" | "performance" | "findings" | "report" | "credentials" | "me";

/**
 * THE RAISED BUTTON IS CHOSEN BY IDENTITY, NEVER BY POSITION.
 *
 * Report was the middle of five, so "raised" and "centred" used to describe the same item by
 * coincidence. WM2 adds a sixth destination and that coincidence ends: Report is now third of
 * six and sits off-centre. It stays raised anyway — it is the primary action, and moving the raised
 * treatment to whatever lands in the middle would hand it to Findings, a read-only destination.
 * Deliberately NOT re-centred.
 */
const RAISED: Dest = "report";

const ITEMS: Array<{ d: Dest; label: string; short: string; icon: JSX.Element }> = [
  { d: "home", label: "Home", short: "Home", icon: <path d="M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5" /> },
  { d: "performance", label: "My Performance", short: "Performance", icon: <path d="M4 20V10m5.5 10V4m5.5 16v-7M20.5 20v-12" /> },
  { d: "report", label: "Report", short: "Report", icon: <path d="M12 5v14M5 12h14" /> },
  { d: "findings", label: "Findings", short: "Findings", icon: <path d="M4 5h16M4 12h16M4 19h10" /> },
  { d: "credentials", label: "Credentials", short: "Credentials", icon: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6" /> },
  { d: "me", label: "About me", short: "Me", icon: <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-7 9a7 7 0 0 1 14 0" /> },
];

/** Flag off ⇒ Findings is not in the nav at all (not merely disabled). */
function itemsFor(showFindings: boolean) {
  return showFindings ? ITEMS : ITEMS.filter((it) => it.d !== "findings");
}

export function PortalNav({ dest, onChange, showFindings = false }: { dest: Dest; onChange: (d: Dest) => void; showFindings?: boolean }) {
  return (
    <>
      {/* Desktop pill row (mobile uses <MobileTabBar> — an IN-FLOW bar at the bottom of the
          app frame; position:fixed detaches during iOS Safari URL-bar collapse, found live 2 Jul) */}
      <div className="hidden lg:flex flex-wrap gap-1.5 mb-5">
        {itemsFor(showFindings).map((it) => (
          <button
            key={it.d}
            onClick={() => onChange(it.d)}
            className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition ${
              dest === it.d ? "bg-brand text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>

    </>
  );
}

/**
 * Mobile tab bar — rendered as the LAST FLEX CHILD of the viewport-height app
 * frame in portal/page.tsx (NOT position:fixed; iOS Safari detaches fixed
 * elements while the URL bar collapses during scroll). Always visible because
 * the frame is 100dvh and only the content area scrolls.
 */
export function MobileTabBar({ dest, onChange, showFindings = false }: { dest: Dest; onChange: (d: Dest) => void; showFindings?: boolean }) {
  return (
    <nav
      className="lg:hidden shrink-0 border-t border-stone-200 bg-white"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-[560px] items-stretch justify-between px-2">
        {itemsFor(showFindings).map((it) => {
          const active = dest === it.d;
          const isReport = it.d === RAISED;   // identity, not index — see RAISED above
          return (
            <button
              key={it.d}
              onClick={() => onChange(it.d)}
              aria-label={it.label}
              className="flex min-h-[56px] min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5"
            >
              <span
                className={`flex items-center justify-center rounded-full transition ${
                  isReport
                    ? "h-9 w-9 -mt-3 shadow-md " + (active ? "bg-brand-hover text-white" : "bg-brand text-white")
                    : "h-6 w-6 " + (active ? "text-brand" : "text-stone-400")
                }`}
              >
                <svg width={isReport ? 20 : 22} height={isReport ? 20 : 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {it.icon}
                </svg>
              </span>
              <span className={`text-[10px] font-semibold ${active ? "text-brand" : "text-stone-400"}`}>{it.short}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
