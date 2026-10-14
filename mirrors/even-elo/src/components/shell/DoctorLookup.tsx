"use client";

import { useEffect, useId, useRef, useState } from "react";
import { lookupCandidates } from "@/lib/feedback-home";

export interface DoctorLookupOption {
  id: string;
  name: string;
  specialty: string;
}

/**
 * Look-up-by-doctor (Sprint 0.1). Typing filters `options`; choosing a row
 * sets the query to that physician's name so the parent can filter its body.
 */
export function DoctorLookup({
  options,
  value,
  onChange,
  placeholder = "Look up by doctor…",
}: {
  options: DoctorLookupOption[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const matches = lookupCandidates(options, value);
  const shown = matches.slice(0, 12);

  useEffect(() => {
    setActive(0);
  }, [value, open]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function choose(name: string) {
    onChange(name);
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div ref={wrapRef} className="relative w-full max-w-[300px]">
      <span className="pointer-events-none absolute left-2.5 top-1/2 z-[1] -translate-y-1/2 text-[13px] text-stone-400" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        aria-label="Look up by doctor"
        aria-expanded={open}
        aria-controls={listId}
        role="combobox"
        className="w-full rounded-lg border border-stone-200 bg-white py-2 pl-8 pr-8 text-[13px] text-stone-900 outline-none placeholder:text-stone-400 focus:border-brand focus:ring-[3px] focus:ring-brand-soft"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            return;
          }
          if (!open || shown.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = shown[active];
            if (pick) choose(pick.name);
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-[11px] font-medium text-stone-400 hover:text-stone-700"
          aria-label="Clear doctor lookup"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          Clear
        </button>
      ) : null}
      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-[260px] overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-[0_4px_16px_rgba(28,25,23,0.06)]"
        >
          {shown.length === 0 ? (
            <div className="px-3 py-3 text-[13px] text-stone-500">No match</div>
          ) : (
            shown.map((opt, i) => (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={i === active}
                className={
                  "block w-full border-b border-stone-100 px-3 py-2 text-left last:border-b-0 " +
                  (i === active ? "bg-brand-soft" : "hover:bg-brand-soft")
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(opt.name)}
              >
                <div className="text-[13px] font-semibold text-stone-900">{opt.name}</div>
                <div className="text-[11px] text-stone-500">{opt.specialty}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
