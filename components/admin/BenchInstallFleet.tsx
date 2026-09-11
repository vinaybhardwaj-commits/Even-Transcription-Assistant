"use client";

/**
 * BenchInstallFleet — the third Bench card (Install and Fleet PRD §6, D3/D11/D13; mockup 1–5).
 *
 * Two views in one card, because they are two moments of one job. The FLEET is one row per room
 * and answers "which room is dark". The CHECKLIST is one Mac being provisioned and answers "what
 * is left to do at this machine". Copy install command moves between them.
 *
 * ─── THE RULE THIS COMPONENT IS BUILT AROUND ─────────────────────────────────────────────
 * THE PAGE NEVER ASSERTS COMPLETION FROM ITS OWN ACTIONS. Every step state comes out of
 * `deriveSteps` in lib/room-install-view.ts, reading an install row that a POLL FROM THE MAC
 * wrote. The single exception is step 1, whose input is `copiedAt` — a clipboard write — and
 * which is labelled "Command copied" and never "Installed".
 *
 * That is why there is no optimistic state anywhere below. Copy mints a token and records the
 * instant; it does not mark anything installed, and it does not pretend the paste has happened.
 * If the operator never opens Terminal, this card says so for thirty minutes and then says the
 * room is not installed.
 *
 * ─── WHY THE CHECKLIST HAS NO ENDPOINT OF ITS OWN ────────────────────────────────────────
 * Both views read GET /api/admin/bench/fleet. The steps are derived from the same install row
 * the table renders, so a second route would be a second place for one truth to come from. Only
 * the cadence differs: 20 s for the table, 3 s for the open checklist, both matching Rooms Live.
 */

import * as React from "react";
import {
  CHECKLIST_POLL_MS,
  FLEET_POLL_MS,
  deriveRow,
  deriveSteps,
  fmtSeen,
  releaseForRow,
  type DiskLevel,
  type FleetPayload,
  type FleetRow,
  type InstallView,
  type ReleaseView,
  type RowView,
  type Step,
  type UnassignedInstall,
} from "@/lib/room-install-view";

/** A3 — the in-table action class BenchClient already uses. 44px minimum touch target. */
const ROW_BTN =
  "min-h-11 px-3 py-2 rounded-lg text-label text-even-blue-700 hover:bg-even-ink-50 active:bg-even-ink-100 disabled:opacity-40 disabled:hover:bg-transparent";

type Minted = {
  room_id: string;
  room_name: string;
  install_id: string;
  command: string;
  expires_at: string;
  /** The instant the clipboard write happened. Step 1's ONLY input. */
  copied_at: string;
  /** False when the clipboard API refused and the operator must copy the field by hand. */
  clipboard_ok: boolean;
};

export function BenchInstallFleet() {
  const [fleet, setFleet] = React.useState<FleetPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The open checklist, or null for the fleet table. Holds the minted command verbatim. */
  const [open, setOpen] = React.useState<Minted | null>(null);
  /** Ages tick locally so the wall clock moves smoothly between polls, the Rooms Live pattern. */
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bench/fleet", { cache: "no-store" });
      if (!res.ok) {
        setError("Could not read the fleet.");
        return;
      }
      setFleet((await res.json()) as FleetPayload);
      setError(null);
    } catch {
      setError("Could not read the fleet.");
    }
  }, []);

  // ── Polling ───────────────────────────────────────────────────────────────────────────────
  // 20 s for the fleet, 3 s while a checklist is open (§6), and NEITHER runs while the tab is
  // hidden — the B1 rule the other two Bench polls already follow. A tablet in a pocket must not
  // fetch the whole fleet all day.
  React.useEffect(() => {
    void load();
    const period = open ? CHECKLIST_POLL_MS : FLEET_POLL_MS;
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, period);
    return () => clearInterval(t);
  }, [load, open]);

  React.useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // The header's release is the STABLE one and stays that way (§5.8: the header is unchanged).
  // Each ROW is measured against its own channel's release inside FleetTable (Fix 1, F6).
  const release = fleet?.latest_release ?? null;
  const rows = fleet?.rows ?? [];

  // ── Copy install command ──────────────────────────────────────────────────────────────────
  // Mints a token, puts the returned `command` on the clipboard UNCHANGED, and opens the
  // checklist. The string is never rebuilt here: the route that has to honour the token is the
  // one that composed it.
  const onCopy = React.useCallback(
    async (row: FleetRow) => {
      setBusy(row.room_id);
      setError(null);
      try {
        const res = await fetch(`/api/admin/rooms/${encodeURIComponent(row.room_id)}/bootstrap-token`, {
          method: "POST",
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "could not mint an install command");

        let clipboardOk = false;
        try {
          await navigator.clipboard.writeText(j.command);
          clipboardOk = true;
        } catch {
          // Falls back to the selectable field rendered below. Not silent: `clipboard_ok` drives
          // a visible instruction, because an operator who thinks they copied and did not would
          // paste the wrong thing into a Terminal on a clinic Mac.
          clipboardOk = false;
        }

        setOpen({
          room_id: row.room_id,
          room_name: row.room_name,
          install_id: j.install_id,
          command: j.command,
          expires_at: j.expires_at,
          copied_at: new Date().toISOString(),
          clipboard_ok: clipboardOk,
        });
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const onRetire = React.useCallback(
    async (install: InstallView) => {
      setBusy(install.install_id);
      try {
        const res = await fetch(`/api/admin/installs/${encodeURIComponent(install.install_id)}/retire`, {
          method: "POST",
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "retire failed");
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // B2-D5. "Move to stable" writes `assigned_channel` and nothing else. The row keeps saying
  // `channel test` until the Mac itself reports `stable` — no optimistic state, the rule this
  // component is built around.
  const onAssignStable = React.useCallback(
    async (install: InstallView) => {
      setBusy(install.install_id);
      try {
        const res = await fetch(
          `/api/admin/installs/${encodeURIComponent(install.install_id)}/assign-channel`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channel: "stable" }),
          },
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "could not assign stable");
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const onWithdraw = React.useCallback(
    async (rel: ReleaseView) => {
      setBusy(rel.id);
      try {
        const res = await fetch(`/api/admin/releases/${encodeURIComponent(rel.id)}/withdraw`, {
          method: "POST",
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message ?? "withdraw failed");
        void load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // ── The open checklist (mockup states 2, 2b, 3, 4) ────────────────────────────────────────
  if (open) {
    const row = rows.find((r) => r.room_id === open.room_id) ?? null;
    // The install the checklist watches is the one this copy minted, wherever it now sits: still
    // pending, or already enrolled and bound. Matched BY ID, never by position — a second copy
    // for the same room mints a second install and the open checklist must keep watching its own.
    const watched =
      [row?.pending, row?.install, row?.last_retired].find((i) => i?.install_id === open.install_id) ?? null;
    return (
      <section className="eta-card p-5">
        <InstallHead
          roomName={open.room_name}
          onBack={() => {
            setOpen(null);
            void load();
          }}
        />
        <CommandBox minted={open} nowMs={nowMs} />
        <Steps steps={deriveSteps({ install: watched ?? null, copiedAt: open.copied_at })} />
        {error && (
          <p className="mt-3 text-caption text-danger-700" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  // ── The fleet table (mockup states 1 and 5) ───────────────────────────────────────────────
  const installCount = rows.filter((r) => r.install).length;
  return (
    <section className="eta-card p-5 overflow-x-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-heading text-even-navy-800">Install and fleet</h2>
          <p className="text-caption text-even-ink-400">
            Which Mac runs which room. Machine facts come from the app&apos;s own poll — nothing on
            this card is typed by hand.
          </p>
        </div>
        <ReleaseHeader release={release} busy={busy} onWithdraw={onWithdraw} />
      </div>

      {error && (
        <p className="mb-3 text-caption text-danger-700" role="alert">
          {error}
        </p>
      )}
      {fleet?.degraded?.length ? (
        <p className="mb-3 text-caption text-warning-700" role="status">
          Partial read: {fleet.degraded.join(" · ")}
        </p>
      ) : null}

      {/* STATE 5 — the empty release table IS the feature gate. No flag sits beside it. */}
      {!release && (
        <div className="mb-4 rounded-xl border border-even-ink-100 bg-even-ink-50 px-4 py-3">
          <p className="text-label text-even-navy-800">No release published yet</p>
          <p className="mt-1 text-caption text-even-ink-500">
            Upload the zip to Vercel Blob, then <code>POST /api/admin/releases</code>. Version and
            sha256 are read from the artifact, never typed. Until a release row exists, no Mac can
            be given an install command and every Copy install command button below stays off.
          </p>
        </div>
      )}

      <FleetTable
        fleet={fleet}
        nowMs={nowMs}
        busy={busy}
        onCopy={onCopy}
        onRetire={onRetire}
        onAssignStable={onAssignStable}
      />

      <p className="mt-3 text-caption text-even-ink-400">
        {rows.length} room{rows.length === 1 ? "" : "s"} · {installCount} install
        {installCount === 1 ? "" : "s"}
        {fleet ? ` · read ${fmtSeen(fleet.now, nowMs)}` : ""}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The table (exported so a fixture can render it without a fetch)
// ---------------------------------------------------------------------------

/**
 * The fleet table plus the Unassigned list (B2-D3). One `<tr data-fleet-row>` per room — the bound
 * install is the row, retired installs are a count on it — and one `<li data-unassigned>` per
 * install that fits no room. PRESENTATIONAL: every word comes from `deriveRow`.
 */
export function FleetTable({
  fleet,
  nowMs,
  busy,
  onCopy,
  onRetire,
  onAssignStable,
}: {
  fleet: FleetPayload | null;
  nowMs: number;
  busy: string | null;
  onCopy: (r: FleetRow) => void;
  onRetire: (i: InstallView) => void;
  onAssignStable: (i: InstallView) => void;
}) {
  const release = fleet?.latest_release ?? null;
  const releases = fleet?.releases ?? null;
  const rows = fleet?.rows ?? [];
  const unassigned = fleet?.unassigned ?? [];
  return (
    <>
      <table className="w-full text-body">
        <thead>
          <tr className="text-left border-b border-even-ink-100">
            {["Room", "Machine", "App", "Last seen", "Microphone", "Tape", ""].map((h, i) => (
              <th
                key={i}
                className="py-2 px-2.5 text-meta uppercase tracking-wider text-even-ink-400 font-semibold"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fleet === null ? (
            <tr>
              <td colSpan={7} className="py-6 px-2.5 text-caption text-even-ink-400">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-6 px-2.5 text-caption text-even-ink-400">
                No rooms yet. Create one in the Rooms card below.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <FleetRowView
                key={row.room_id}
                row={row}
                view={deriveRow({ row, latestRelease: releaseForRow(row, releases), nowMs })}
                release={release}
                nowMs={nowMs}
                busy={busy}
                onCopy={onCopy}
                onRetire={onRetire}
                onAssignStable={onAssignStable}
              />
            ))
          )}
        </tbody>
      </table>
      {unassigned.length > 0 && <UnassignedList items={unassigned} />}
    </>
  );
}

const UNASSIGNED_WHY: Record<UnassignedInstall["why"], string> = {
  room_not_on_card: "room not on this card",
  never_enrolled: "command never pasted",
  second_bound: "second live install in one room",
};

/** B2-D3. Installs that belong on no row, each listed once. Read-only: nothing here acts. */
function UnassignedList({ items }: { items: UnassignedInstall[] }) {
  return (
    <div className="mt-4 rounded-xl border border-even-ink-100 px-4 py-3">
      <p className="text-label text-even-navy-800">Unassigned ({items.length})</p>
      <ul className="mt-1">
        {items.map((u) => (
          <li key={u.install_id} data-unassigned className="text-caption text-even-ink-500">
            <span className="font-mono">{u.install_id}</span> · {u.hostname ?? "hostname not reported"} ·{" "}
            {UNASSIGNED_WHY[u.why]}
            {u.retired_at ? ` · retired ${fmtDay(u.retired_at)}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

const fmtDay = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const DISK_TONE: Record<DiskLevel, string> = {
  ok: "text-success-700",
  amber: "text-warning-700",
  red: "text-danger-700",
  unknown: "text-even-ink-400",
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ReleaseHeader({
  release,
  busy,
  onWithdraw,
}: {
  release: ReleaseView | null;
  busy: string | null;
  onWithdraw: (r: ReleaseView) => void;
}) {
  if (!release) {
    return (
      <div className="text-right">
        <p className="text-label text-even-ink-500">No release published yet</p>
        <p className="text-caption text-even-ink-400">nothing to install</p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <p className="text-label text-even-navy-800 tabular-nums">
          {release.version}{" "}
          <span className="ml-1 inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-even-ink-100 text-even-ink-500">
            {release.channel}
          </span>
        </p>
        <p className="text-caption text-even-ink-400">
          published{" "}
          {new Date(release.published_at).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          by {release.published_by}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onWithdraw(release)}
        disabled={busy === release.id}
        className={`${ROW_BTN} text-danger-700`}
        title="Withdraw takes this build out of circulation. It removes no software from any Mac."
      >
        {busy === release.id ? "Withdrawing…" : "Withdraw"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One fleet row
// ---------------------------------------------------------------------------

const PILL: Record<string, string> = {
  ok: "bg-success-100 text-success-700",
  warn: "bg-warning-100 text-warning-700",
  bad: "bg-danger-100 text-danger-700",
  idle: "bg-even-ink-100 text-even-ink-500",
};

function Pill({ tone, children }: { tone: keyof typeof PILL; children: React.ReactNode }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-caption font-semibold ${PILL[tone]}`}>
      {children}
    </span>
  );
}

const wordTone = (w: string): keyof typeof PILL =>
  w === "installed" ? "ok" : w === "needs re-enrol" ? "bad" : w === "update pending" ? "warn" : "idle";

function FleetRowView({
  row,
  view,
  release,
  nowMs,
  busy,
  onCopy,
  onRetire,
  onAssignStable,
}: {
  row: FleetRow;
  view: RowView;
  release: ReleaseView | null;
  nowMs: number;
  busy: string | null;
  onCopy: (r: FleetRow) => void;
  onRetire: (i: InstallView) => void;
  onAssignStable: (i: InstallView) => void;
}) {
  const i = row.install;
  const attn = view.state === "needs_attention";
  const seenMs = i?.last_seen_at ? nowMs - new Date(i.last_seen_at).getTime() : null;
  const seenTone =
    seenMs === null ? "text-even-ink-400" : seenMs > 10 * 60_000 ? "text-danger-700" : "text-success-700";
  const earlier = row.earlier ?? [];

  return (
    <tr data-fleet-row className={`border-b border-even-ink-50 align-top ${attn ? "bg-warning-50" : ""}`}>
      <td className="py-2.5 px-2.5">
        <p className="font-semibold text-even-navy-800">{row.room_name}</p>
        <p className="text-caption text-even-ink-400">{row.room_slug}</p>
        {/* B2-D3. Every re-enrolment paste retires one install. They are a count on the row, with
            the ids behind a disclosure, never a row each — the card answers "which Mac runs which
            room", and twelve retired lines under nine rooms stopped answering it. */}
        {earlier.length > 0 && (
          <details data-earlier className="mt-1 text-caption text-even-ink-400">
            <summary className="cursor-pointer">
              {earlier.length} earlier install{earlier.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1">
              {earlier.map((e) => (
                <li key={e.install_id}>
                  <span className="font-mono">{e.install_id}</span> · retired {fmtDay(e.retired_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {view.words.map((w) => (
            <Pill key={w} tone={wordTone(w)}>
              {w}
            </Pill>
          ))}
          {view.state === "enrolling" && <Pill tone="warn">enrolling</Pill>}
          {/* STATE C (R3-7). Only a FAILED update speaks. Nothing new appears here while updates
              work, which is the whole of R3-7 — a card that narrated every success would train
              the eye to skip the one line that matters. */}
          {view.update_failed && <Pill tone="bad">update failed</Pill>}
          {/* STATE E (R3-8). A tag, not a pill: the channel is not a verdict on the room, it is
              which shelf this Mac takes its builds from. Reported from its own config.json. */}
          {view.channel_label && (
            <span className="inline-block rounded border border-even-ink-100 px-1.5 py-0.5 font-mono text-caption text-even-ink-500">
              {view.channel_label}
            </span>
          )}
        </div>
      </td>

      <td className="py-2.5 px-2.5">
        {i ? (
          <>
            <p className="font-medium text-even-navy-800">{i.hostname ?? "hostname not reported"}</p>
            <p className="text-caption text-even-ink-400">
              {[i.hardware_model, i.os_version].filter(Boolean).join(" · ") || "—"}
            </p>
            <p className="text-caption text-even-ink-400 font-mono">{i.install_id}</p>
            {view.session_label && (
              <p className={`text-caption ${view.session_warn ? "text-warning-700" : "text-even-ink-400"}`}>
                {view.session_label}
              </p>
            )}
            {/* B2-D6. Free disk in GB with one decimal, coloured: amber under 20 GB, red under 5.
                WARN ONLY — nothing is deleted in B2. A missing reading says so in grey and is never
                green: the app omits the field when it cannot read the volume and never sends 0. */}
            <p data-disk={view.disk_level} className={`text-caption ${DISK_TONE[view.disk_level]}`}>
              {view.disk_text}
            </p>
          </>
        ) : (
          <p className="text-caption text-even-ink-400">
            {view.state === "enrolling"
              ? "Install command copied, waiting for the first poll"
              : view.state === "retired"
                ? "The Mac that was bound here has been retired"
                : "No Mac bound to this room"}
          </p>
        )}
      </td>

      <td className="py-2.5 px-2.5">
        {i?.app_version ? (
          <>
            <span className="tabular-nums text-even-navy-800 whitespace-nowrap">{i.app_version}</span>
            <span className="block text-caption text-even-ink-400 whitespace-nowrap">
              {view.version_hint}
            </span>
          </>
        ) : (
          <span className="text-even-ink-400">—</span>
        )}
        {/* STATE C, WHERE V PUT IT (9 September 2026). Under the version that did not change,
            because a failed update is a fact about the version. The sentence is composed in
            lib/room-install-view.ts from what the last poll reported and nothing else — the page
            never asserts an outcome of its own. */}
        {view.update_note && (
          <p className="mt-1.5 max-w-[34ch] whitespace-normal text-caption text-danger-700">
            {view.update_note}
          </p>
        )}
        {/* B2-D5. One-way: offered only on a Mac that reports `test`. Once pressed, the row says
            so until the Mac itself reports `stable` — the card never claims the move happened. */}
        {i && view.assigned_pending && (
          <p className="mt-1 text-caption text-warning-700 whitespace-nowrap">
            assigned stable · waiting for the Mac
          </p>
        )}
        {i && view.can_move_to_stable && (
          <button
            type="button"
            onClick={() => onAssignStable(i)}
            disabled={busy === i.install_id}
            className={ROW_BTN}
            title="Tells this Mac to take its builds from stable at its next poll. The server never moves a Mac onto test."
          >
            {busy === i.install_id ? "Assigning…" : "Move to stable"}
          </button>
        )}
      </td>

      <td className={`py-2.5 px-2.5 whitespace-nowrap text-caption ${seenTone}`}>
        {fmtSeen(i?.last_seen_at ?? null, nowMs)}
      </td>

      <td className="py-2.5 px-2.5 text-caption">
        {!i ? (
          <span className="text-even-ink-400">—</span>
        ) : i.mic_state === "authorized" ? (
          <span className="text-success-700">authorized</span>
        ) : i.mic_state === "denied" ? (
          <span className="text-danger-700">denied</span>
        ) : (
          <span className="text-even-ink-400">not reported</span>
        )}
        {/* The DEVICE, under the PERMISSION. They are different facts and a room can have one
            without the other: `authorized` says macOS let the app open an input, this says which
            input it opened. A room listening to the wrong microphone looks perfect on permission
            alone, which is why the name sits here rather than in a detail view. */}
        {i && (
          <span className="block text-even-ink-400">
            {i.input_device_name ?? "device not reported"}
          </span>
        )}
        {/* B2-D7. Two read-only numbers beside the device: the loudest sample and how much of the
            window was bit-exact zero. No threshold, no colour — OPD 3 read 45.8 % zero and nobody
            could see it; seeing it is the whole of B2. Absent until the app reports them. */}
        {i && (view.peak !== null || view.zero_ratio !== null) && (
          <span data-levels className="block text-even-ink-400 tabular-nums whitespace-nowrap">
            peak {view.peak === null ? "—" : view.peak.toFixed(2)} · zero{" "}
            {view.zero_ratio === null ? "—" : `${(view.zero_ratio * 100).toFixed(1)} %`}
          </span>
        )}
        {/* B2-D10. Every input the Mac can see, the default marked. READ-ONLY: R4 owns choosing. */}
        {i && view.input_devices && view.input_devices.length > 0 && (
          <ul data-devices className="mt-0.5 text-even-ink-400">
            {view.input_devices.map((d) => (
              <li key={d.uid}>
                {d.name}
                {d.is_default ? " (default)" : ""}
              </li>
            ))}
          </ul>
        )}
      </td>

      {/* STATES A AND B (R3-3). Three answers, not two: an idle room with nobody in it reads
          `idle, no session` and is not a fault, while a room with a session open and no audio
          reaching the tape reads `recording, not advancing` and still goes to attention exactly
          as it does today. `deriveRow` decides the words; this cell only colours them. */}
      <td className="py-2.5 px-2.5 whitespace-nowrap text-caption">
        {!i || !view.tape_label ? (
          <span className="text-even-ink-400">—</span>
        ) : i.tape_advancing ? (
          <span className="text-success-700">{view.tape_label}</span>
        ) : i.session_open === true ? (
          <span className="text-danger-700">{view.tape_label}</span>
        ) : (
          <span className="text-even-ink-400">{view.tape_label}</span>
        )}
      </td>

      <td className="py-2.5 px-2.5">
        <span className="flex flex-col items-start">
          <button
            type="button"
            onClick={() => onCopy(row)}
            disabled={!release || busy === row.room_id}
            className={ROW_BTN}
            title={
              release
                ? "Mints a single-use install command for this room, valid 30 minutes. The same action re-enrols a Mac."
                : "No release published yet — there is nothing to install."
            }
          >
            {busy === row.room_id ? "Minting…" : "Copy install command"}
          </button>
          {i && (
            <button
              type="button"
              onClick={() => onRetire(i)}
              disabled={busy === i.install_id}
              className={`${ROW_BTN} text-even-ink-600`}
              title="Marks this install retired and frees the room. It removes no software from the Mac."
            >
              {busy === i.install_id ? "Retiring…" : "Retire"}
            </button>
          )}
        </span>
        {view.attention.map((a) => (
          <p key={a} className="mt-1 max-w-xs text-caption text-warning-700">
            {a}
          </p>
        ))}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// The checklist view
// ---------------------------------------------------------------------------

function InstallHead({ roomName, onBack }: { roomName: string; onBack: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div>
        <p className="text-caption text-even-ink-400">
          Install and fleet / <b className="text-even-navy-800">{roomName}</b>
        </p>
        <h2 className="text-heading text-even-navy-800">Install on this Mac</h2>
      </div>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-caption text-even-ink-500">
          <span className="w-1.5 h-1.5 rounded-full bg-success-500 animate-pulse" />
          reading this Mac every 3 s
        </span>
        <button type="button" onClick={onBack} className={ROW_BTN}>
          Back to fleet
        </button>
      </div>
    </div>
  );
}

/**
 * The command box.
 *
 * THE STRING IS RENDERED EXACTLY AS THE MINT ROUTE RETURNED IT, and it is always visible in a
 * selectable field — not only when the clipboard API failed. An operator who is about to paste a
 * line into a Terminal on a clinic Mac should be able to see what they are pasting, and a copy
 * that silently failed is otherwise indistinguishable from one that worked.
 */
function CommandBox({ minted, nowMs }: { minted: Minted; nowMs: number }) {
  const [recopied, setRecopied] = React.useState(false);
  const msLeft = new Date(minted.expires_at).getTime() - nowMs;
  const minLeft = Math.max(0, Math.floor(msLeft / 60_000));

  return (
    <div className="mb-4 rounded-xl border border-even-ink-100 bg-even-ink-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={minted.command}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Install command"
          className="flex-1 min-w-0 min-h-11 rounded-lg border border-even-ink-200 bg-even-white px-3 py-2 font-mono text-caption text-even-navy-800"
        />
        <button
          type="button"
          className="eta-btn-primary min-h-11 px-4 py-2 text-label"
          onClick={() => {
            navigator.clipboard.writeText(minted.command).then(
              () => {
                setRecopied(true);
                // Back to "Copy again" shortly. A button stuck on "Copied" stops being a report
                // of what just happened and becomes a label, which is the one thing this card
                // must never let a page-side action turn into.
                setTimeout(() => setRecopied(false), 2000);
              },
              () => setRecopied(false),
            );
          }}
        >
          {recopied ? "Copied" : "Copy again"}
        </button>
      </div>
      <p className="mt-2 text-caption text-even-ink-500">
        Paste in Terminal on the room Mac and press Return. Single use, valid 30 minutes
        {msLeft > 0 ? ` — ${minLeft} min left` : " — expired, copy again for a fresh command"}.
      </p>
      {!minted.clipboard_ok && (
        <p className="mt-1 text-caption text-warning-700" role="alert">
          This browser refused the clipboard. Select the command above and copy it by hand.
        </p>
      )}
      <p className="mt-1 text-caption text-even-ink-400 font-mono">{minted.install_id}</p>
    </div>
  );
}

const STEP_PILL: Record<Step["state"], { tone: keyof typeof PILL; word: string }> = {
  done: { tone: "ok", word: "done" },
  waiting: { tone: "idle", word: "waiting" },
  blocked: { tone: "bad", word: "blocked" },
};

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s) => {
        const pill = STEP_PILL[s.state];
        return (
          <li
            key={s.n}
            className={`flex gap-3 rounded-xl border px-4 py-3 ${
              s.state === "blocked"
                ? "border-danger-200 bg-danger-50"
                : s.state === "done"
                  ? "border-even-ink-100 bg-even-white"
                  : "border-even-ink-100 bg-even-ink-50"
            }`}
          >
            <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-even-ink-100 text-caption font-semibold text-even-ink-600">
              {s.n}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-label text-even-navy-800">{s.title}</h3>
                <Pill tone={pill.tone}>{pill.word}</Pill>
              </div>
              {s.did && <p className="mt-1 text-caption text-even-ink-600">{s.did}</p>}
              {s.note && (
                <p
                  className={`mt-1 text-caption ${
                    s.tone === "bad"
                      ? "text-danger-700"
                      : s.tone === "warn"
                        ? "text-warning-700"
                        : "text-even-ink-400"
                  }`}
                >
                  {s.note}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
