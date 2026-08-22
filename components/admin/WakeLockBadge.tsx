"use client";

/**
 * WakeLockBadge — K3 A5. Keeps the operator's screen awake while /admin/bench is visible.
 *
 * WHY: on 24 August an operator walks an OPD with a tablet watching this page. A tablet that
 * sleeps every thirty seconds is a tablet that is not watching anything, and waking it means
 * unlocking it, which means it is not in a pocket. This is the whole reason the page is being
 * made walkable.
 *
 * ─── THE THREE RULES ──────────────────────────────────────────────────────────────────────
 *
 * 1. A wake lock DIES when the page is hidden. That is the spec, not a bug: the browser
 *    releases it on tab switch, lock screen, or app switch, and it does NOT come back by
 *    itself. So the lock is re-requested on every `visibilitychange` back to visible. A build
 *    that only requested it once would hold the screen awake until the first notification and
 *    then quietly stop, which is worse than never having it — the operator would trust it.
 *
 * 2. IT MUST FAIL QUIETLY. `navigator.wakeLock` does not exist in every browser, and even where
 *    it does the request rejects on a low battery or an unsupported surface. Every path here
 *    ends in a state string, never a thrown error and never a broken page. The badge says which
 *    state it is in, so "not supported" is visible rather than indistinguishable from "held".
 *
 * 3. IT IS DISPLAY-ONLY. Nothing about the bench page's data, polling or controls depends on
 *    this component. Deleting it would change nothing except that the screen would sleep.
 */

import * as React from "react";

type WakeState = "held" | "released" | "unsupported" | "denied";

/** The slice of the API used here. Typed locally: TS's DOM lib does not carry it everywhere. */
type WakeLockSentinelLike = { released: boolean; release: () => Promise<void>; addEventListener: (t: string, f: () => void) => void };
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

export function WakeLockBadge() {
  const [state, setState] = React.useState<WakeState>("released");
  const sentinelRef = React.useRef<WakeLockSentinelLike | null>(null);

  React.useEffect(() => {
    const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!api) {
      setState("unsupported");
      return;
    }
    let cancelled = false;

    const acquire = async () => {
      // Already holding one, or the page is not visible — nothing to do. Requesting while
      // hidden throws by spec, so this guard is load-bearing rather than an optimisation.
      if (cancelled || document.hidden) return;
      if (sentinelRef.current && !sentinelRef.current.released) return;
      try {
        const s = await api.request("screen");
        if (cancelled) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinelRef.current = s;
        setState("held");
        // The browser may drop it on its own (battery, policy). Reflect that rather than
        // keep claiming the screen is being held awake.
        s.addEventListener("release", () => {
          if (!cancelled) setState(document.hidden ? "released" : "denied");
        });
      } catch {
        if (!cancelled) setState("denied");
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        // The browser has already released it; this only makes the badge honest.
        setState((s) => (s === "unsupported" ? s : "released"));
      } else {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s && !s.released) void s.release().catch(() => undefined);
    };
  }, []);

  const label: Record<WakeState, string> = {
    held: "screen awake",
    released: "screen may sleep",
    unsupported: "screen sleep: not controllable",
    denied: "screen sleep: refused",
  };
  const tone: Record<WakeState, string> = {
    held: "bg-success-100 text-success-700",
    released: "bg-even-ink-100 text-even-ink-500",
    unsupported: "bg-even-ink-100 text-even-ink-500",
    denied: "bg-warning-100 text-warning-700",
  };

  return (
    <span
      data-testid="wake-lock-state"
      data-state={state}
      className={`inline-flex items-center min-h-11 px-3 rounded-lg text-caption font-semibold ${tone[state]}`}
      title="A screen wake lock is requested while this page is visible, and re-requested when you come back to it."
    >
      {label[state]}
    </span>
  );
}
