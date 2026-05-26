"use client";

import * as React from "react";

/**
 * Counts elapsed seconds while `running` is true. Pauses (doesn't
 * reset) when running flips false; resumes from where it left off
 * when it flips back true.
 */
export function ElapsedTimer({
  running,
  className = "",
}: {
  running: boolean;
  className?: string;
}) {
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const startedAtRef = React.useRef<number | null>(null);
  const accumRef = React.useRef(0);

  React.useEffect(() => {
    if (running) {
      startedAtRef.current = Date.now();
      const tick = () => {
        const startedAt = startedAtRef.current;
        if (startedAt == null) return;
        setElapsedMs(accumRef.current + (Date.now() - startedAt));
      };
      tick();
      const id = window.setInterval(tick, 250);
      return () => {
        window.clearInterval(id);
        const startedAt = startedAtRef.current;
        if (startedAt != null) {
          accumRef.current += Date.now() - startedAt;
          startedAtRef.current = null;
        }
      };
    }
    return undefined;
  }, [running]);

  const total = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");

  return (
    <span
      className={`font-mono tabular-nums ${className}`}
      aria-live="off"
      aria-label={`Elapsed: ${total} seconds`}
    >
      {mm}:{ss}
    </span>
  );
}
