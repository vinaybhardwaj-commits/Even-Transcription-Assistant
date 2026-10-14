interface AuditRow {
  id: string;
  actor_position: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  at: string;
  case_ref_for_obs: string | null;
}

interface StreamConfig {
  id: string;
  label: string;
}

interface ActivityFeedProps {
  rows: AuditRow[];
  streams: StreamConfig[];
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function streamLabel(streams: StreamConfig[], id: string): string {
  return streams.find((s) => s.id === id)?.label ?? id;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/**
 * Human-readable activity feed — last 50 audit_log entries scoped to one VC.
 * Locked from EVEN-ELO-MOCKUPS.html /vc/[id] activity feed.
 */
export function ActivityFeed({ rows, streams }: ActivityFeedProps) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-stone-500 px-5 py-6 text-center">
        No activity yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-stone-100">
      {rows.map((r) => {
        const dot = dotFor(r.action);
        const summary = summarize(r, streams);
        return (
          <div key={r.id} className="px-5 py-3 flex items-start gap-3 text-sm">
            <div className={`w-2 h-2 rounded-full ${dot} mt-1.5 flex-shrink-0`} />
            <div className="flex-1">
              <div>{summary}</div>
              <div className="text-xs text-stone-500 mt-0.5">{relTime(r.at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function dotFor(action: string): string {
  switch (action) {
    case "create":
      return "bg-emerald-500";
    case "overwrite":
      return "bg-amber-500";
    case "void":
    case "delete_vc":
      return "bg-red-500";
    case "recompute":
      return "bg-blue-500";
    case "apply_weights":
      return "bg-purple-500";
    default:
      return "bg-stone-300";
  }
}

function summarize(r: AuditRow, streams: StreamConfig[]): React.ReactNode {
  if (r.entity_type === "observation") {
    const after = r.after_json as { stream_id?: string; value?: { val?: unknown; reason?: string } } | null;
    const before = r.before_json as { value?: { val?: unknown } } | null;
    const stream = streamLabel(streams, after?.stream_id ?? "");
    const newVal = formatValue(after?.value?.val);
    const oldVal = before?.value?.val !== undefined ? formatValue(before.value.val) : null;
    const caseRef = r.case_ref_for_obs;
    return (
      <span>
        <span className="font-medium">{r.actor_position}</span>{" "}
        {r.action === "overwrite" ? "overwrote" : "entered"} <span className="font-medium">{stream}</span>
        {oldVal !== null ? (
          <>
            {" "}
            <span className="text-stone-400">{oldVal}</span> → <span className="font-medium">{newVal}</span>
          </>
        ) : (
          <>
            {" "}= <span className="font-medium">{newVal}</span>
          </>
        )}
        {caseRef && (
          <>
            {" "}for <span className="font-mono text-xs text-stone-600">{caseRef}</span>
          </>
        )}
        {after?.value?.reason && (
          <div className="text-xs text-stone-500 italic mt-0.5">&ldquo;{after.value.reason}&rdquo;</div>
        )}
      </span>
    );
  }

  if (r.entity_type === "vc" && r.action === "recompute") {
    const after = r.after_json as
      | { composite?: number; tier?: string; trigger?: string }
      | null;
    return (
      <span>
        <span className="font-medium">Recompute</span>{" "}
        ({after?.trigger ?? "manual"}) ·{" "}
        composite{" "}
        {typeof after?.composite === "number" ? after.composite.toFixed(2) : "—"}{" "}
        · tier <span className="font-medium">{after?.tier ?? "—"}</span>
      </span>
    );
  }

  if (r.entity_type === "case") {
    return (
      <span>
        <span className="font-medium">{r.actor_position}</span>{" "}
        {r.action === "create" ? "created" : r.action} case{" "}
        <span className="font-mono text-xs text-stone-600">{(r.after_json as { case_ref?: string } | null)?.case_ref ?? r.entity_id}</span>
      </span>
    );
  }

  // Generic fallback.
  return (
    <span>
      <span className="font-medium">{r.actor_position}</span> · {r.action} on {r.entity_type}
    </span>
  );
}
