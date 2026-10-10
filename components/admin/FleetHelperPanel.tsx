"use client";

/**
 * FleetHelperPanel — Bench's read-only view of the room-Mac helper fleet (TS-H13 #50), from GET /api/admin/fleet: per device its last long-poll, command counts and the newest
 * commands with their outcomes. Polls every 5 s while the tab is visible (a result shows within about 5 s). It queues, sends and changes nothing. Renders nothing until a device
 * has registered, so the Bench is unchanged before the helper ships. No signatures, keys or result details are ever in the data it gets.
 */
import * as React from "react";

type Device = { device_id: string; room_id: string; room_name: string | null; machine: string; status: string; helper_version: string | null; last_poll_age_s: number | null; commands: { queued: number; delivered: number; done: number; expired: number } };
type Command = { cmd_id: string; device_id: string; verb: string; state: string; issued_at: string; outcome: string | null; reason: string | null };
type Data = { devices: Device[]; commands: Command[] };

export function FleetHelperPanel() {
  const [data, setData] = React.useState<Data | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stop = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch("/api/admin/fleet", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Data;
        if (!stop) { setData(j); setErr(null); }
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : "error");
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  if (err) return <p className="text-caption text-warning-700" role="alert">Helper fleet could not be read ({err}).</p>;
  if (!data || data.devices.length === 0) return null;
  return (
    <details className="rounded-lg border border-even-ink-200 p-3 text-caption" data-testid="fleet-helper-panel">
      <summary className="cursor-pointer text-even-ink-500">Helper fleet ({data.devices.length} device{data.devices.length === 1 ? "" : "s"})</summary>
      <ul className="mt-2 space-y-2">
        {data.devices.map((d) => (
          <li key={d.device_id} data-testid={`fleet-device-${d.device_id}`}>
            <span className="font-semibold text-even-navy-800">{d.room_name ?? d.room_id}</span> — {d.status}, helper {d.helper_version ?? "?"}, last poll{" "}
            {d.last_poll_age_s === null ? "never" : `${d.last_poll_age_s}s ago`}; queued {d.commands.queued}, delivered {d.commands.delivered}, done {d.commands.done}, expired {d.commands.expired}
            <ul className="ml-4 list-disc">
              {data.commands.filter((c) => c.device_id === d.device_id).slice(0, 5).map((c) => (
                <li key={c.cmd_id}>{c.verb}: {c.outcome ? `${c.outcome}${c.reason ? ` (${c.reason})` : ""}` : c.state}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}
