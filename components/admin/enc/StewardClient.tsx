"use client";

import * as React from "react";
import Link from "next/link";
import type { StewardItem, StewardRun, StewardSettings } from "@/lib/enc/queries";
import { spendMeter, splitItems } from "@/lib/enc/view";

/**
 * /admin/steward (contract UI item 4): summary, items with Approve / Reject, questions, run history,
 * spend today vs cap, enable switch and mode.
 *
 * Writes go to the contract's admin session routes (W1 builds them; this file only calls the paths):
 *   PATCH /api/admin/steward/items/{id}  body {state: "approved" | "rejected"}   (documented: "Admin UI approve/reject: PATCH state")
 *   PATCH /api/admin/steward/settings    body {enabled?, mode?, daily_cap_usd?, model_id?}  (W1 route; mode "act" is 409)
 * The page is admin-gated by the server component; there is no per-role split in this app's admin.
 */
const card = "bg-even-white rounded-xl border border-even-ink-200 p-4";
const h = "text-label font-semibold text-even-navy-800 mb-2";
const btn = "min-h-11 px-4 rounded-xl text-label border disabled:opacity-50";

async function patchJson(url: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    let msg = `http_${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } | string };
      msg = typeof j.error === "string" ? j.error : (j.error?.message ?? msg);
    } catch {
      /* keep http status */
    }
    return msg;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function ItemCard({ item, onDecide, busy }: { item: StewardItem; onDecide?: (id: string, state: "approved" | "rejected") => void; busy: boolean }) {
  return (
    <li className="border-t border-even-ink-100 py-3 first:border-t-0" data-item-id={item.id}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium text-even-navy-800">{item.title}</p>
          <p className="text-[11px] text-even-ink-500 mt-0.5">
            {item.kind}
            {item.ist_date ? ` - ${item.ist_date}` : ""}
            {item.room_id ? <> - <Link href={`/admin/rooms/${item.room_id}${item.ist_date ? `/${item.ist_date}` : ""}`} className="text-even-blue-600 hover:underline">room</Link></> : null}
            {item.consult_uid ? <> - <Link href={`/admin/encounters/${item.consult_uid}`} className="text-even-blue-600 hover:underline">encounter</Link></> : null}
            {item.proposed_action ? ` - proposes ${item.proposed_action.type}` : ""}
          </p>
          {item.body_md ? <p className="text-caption text-even-navy-800/80 mt-1 whitespace-pre-wrap">{item.body_md}</p> : null}
          {item.state !== "open" ? (
            <p className="text-[11px] text-even-ink-500 mt-1">state {item.state}{item.decided_by ? ` by ${item.decided_by}` : ""}</p>
          ) : null}
        </div>
        {onDecide && item.state === "open" ? (
          <div className="flex gap-2 shrink-0">
            <button type="button" disabled={busy} onClick={() => onDecide(item.id, "approved")} className={`${btn} bg-even-navy-800 text-even-white border-even-navy-800`}>
              Approve
            </button>
            <button type="button" disabled={busy} onClick={() => onDecide(item.id, "rejected")} className={`${btn} bg-even-white text-even-navy-800 border-even-ink-200`}>
              Reject
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function StewardClient({
  settings,
  spendToday,
  items,
  runs,
}: {
  settings: StewardSettings;
  spendToday: number;
  items: StewardItem[];
  runs: StewardRun[];
}) {
  const [localItems, setLocalItems] = React.useState(items);
  const [localSettings, setLocalSettings] = React.useState(settings);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { decisions, questions, decided } = splitItems(localItems);
  const meter = spendMeter(spendToday, localSettings.daily_cap_usd);
  const latest = runs[0] ?? null;

  const decide = async (id: string, state: "approved" | "rejected") => {
    setBusy(true);
    setError(null);
    const err = await patchJson(`/api/admin/steward/items/${id}`, { state });
    if (err) setError(`Could not save the decision: ${err}`);
    else setLocalItems((cur) => cur.map((it) => (it.id === id ? { ...it, state } : it)));
    setBusy(false);
  };

  const setSetting = async (key: "enabled" | "mode", value: boolean | string) => {
    setBusy(true);
    setError(null);
    const err = await patchJson("/api/admin/steward/settings", { [key]: value });
    if (err) setError(`Could not save the setting: ${err}`);
    else setLocalSettings((cur) => ({ ...cur, [key]: value }) as StewardSettings);
    setBusy(false);
  };

  const barTone = meter.tone === "alert" ? "bg-red-500" : meter.tone === "warn" ? "bg-amber-500" : "bg-green-600";

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="text-caption text-red-600">{error}</p> : null}

      <section className={card} aria-label="Controls">
        <p className={h}>Controls</p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 min-h-11 text-caption text-even-navy-800">
            <input
              type="checkbox"
              role="switch"
              aria-checked={localSettings.enabled}
              checked={localSettings.enabled}
              disabled={busy}
              onChange={(e) => void setSetting("enabled", e.target.checked)}
              className="h-5 w-5"
            />
            <span>{localSettings.enabled ? "Steward enabled" : "Steward disabled (kill switch)"}</span>
          </label>
          <label className="inline-flex items-center gap-2 text-caption text-even-navy-800">
            <span>Mode</span>
            <select
              value={localSettings.mode}
              disabled={busy}
              onChange={(e) => void setSetting("mode", e.target.value)}
              aria-label="Steward mode"
              className="min-h-11 px-3 rounded-lg border border-even-ink-200 bg-even-white text-even-navy-800"
            >
              <option value="advise">advise (suggestions only)</option>
              <option value="act">act</option>
            </select>
          </label>
        </div>
        <div className="mt-3">
          <p className="text-caption text-even-navy-800">
            Spend today ${spendToday.toFixed(2)}
            {localSettings.daily_cap_usd !== null ? ` of $${localSettings.daily_cap_usd.toFixed(2)} cap` : " (no cap set)"}
          </p>
          {meter.ratio !== null ? (
            <div className="h-2 mt-1 rounded bg-even-ink-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.ratio * 100)} aria-label="Spend against daily cap">
              <div className={`h-full ${barTone}`} style={{ width: `${meter.ratio * 100}%` }} />
            </div>
          ) : null}
          {localSettings.model_id ? <p className="text-[11px] text-even-ink-500 mt-1">model {localSettings.model_id}</p> : null}
        </div>
      </section>

      <section className={card} aria-label="Summary">
        <p className={h}>Today&apos;s summary</p>
        {latest?.summary_md ? (
          <>
            <p className="text-caption text-even-navy-800 whitespace-pre-wrap">{latest.summary_md}</p>
            <p className="text-[11px] text-even-ink-500 mt-1">run {latest.status}, {latest.started_at}</p>
          </>
        ) : (
          <p className="text-caption text-even-ink-500">No steward run yet.</p>
        )}
      </section>

      <section className={card} aria-label="Items">
        <p className={h}>Suggestions and actions ({decisions.length} open)</p>
        {decisions.length === 0 ? (
          <p className="text-caption text-even-ink-500">Nothing waiting for a decision.</p>
        ) : (
          <ul>{decisions.map((it) => <ItemCard key={it.id} item={it} onDecide={decide} busy={busy} />)}</ul>
        )}
      </section>

      <section className={card} aria-label="Questions">
        <p className={h}>Questions ({questions.length})</p>
        {questions.length === 0 ? (
          <p className="text-caption text-even-ink-500">No open questions.</p>
        ) : (
          <ul>{questions.map((it) => <ItemCard key={it.id} item={it} busy={busy} />)}</ul>
        )}
      </section>

      {decided.length > 0 ? (
        <section className={card} aria-label="Decided items">
          <p className={h}>Decided ({decided.length})</p>
          <ul>{decided.slice(0, 20).map((it) => <ItemCard key={it.id} item={it} busy={busy} />)}</ul>
        </section>
      ) : null}

      <section className={card} aria-label="Run history">
        <p className={h}>Run history</p>
        {runs.length === 0 ? (
          <p className="text-caption text-even-ink-500">No runs.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-caption min-w-[520px]">
              <thead className="text-left text-even-navy-800/60">
                <tr>
                  <th className="py-1 pr-3 font-medium">Started</th>
                  <th className="py-1 pr-3 font-medium">Mode</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Tokens in/out</th>
                  <th className="py-1 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-even-ink-100">
                    <td className="py-1 pr-3">{r.started_at}</td>
                    <td className="py-1 pr-3">{r.mode}</td>
                    <td className="py-1 pr-3">{r.status}</td>
                    <td className="py-1 pr-3">{r.tokens_in ?? "-"} / {r.tokens_out ?? "-"}</td>
                    <td className="py-1">{r.cost_usd !== null ? `$${r.cost_usd.toFixed(3)}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
