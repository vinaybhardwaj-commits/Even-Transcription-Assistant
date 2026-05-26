"use client";

import * as React from "react";

type Props = {
  length?: number;
  onComplete: (pin: string) => void | Promise<void>;
  disabled?: boolean;
  errorShake?: number; // changes value to trigger shake animation
};

/**
 * Numeric PIN pad — large touch targets (44pt), no keyboard input.
 * PRD §8.1.1: auto-submit on completion, no Submit button.
 * No keyboard input avoids leaking to password managers as a weak password.
 */
export function PinPad({ length = 4, onComplete, disabled = false, errorShake = 0 }: Props) {
  const [pin, setPin] = React.useState("");
  const [shake, setShake] = React.useState(false);

  React.useEffect(() => {
    if (errorShake > 0) {
      setPin("");
      setShake(true);
      const t = setTimeout(() => setShake(false), 400);
      return () => clearTimeout(t);
    }
  }, [errorShake]);

  const handleDigit = (d: string) => {
    if (disabled || pin.length >= length) return;
    const next = pin + d;
    setPin(next);
    if (next.length === length) {
      // Defer to give the dot a chance to render
      setTimeout(() => onComplete(next), 80);
    }
  };

  const handleBackspace = () => {
    if (disabled) return;
    setPin((p) => p.slice(0, -1));
  };

  return (
    <div className={shake ? "animate-shake" : ""}>
      <div
        className="flex justify-center gap-4 mb-8"
        role="status"
        aria-live="polite"
        aria-label={`${pin.length} of ${length} digits entered`}
      >
        {Array.from({ length }).map((_, i) => (
          <span
            key={i}
            className={`block w-4 h-4 rounded-full transition-colors ${
              i < pin.length ? "bg-even-navy-800" : "bg-even-ink-200"
            }`}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-[280px] mx-auto">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => handleDigit(d)}
            disabled={disabled}
            aria-label={`Digit ${d}`}
            className="aspect-square rounded-xl bg-even-ink-50 hover:bg-even-ink-100 active:bg-even-ink-200 text-display text-even-navy-800 focus:outline-none focus:ring-2 focus:ring-even-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {d}
          </button>
        ))}
        <span aria-hidden="true" />
        <button
          type="button"
          onClick={() => handleDigit("0")}
          disabled={disabled}
          aria-label="Digit 0"
          className="aspect-square rounded-xl bg-even-ink-50 hover:bg-even-ink-100 active:bg-even-ink-200 text-display text-even-navy-800 focus:outline-none focus:ring-2 focus:ring-even-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          0
        </button>
        <button
          type="button"
          onClick={handleBackspace}
          disabled={disabled || pin.length === 0}
          aria-label="Backspace"
          className="aspect-square rounded-xl text-display text-even-ink-500 hover:bg-even-ink-50 focus:outline-none focus:ring-2 focus:ring-even-blue-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
