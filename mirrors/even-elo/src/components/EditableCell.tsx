"use client";

import { useEffect, useRef, useState } from "react";

export interface StreamConfig {
  id: string;
  label: string;
  data_type: "binary" | "numeric" | "derived";
  default_rule: "no_event" | "unknown" | "excluded" | "derived";
  direction: "higher_better" | "lower_better";
  floor_value: number | null;
  target_value: number | null;
  /**
   * Format: `<bool>[:optional]`. Examples:
   *   - `'true'`         → reason field shown + REQUIRED when val=true (unit_head_anomaly)
   *   - `'false:optional'` → reason field shown (optional) when val=false (round_attendance)
   *   - `null`           → no reason field at all
   */
  requires_reason_when: string | null;
}

export interface ReasonSpec {
  /** When the reason field should appear (val=this triggers it). */
  trigger: boolean;
  /** If false, save is blocked when reason is empty + val matches trigger. */
  optional: boolean;
}

export function parseReasonSpec(raw: string | null): ReasonSpec | null {
  if (!raw) return null;
  const [boolPart, ...mods] = raw.split(":");
  const trigger = boolPart === "true";
  if (boolPart !== "true" && boolPart !== "false") return null;
  return { trigger, optional: mods.includes("optional") };
}

export interface CellValue {
  kind: "binary" | "numeric";
  val: boolean | number;
  reason?: string;
}

interface EditableCellProps {
  caseId: string;
  stream: StreamConfig;
  /** Current observation value, or null if none entered yet. */
  current: CellValue | null;
  /** Save handler — receives the new value, returns the updated current value (or throws). */
  onSave: (value: CellValue) => Promise<void>;
  disabled?: boolean;
}

/**
 * Canonical per-cell editor for the CaseTable.
 *
 * Renders the cell based on stream.data_type + default_rule:
 *   - binary stream: Yes / No toggle (in editor mode); "Yes"/"No" pill in view mode
 *   - numeric stream: number input with floor/target hints
 *   - empty + default_rule='unknown' → red dot (must be entered to count)
 *   - empty + default_rule='no_event' → soft "—" (defaults to no event, optional)
 *   - empty + default_rule='excluded' → soft "—" (no observation, no contribution)
 *
 * Click cell → open editor. Save on Enter / blur / explicit Save click.
 * Escape cancels. 3s amber border animation after successful save.
 */
export function EditableCell({ caseId, stream, current, onSave, disabled }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CellValue | null>(current);
  const [reason, setReason] = useState<string>(current?.reason ?? "");
  const [saving, setSaving] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(current);
    setReason(current?.reason ?? "");
  }, [current, caseId, stream.id]);

  useEffect(() => {
    if (!editing) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEditing(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [editing]);

  async function commit(value: CellValue) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      setEditing(false);
      setHighlight(true);
      setTimeout(() => setHighlight(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Display state — not editing.
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => !disabled && setEditing(true)}
        disabled={disabled}
        className={`
          relative inline-flex items-center gap-1 px-2 py-1 rounded text-sm transition
          ${disabled ? "cursor-not-allowed opacity-50" : "hover:bg-stone-100 cursor-pointer"}
          ${highlight ? "ring-2 ring-amber-400 ring-offset-1" : ""}
          ${current === null ? "text-stone-400" : ""}
        `}
        title={
          disabled
            ? "Read-only"
            : current === null
              ? defaultRuleHint(stream)
              : `Click to edit — last entered ${stream.label}`
        }
      >
        {renderValue(stream, current)}
      </button>
    );
  }

  // Editor state.
  const reasonSpec = parseReasonSpec(stream.requires_reason_when);
  const reasonShown =
    reasonSpec !== null &&
    draft?.kind === "binary" &&
    draft.val === reasonSpec.trigger;

  function tryCommitBinary(val: boolean) {
    const showReasonForVal = reasonSpec !== null && val === reasonSpec.trigger;
    if (showReasonForVal && !reasonSpec.optional && !reason.trim()) {
      setError("Reason required");
      // Update draft so the reason field appears.
      setDraft({ kind: "binary", val, reason: undefined });
      return;
    }
    commit({
      kind: "binary",
      val,
      reason: reasonSpec && val === reasonSpec.trigger && reason.trim() ? reason.trim() : undefined,
    });
  }

  // Update draft on toggle so reasonShown re-evaluates.
  function selectBinary(val: boolean) {
    setDraft({ kind: "binary", val, reason: reason || undefined });
    setError(null);
  }

  return (
    <div
      ref={containerRef}
      className="relative inline-block bg-white border border-brand rounded-md p-2 shadow-md text-left"
      style={{ minWidth: "200px", zIndex: 10 }}
    >
      {stream.data_type === "binary" && (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => selectBinary(true)}
              disabled={saving}
              className={`px-3 py-1 rounded text-xs font-medium ${
                draft?.kind === "binary" && draft.val === true
                  ? "bg-emerald-600 text-white"
                  : "bg-stone-100 text-stone-700 hover:bg-stone-200"
              }`}
            >
              {binaryYesLabel(stream)}
            </button>
            <button
              type="button"
              onClick={() => selectBinary(false)}
              disabled={saving}
              className={`px-3 py-1 rounded text-xs font-medium ${
                draft?.kind === "binary" && draft.val === false
                  ? "bg-red-600 text-white"
                  : "bg-stone-100 text-stone-700 hover:bg-stone-200"
              }`}
            >
              {binaryNoLabel(stream)}
            </button>
          </div>
          {reasonShown && (
            <div className="mt-2">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  reasonSpec?.optional ? "Reason (optional)" : "Reason (required)"
                }
                className="w-full px-2 py-1 border border-stone-200 rounded text-xs"
              />
            </div>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (draft?.kind === "binary" && typeof draft.val === "boolean") {
                  tryCommitBinary(draft.val);
                }
              }}
              disabled={saving || draft?.kind !== "binary"}
              className="px-3 py-1 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "…" : "Save"}
            </button>
          </div>
        </>
      )}
      {stream.data_type === "numeric" && (
        <NumericEditor
          stream={stream}
          initial={(draft?.kind === "numeric" ? (draft.val as number) : null) ?? null}
          saving={saving}
          onSave={(n) =>
            commit({ kind: "numeric", val: n, reason: reason || undefined })
          }
        />
      )}
      {error && <div className="text-[11px] text-red-700 mt-1">{error}</div>}
    </div>
  );
}

function binaryYesLabel(stream: StreamConfig): string {
  if (stream.id === "round_attendance") return "Adequate";
  return "Yes";
}
function binaryNoLabel(stream: StreamConfig): string {
  if (stream.id === "round_attendance") return "Inadequate";
  return "No";
}

function NumericEditor({
  stream,
  initial,
  saving,
  onSave,
}: {
  stream: StreamConfig;
  initial: number | null;
  saving: boolean;
  onSave: (n: number) => void;
}) {
  const [text, setText] = useState<string>(initial !== null ? String(initial) : "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function tryCommit() {
    const n = parseFloat(text);
    if (isNaN(n)) return;
    onSave(n);
  }
  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        type="number"
        step="any"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") tryCommit();
        }}
        className="w-24 px-2 py-1 border border-stone-200 rounded text-xs font-mono"
      />
      <span className="text-[10px] text-stone-500">
        {stream.direction === "higher_better"
          ? `↑ ${stream.target_value} = 100`
          : `↓ ${stream.target_value} = 100`}
      </span>
      <button
        type="button"
        onClick={tryCommit}
        disabled={saving}
        className="px-2 py-1 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
      >
        {saving ? "…" : "Save"}
      </button>
    </div>
  );
}

function renderValue(stream: StreamConfig, value: CellValue | null): React.ReactNode {
  if (value === null) {
    if (stream.default_rule === "unknown") {
      return (
        <span className="relative inline-flex items-center">
          <span className="absolute -top-0.5 -right-1 w-1.5 h-1.5 bg-red-500 rounded-full" />
          <span className="text-stone-400">—</span>
        </span>
      );
    }
    return <span className="text-stone-300">—</span>;
  }
  if (value.kind === "binary") {
    const yesLabel = binaryYesLabel(stream);
    const noLabel = binaryNoLabel(stream);
    if (stream.direction === "higher_better") {
      return (
        <span
          className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
            value.val
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {value.val ? yesLabel : noLabel}
        </span>
      );
    }
    // lower_better: true = bad event happened, red. false = good (no event), neutral.
    return (
      <span
        className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
          value.val ? "bg-red-50 text-red-700" : "bg-stone-100 text-stone-600"
        }`}
      >
        {value.val ? yesLabel : noLabel}
      </span>
    );
  }
  // numeric
  return <span className="font-mono text-xs num font-medium">{(value.val as number).toString()}</span>;
}

function defaultRuleHint(stream: StreamConfig): string {
  switch (stream.default_rule) {
    case "unknown":
      return `Required: must be entered to count toward ${stream.label}`;
    case "no_event":
      return `Defaults to "no event happened" — only enter if it did`;
    case "excluded":
      return `Optional: only enter if you have a measurement`;
    default:
      return stream.label;
  }
}
