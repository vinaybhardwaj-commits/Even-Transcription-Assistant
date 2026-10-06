/**
 * lib/kiosk-health-rules.ts — bench "Needs attention" rules R11–R17, PURE (no IO), driven by the kiosk-health daemon's evidence.
 *
 * Input: one KioskHealthSnapshot per canonical machine (lib/kiosk-health-read.ts), the ext-health row per machine (the presence poller's view of the
 * same Mac), `asOf`, and whether the clinic is open. Output: AttentionItems that lib/fleet-attention.ts merges with R1–R10. Every rule is a function
 * of CURRENT evidence — an item exists exactly while its condition holds. A machine with no rows in the last 24 h (not enrolled / daemon never
 * installed / the read failed) produces NOTHING: absence of evidence is not an alert here, R1/R8/R10 cover a Mac that is down.
 *
 * R11 kiosk_asleep            red    the newest of power.sleep / power.darkwake / power.wake is a sleep or darkwake, its event ts is within 12 h of asOf, and
 *                             no heartbeat was received after sleep.ts + 180 s (a Mac that is heartbeating is awake, whatever pmset said).
 * R12 kiosk_health_silent     amber  enrolled (any row in 7 days), heartbeat older than 180 s, yet the presence poller still sees the Mac. 180 s..60 min reads
 *                             "silent Ns"; beyond 60 min "daemon stopped (last seen T)". Stays raised until the daemon is seen again or 7 days pass.
 *                             Not raised when R11 fired.
 * R13 audio_dead              red in clinic hours, amber otherwise: no default input on a system_profiler snapshot received within 2 h (the daemon emits
 *                             one every 30 min), or a recorder start failure in the last 10 min. audio.error hal_error rows alone never raise it.
 * R14 config_drift            amber  a field whose LATEST drift row (24 h) is unresolved, or a field with no drift row in 24 h that the newest drift.summary
 *                             (received within 24 h) lists.
 * R15 recovery_failed         red    watchdog/ladder outcome not_recovered within 60 min, no later power.wake.
 * R16 presence_cannot_run     red in clinic hours, amber otherwise. Raised while EITHER (a) the newest chrome.profile (received within 20 min) has
 *                             presence_ok === false — it stays raised for as long as the machine keeps reporting that, however old the chrome.alert is — OR
 *                             (b) a chrome.alert arrived within 15 min and no chrome.profile at or after the alert says presence_ok === true.
 *                             Held by (a), the reason / last used / guest come FROM THAT PROFILE: running false → "Chrome not running"; guest → "Chrome on Guest
 *                             profile"; else "ext_missing:<last_used>" when the profile's ext map holds no extension for last_used; else the newest chrome.alert's
 *                             reason when that alert is newer than the profile; else "presence_ok false". Under (b) alone the alert's reason is shown.
 *                             `since` under (a) is the start of the CURRENT episode: the earliest of the consecutive presence_ok=false chrome.profile rows ending at
 *                             the newest one (24 h of rows, newest 300), never a stale alert. Clears when the newest chrome.profile has presence_ok === true at
 *                             ts >= the alert's ts, or when the machine stops reporting (profile older than 20 min and alert older than 15 min).
 *                             Suppresses R8 (extension_missing) for that room: R16 is the explanation.
 *                             An "ext_missing:<profile>" reason gets its own action: the extension dir is empty in that profile, the fleet thread re-installs there.
 * R17 recorder_update_failing amber  a recorder self-update failed signature_mismatch in the last 24 h. FIRST-TAIL BACKFILL IS EXCLUDED: on its first tail the
 *                             daemon ships historical launchd.log lines, so recorder.log rows received within 10 min after the daemon's start heartbeat
 *                             (heartbeat payload.event === "start") of the SAME boot_id are not counted (done in the read, lib/kiosk-health-read.ts query 3).
 *                             With no start heartbeat known for the row's boot_id in the window, the row is kept.
 *
 * Time bases: `received_at` is the trusted arrival time and bounds every read window; `ts` is event time and orders events. pmset-log power rows can be
 * backfilled 12–17 h late (ts old, received_at now), so R11 judges a power event by its ts: a 15 h-old sleep that only just arrived is history, not news.
 */
import { fmtIst, type AttentionItem, type AttentionKind, type AttentionSeverity } from "@/lib/fleet-attention-format";
import type { ExtHealthRow } from "@/lib/encounter-windows/ext-health";
import type { KioskHealthSnapshot } from "@/lib/kiosk-health-read";

export const KH_ASLEEP_MAX_AGE_MS = 12 * 3_600_000;
export const KH_HEARTBEAT_AFTER_SLEEP_MS = 180_000;
export const KH_STOPPED_AFTER_S = 3600;
export const KH_AUDIO_FRESH_MS = 2 * 3_600_000;
export const KH_SUMMARY_FRESH_MS = 24 * 3_600_000;
export const KH_SILENT_AFTER_S = 180;
export const KH_RECOVERY_WINDOW_MS = 60 * 60_000;
export const KH_CHROME_ALERT_WINDOW_MS = 15 * 60_000;
/** R16 / R8 text: a chrome.profile received within this long is the machine's current Chrome state (the daemon emits one every 5 min or on change). */
export const KH_CHROME_PROFILE_FRESH_MS = 20 * 60_000;
export const KH_DRIFT_DETAIL_MAX = 4;
export const KH_RECORDER_LINE_MAX = 120;

export type KioskRoomRef = { room_id: string; room_name: string; machine?: string | null };

/** The small per-machine summary the fleet-attention response carries beside the items. */
export type KioskHealthSummary = {
  enrolled: boolean;
  last_heartbeat_received_at: string | null;
  last_power_kind: string | null;
  default_input_present: boolean | null;
  drift_fields: string[];
  chrome_presence_ok: boolean | null;
};

const clean = (s: string | null | undefined, max = 160): string =>
  (s ?? "").replace(/[\u0000-\u001f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Open drift fields, oldest first. A field is open when its latest drift row (24 h) is unresolved, OR it has no drift row at all and the newest
 * drift.summary (received within 24 h) lists it in `items`. A field that has a drift row is judged by that row alone, never by the summary.
 */
function openDrift(s: KioskHealthSnapshot, nowMs: number | null = null): Array<{ field: string; expected: string | null; actual: string | null; ts: string }> {
  const out = Object.values(s.last_drift_by_field)
    .filter((d) => d.change !== "resolved" && d.resolved !== true)
    .map((d) => ({ field: d.field, expected: d.expected, actual: d.actual, ts: d.ts }));
  const sum = s.last_drift_summary;
  if (sum && (nowMs === null || nowMs - Date.parse(sum.received_at) <= KH_SUMMARY_FRESH_MS)) {
    for (const i of sum.items) {
      if (i.field === "?" || s.last_drift_by_field[i.field] || out.some((o) => o.field === i.field)) continue;
      out.push({ field: i.field, expected: i.expected, actual: i.actual, ts: sum.ts });
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.field.localeCompare(b.field));
}

/** Per-machine summary for the response JSON, keyed by canonical machine. */
export function summarizeKioskHealth(snapshots: ReadonlyMap<string, KioskHealthSnapshot>, nowMs: number | null = null): Record<string, KioskHealthSummary> {
  const out: Record<string, KioskHealthSummary> = {};
  for (const [machine, s] of snapshots) {
    out[machine] = {
      enrolled: s.enrolled,
      last_heartbeat_received_at: s.last_heartbeat_received_at,
      last_power_kind: s.last_power?.kind ?? null,
      default_input_present: s.last_audio_devices ? s.last_audio_devices.default_input_present : null,
      drift_fields: openDrift(s, nowMs).map((d) => d.field),
      chrome_presence_ok: s.last_chrome_profile ? s.last_chrome_profile.presence_ok : null,
    };
  }
  return out;
}

/** The newest chrome.profile when it was received within 20 min of `nowMs` (and not from the future), else null. */
function freshChromeProfile(s: KioskHealthSnapshot | null | undefined, nowMs: number): NonNullable<KioskHealthSnapshot["last_chrome_profile"]> | null {
  const p = s?.last_chrome_profile;
  if (!p) return null;
  const rec = Date.parse(p.received_at);
  return Number.isFinite(rec) && nowMs - rec <= KH_CHROME_PROFILE_FRESH_MS && nowMs >= rec - 60_000 ? p : null;
}

/**
 * R8 (extension_missing) wording from the machine's own Chrome evidence. Returns null when no chrome.profile arrived within 20 min, AND when the newest one
 * shows nothing wrong (running, not Guest, presence_ok not false) — the caller then keeps R8's original wording unchanged. Otherwise `cause` replaces the
 * "Chrome is running" clause of the R8 detail and `action` replaces the install instruction. Branch order: presence_ok false (reason = newest chrome.alert's,
 * else "presence_ok false"), Chrome not running, Guest profile.
 */
export function extensionMissingAdvice(s: KioskHealthSnapshot | null | undefined, nowMs: number): { cause: string; action: string } | null {
  const p = freshChromeProfile(s, nowMs);
  if (!p) return null;
  const profile = clean(p.last_used ?? s?.last_chrome_alert?.last_used ?? "", 60) || "unknown";
  if (p.presence_ok === false) {
    const reason = clean(s?.last_chrome_alert?.reason, 80) || "presence_ok false";
    return { cause: `Extension cannot run: ${reason} (profile ${profile})`, action: "Repair the active Chrome profile (fleet thread)" };
  }
  if (p.running === false) return { cause: "Chrome not running", action: "Open Chrome on the kiosk (or wait for the Kiosk Bot)" };
  if (p.guest === true) return { cause: "Chrome is on the Guest profile; relaunch on a named profile", action: "Relaunch Chrome on the named clinic profile (fleet thread)" };
  return null;
}

/**
 * Where the current presence_ok=false episode began: the earliest ts of the unbroken run of presence_ok === false chrome.profile rows that ends at the newest
 * row. The newest row (query 1) is added when the 24 h history (query 2) does not carry it. null when the newest row is not false.
 */
function falseEpisodeStart(s: KioskHealthSnapshot): string | null {
  const newest = s.last_chrome_profile;
  if (!newest || newest.presence_ok !== false) return null;
  const rows = [...s.chrome_profile_history];
  if (!rows.some((r) => r.ts === newest.ts)) rows.push({ ts: newest.ts, received_at: newest.received_at, presence_ok: newest.presence_ok });
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || Date.parse(b.received_at) - Date.parse(a.received_at));
  let start = newest.ts;
  for (const r of rows) {
    if (Date.parse(r.ts) > Date.parse(newest.ts)) continue;
    if (r.presence_ok !== false) break;
    start = r.ts;
  }
  return start;
}

/** The kinds this file can raise, for tests and callers that need to tell kiosk items from R1–R10. */
export const KIOSK_HEALTH_KINDS: readonly AttentionKind[] = [
  "kiosk_asleep",
  "kiosk_health_silent",
  "audio_dead",
  "config_drift",
  "recovery_failed",
  "presence_cannot_run",
  "recorder_update_failing",
];

export function kioskHealthItems(
  snapshots: ReadonlyMap<string, KioskHealthSnapshot>,
  extHealthByMachine: ReadonlyMap<string, ExtHealthRow>,
  asOf: string,
  clinicOpen: boolean,
  roomByMachine?: ReadonlyMap<string, KioskRoomRef>,
): AttentionItem[] {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) return [];
  const items: AttentionItem[] = [];

  for (const [machine, s] of snapshots) {
    if (!s.enrolled) continue;
    const ext = extHealthByMachine.get(machine) ?? null;
    const ref = roomByMachine?.get(machine);
    const room_id = ref?.room_id ?? ext?.room_id ?? s.room_id ?? machine;
    const room_name = ref?.room_name ?? ext?.room_name ?? machine;
    const name = room_name;
    const mk = (kind: AttentionKind, severity: AttentionSeverity, since: string, detail: string, action: string): void => {
      items.push({ room_id, room_name, machine: ref?.machine ?? machine, kind, since, detail, action, severity });
    };
    const sevClinic: AttentionSeverity = clinicOpen ? "red" : "amber";

    // R11 — ASLEEP. The newest sleep-state event by EVENT time is a sleep or a darkwake (nothing woke the Mac after it), that event happened within the
    // last 12 h (a backfilled 15 h-old sleep that only just arrived is history), and the daemon has not heartbeated since sleep.ts + 180 s — a Mac that is
    // heartbeating is awake whatever the pmset log says.
    const sleepState = s.power_events.filter((e) => e.kind === "power.sleep" || e.kind === "power.darkwake" || e.kind === "power.wake");
    const newestSleepState = sleepState.reduce<(typeof sleepState)[number] | null>(
      (best, e) => (!best || Date.parse(e.ts) > Date.parse(best.ts) || (Date.parse(e.ts) === Date.parse(best.ts) && Date.parse(e.received_at) > Date.parse(best.received_at)) ? e : best),
      null,
    );
    let asleep = false;
    if (newestSleepState && newestSleepState.kind !== "power.wake") {
      const evMs = Date.parse(newestSleepState.ts);
      const hbMs = s.last_heartbeat_received_at ? Date.parse(s.last_heartbeat_received_at) : NaN;
      const heartbeatedSince = Number.isFinite(hbMs) && hbMs > evMs + KH_HEARTBEAT_AFTER_SLEEP_MS;
      if (Number.isFinite(evMs) && now - evMs <= KH_ASLEEP_MAX_AGE_MS && !heartbeatedSince) {
        asleep = true;
        const why = [newestSleepState.reason ? `reason ${clean(newestSleepState.reason, 80)}` : null, newestSleepState.kAESleep ? `kAESleep ${clean(newestSleepState.kAESleep, 40)}` : null].filter(Boolean).join(", ");
        mk(
          "kiosk_asleep",
          "red",
          newestSleepState.ts,
          `The Mac in ${name} went to ${newestSleepState.kind === "power.darkwake" ? "DarkWake" : "sleep"} at ${fmtIst(newestSleepState.ts, now)} (${newestSleepState.kind}${why ? `; ${why}` : ""}) and has not woken since.`,
          `Go to ${name}, wake the Mac and confirm the recorder app is recording; if it sleeps again, check the power settings.`,
        );
      }
    }

    // R12 — HEALTH SILENT. The daemon's 60 s heartbeat stopped, but the presence poller can still reach the Mac (ext status is neither offline nor
    // no_chrome), so the Mac is up and the daemon is not talking. `enrolled` means a row in the last 7 days, so a daemon that stopped hours ago stays
    // raised ("stopped", last seen T) until it speaks again or 7 days pass. Superseded by R11 (a sleeping Mac is silent for a known reason).
    if (!asleep && ext && ext.status !== "offline" && ext.status !== "no_chrome") {
      const refIso = s.last_heartbeat_received_at ?? s.last_seen_received_at;
      const ref = refIso ? Date.parse(refIso) : NaN;
      if (Number.isFinite(ref)) {
        const silentS = Math.max(0, Math.floor((now - ref) / 1000));
        if (silentS > KH_SILENT_AFTER_S) {
          const stopped = silentS > KH_STOPPED_AFTER_S;
          mk(
            "kiosk_health_silent",
            "amber",
            new Date(ref).toISOString(),
            stopped
              ? `The kiosk-health daemon on ${name} stopped (last seen ${fmtIst(new Date(ref).toISOString(), now)}) although the Mac is reachable.`
              : `The kiosk-health daemon on ${name} is silent ${silentS} s although the Mac is reachable (last heartbeat ${fmtIst(new Date(ref).toISOString(), now)}).`,
            `Check the kiosk-health daemon on ${name} (launchd job, network); the Mac itself is up.`,
          );
        }
      }
    }

    // R13 — AUDIO DEAD. No default input device on the newest system_profiler snapshot, or the recorder failed to start audio in the last 10 min.
    // hal_error rows alone are noise (they appear in healthy sessions) and never raise this.
    {
      // Only a snapshot received within 2 h counts (the daemon emits one every 30 min); an older row says nothing about now.
      const fresh = s.last_audio_devices ? now - Date.parse(s.last_audio_devices.received_at) <= KH_AUDIO_FRESH_MS : false;
      const noInput = s.last_audio_devices && fresh ? s.last_audio_devices.default_input_present === false : false;
      const failures = s.audio_start_failures_10m;
      if (noInput || failures > 0) {
        const input = s.last_audio_devices?.default_input_name ? clean(s.last_audio_devices.default_input_name, 80) : "none";
        const since = noInput && s.last_audio_devices ? s.last_audio_devices.ts : (s.audio_start_failure_newest_ts ?? asOf);
        mk(
          "audio_dead",
          sevClinic,
          since,
          `Audio input on ${name} is dead: default input ${noInput ? "none" : input}, ${failures} recorder start failure${failures === 1 ? "" : "s"} in the last 10 min.`,
          `Go to ${name} and check the USB microphone is plugged in and selected as the Mac's input device.`,
        );
      }
    }

    // R14 — CONFIG DRIFT. A field whose latest drift row is not resolved.
    {
      const open = openDrift(s, now);
      if (open.length > 0) {
        const shown = open.slice(0, KH_DRIFT_DETAIL_MAX).map((d) => `${clean(d.field, 60)}: ${clean(d.expected ?? "unset", 60)} → ${clean(d.actual ?? "unset", 60)}`);
        const more = open.length > KH_DRIFT_DETAIL_MAX ? `; +${open.length - KH_DRIFT_DETAIL_MAX} more` : "";
        mk(
          "config_drift",
          "amber",
          open.reduce((a, d) => (Date.parse(d.ts) < Date.parse(a) ? d.ts : a), open[0]!.ts),
          `Settings on ${name} differ from the expected configuration — ${shown.join("; ")}${more}.`,
          `Re-apply the kiosk configuration on ${name} (or accept the change if it was deliberate).`,
        );
      }
    }

    // R15 — RECOVERY FAILED. The watchdog or the escalation ladder gave up within the hour and nothing woke the Mac afterwards.
    {
      const bad: Array<{ ts: string; received_at: string; what: string }> = [];
      const w = s.last_watchdog;
      if (w && w.outcome === "not_recovered") {
        bad.push({ ts: w.ts, received_at: w.received_at, what: `watchdog ${clean(w.trigger, 60) || "trigger unknown"}${w.failure_reasons.length ? ` (${w.failure_reasons.map((r) => clean(r, 60)).join(", ")})` : ""}` });
      }
      const l = s.last_ladder;
      if (l && l.outcome === "not_recovered") {
        bad.push({ ts: l.ts, received_at: l.received_at, what: `recovery ladder rung ${clean(l.rung, 60) || "unknown"}${l.trigger ? ` after ${clean(l.trigger, 60)}` : ""}` });
      }
      const live = bad
        .filter((b) => now - Date.parse(b.received_at) <= KH_RECOVERY_WINDOW_MS && now >= Date.parse(b.received_at) - 60_000)
        .filter((b) => !s.power_events.some((e) => e.kind === "power.wake" && Date.parse(e.ts) > Date.parse(b.ts)))
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      if (live.length > 0) {
        const top = live[0]!;
        mk(
          "recovery_failed",
          "red",
          top.ts,
          `Automatic recovery failed on ${name} at ${fmtIst(top.ts, now)}: ${top.what}. Nothing has woken the Mac since.`,
          `Go to ${name} now: the Mac did not recover on its own.`,
        );
      }
    }

    // R16 — PRESENCE CANNOT RUN. Raised while the newest chrome.profile (received within 20 min) says presence_ok === false, or — as before — when a
    // chrome.alert arrived within 15 min and no chrome.profile at or after it says presence_ok === true. The alert is emitted once per episode (on the
    // true→false edge or after 2 false samples), so it ages out after 15 min while the fault persists; the 5-minutely chrome.profile keeps the item up.
    {
      const a = s.last_chrome_alert;
      const profile = freshChromeProfile(s, now);
      const heldByProfile = profile !== null && profile.presence_ok === false;
      const alertLive = a !== null && now - Date.parse(a.received_at) <= KH_CHROME_ALERT_WINDOW_MS && now >= Date.parse(a.received_at) - 60_000;
      const cleared = !!a && !!s.last_chrome_profile && s.last_chrome_profile.presence_ok === true && Date.parse(s.last_chrome_profile.ts) >= Date.parse(a.ts);
      if (heldByProfile || (alertLive && !cleared)) {
        let reason: string;
        let lastUsed: string | null;
        let guest: boolean | null;
        let since: string;
        if (heldByProfile) {
          // The profile is the current truth; an alert may belong to an earlier episode, so it is only the reason when it is NEWER than the profile.
          lastUsed = profile!.last_used;
          guest = profile!.guest;
          since = falseEpisodeStart(s) ?? profile!.ts;
          reason =
            profile!.running === false ? "Chrome not running"
            : profile!.guest === true ? "Chrome on Guest profile"
            : profile!.ext_installed === false && profile!.last_used ? `ext_missing:${clean(profile!.last_used, 60)}`
            : a && Date.parse(a.ts) > Date.parse(profile!.ts) && clean(a.reason, 80) ? clean(a.reason, 80)
            : "presence_ok false";
        } else {
          reason = clean(a!.reason, 80) || "reason unknown";
          lastUsed = a!.last_used;
          guest = a!.guest;
          since = a!.ts;
        }
        const extMissing = /^ext_missing:/.test(reason) ? clean(reason.slice("ext_missing:".length), 60) : null;
        mk(
          "presence_cannot_run",
          sevClinic,
          since,
          `Pulse Presence cannot run on ${name}: ${reason}; Chrome last used ${lastUsed ? clean(lastUsed, 60) : "unknown"}, guest session ${guest === null ? "unknown" : guest ? "yes" : "no"}.`,
          extMissing !== null
            ? `Extension dir empty in ${extMissing || "the active profile"}; fleet thread re-installs into that profile`
            : `Open Chrome on ${name} with the clinic profile (not a guest session) and confirm the Presence extension is installed.`,
        );
      }
    }

    // R17 — RECORDER UPDATE FAILING.
    {
      const f = s.recorder_update_failures_24h;
      if (f.count > 0) {
        const line = clean(f.newest_line, KH_RECORDER_LINE_MAX);
        mk(
          "recorder_update_failing",
          "amber",
          f.newest_ts ?? asOf,
          `The room recorder on ${name} failed its self-update ${f.count} time${f.count === 1 ? "" : "s"} in 24 h: ${line || "no line captured"}`,
          `Re-install the room recorder on ${name} (the update package signature is rejected, so it stays on the old build).`,
        );
      }
    }
  }
  return items;
}
