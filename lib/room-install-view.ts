/**
 * lib/room-install-view.ts — the fleet card's decisions, PURE (Install and Fleet PRD §6).
 *
 * NO IMPORTS, deliberately, exactly like lib/bench-bus-constants.ts: this module is pulled into
 * the admin browser bundle by BenchInstallFleet, and lib/room-install.ts carries the database
 * module graph. Every rule §6 states — the five checklist steps, the room words, the five row
 * states — is decided HERE, once, so the card and the tests cannot drift from each other.
 *
 * ─── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────────────────
 * THE PAGE NEVER ASSERTS COMPLETION FROM ITS OWN ACTIONS. Every step below reads server state
 * that arrived in a poll the APP sent. The single exception is step 1, which carries the label
 * "Command copied" and never the label "Installed" — and it is the only step whose input is a
 * page event rather than a column.
 *
 * That is why `deriveSteps` takes `copiedAt` as its only page-side input and reads everything
 * else off the install row. A step cannot turn done here without a Mac having said so.
 *
 * Tier 1 adds ONE TYPE-ONLY import, from the equally import-free lib/bench-bus-constants.ts. It is
 * erased at compile time, so the bundle this file joins is exactly what it was.
 *
 * ETA-DELIVERY-EVIDENCE phase 1, amendment 1 adds ONE VALUE import, from the equally
 * import-free lib/bench-reaper-core.ts (zero imports of its own — confirmed, not assumed):
 * `isBenchStalled`, the admin list's own stalled-badge rule (R10), which already closes over
 * `STALLED_BADGE_MINUTES` — so NOT_DELIVERING is computed here by CALLING that rule, never by
 * copying its threshold or its comparison. The bundle this file joins grows by one small, leaf,
 * database-free module — not by the module graph lib/room-install.ts carries.
 */

import type { InstallStateFlag } from "./bench-bus-constants";
import { isBenchStalled } from "./bench-reaper-core";

// ---------------------------------------------------------------------------
// Wire types — what GET /api/admin/bench/fleet returns
// ---------------------------------------------------------------------------

export type MicState = "authorized" | "denied" | "not_determined" | "unknown";
export type LaunchedBy = "launchd" | "user";

export type InstallView = {
  install_id: string;
  room_id: string;
  created_at: string;
  enrolled_at: string | null;
  session_expires_at: string | null;
  launched_by: LaunchedBy | null;
  hostname: string | null;
  hardware_model: string | null;
  os_version: string | null;
  /** What the room's input device is called, as the app last measured it. Null = never reported. */
  input_device_name: string | null;
  app_version: string | null;
  build_sha: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  mic_state: MicState;
  launch_agent_loaded: boolean;
  tape_advancing: boolean;
  tape_poll_streak: number;
  tape_advancing_since: string | null;
  never_sleep: boolean | null;
  retired_at: string | null;
  // ── Build R3 (§13.4). Every one is NULL on an install below 0.1.8, for ever. ─────────────
  /** R3-6. Whether a session was open at the moment of the poll. NULL = never reported. */
  session_open: boolean | null;
  /** R3-8. Which channel this Mac asks for, from its own config.json. */
  update_channel: UpdateChannel | null;
  /** The last self-update outcome this Mac reported. NULL = none ever attempted. */
  last_update_result: UpdateResult | null;
  /** The version that attempt was reaching for. Its own column since Fix 1 (V, 9 Sep). */
  last_update_version: string | null;
  /** What went wrong, in one sentence. The version is NOT in here — see above. */
  last_update_error: string | null;
  /** When the swap script recorded that outcome, by the Mac's clock. */
  last_update_at: string | null;
  /** V, 9 Sep. Free bytes on the captures volume. NULL = not reported. NEVER 0. */
  disk_free_bytes: number | null;
  // ── Release B2 (0079). NULL on every row until migration 0079 runs, and on every app below 0.1.20.
  /** B2-D5 / Tier 1 §3. What an admin assigned — `stable` or `test`; NULL when nothing is assigned. */
  assigned_channel?: "stable" | "test" | null;
  /** B2-D7. Highest absolute sample, 0..1, over the last piece window. NULL = not reported. */
  peak?: number | null;
  /** B2-D7. Fraction of bit-exact zero samples, 0..1, same window. NULL = not reported. */
  zero_ratio?: number | null;
  /** B2-D10. Every input CoreAudio listed, default marked. READ-ONLY. NULL = never reported. */
  input_devices?: InputDevice[] | null;
  // ── Release R4 (0080). NULL on every row until 0080 runs, and on every app below 0.1.21. ────
  /** R4-D4. Input volume, 0..1, of the device the app records from. NULL = not reported. */
  input_volume?: number | null;
  /** R4-D4. Whether that volume can be set from software. FALSE greys the slider; NULL = not reported. */
  input_volume_settable?: boolean | null;
  // ── Tier 1 §2 (0081). NULL on every row until 0081 runs and a poll reaches it. ───────────────
  /** The named states at the last evaluation, canonical order. [] = none; NULL = never evaluated. */
  state_flags?: InstallStateFlag[] | null;
  /** When the SET of flags last changed. */
  state_changed_at?: string | null;
  /** The input this room should record from — adopted at first report, set by a desk switch. */
  expected_device_name?: string | null;
  /** Tier 1 §3. The Mac's config.json pins its channel and it ignores an assignment. NULL = not reported. */
  channel_locked?: boolean | null;
};

/** B2-D10 — one entry of the app's input-device list, as `cleanPollFields` bounded it. */
export type InputDevice = { name: string; uid: string; is_default: boolean };

export type UpdateChannel = "stable" | "test";

/** §13.4 plus Fix 2's G1 — the outcomes update-result.json can carry. */
export type UpdateResult =
  | "ok"
  | "checksum_mismatch"
  | "signature_mismatch"
  | "download_failed"
  | "expand_failed"
  | "swap_failed"
  | "version_mismatch";

export type ReleaseView = {
  id: string;
  version: string;
  build_sha: string;
  sha256: string;
  size_bytes: number;
  blob_url: string;
  channel: "stable" | "test";
  published_at: string;
  published_by: string;
  withdrawn_at: string | null;
  notes: string | null;
  min_macos: string;
  /** Migration 0102. Every row before it is 'macos'. A Mac is only ever offered a 'macos' row. */
  platform: ReleasePlatform;
};

export type ReleasePlatform = "macos" | "linux";

export type FleetRow = {
  room_id: string;
  room_slug: string;
  room_name: string;
  disabled: boolean;
  /** The bound install: enrolled and not retired. At most one, by the partial unique index. */
  install: InstallView | null;
  /** A minted-but-not-yet-enrolled install, if one is outstanding. What the checklist watches. */
  pending: InstallView | null;
  /** The most recently retired install, when nothing is bound. Gives §6's `retired` state its
   *  meaning: a room that HAD a Mac and no longer does reads differently from one that never did. */
  last_retired: InstallView | null;
  /**
   * B2-D3. How many retired installs this room has had, newest first in `earlier`. A COUNT on the
   * row, never a row of its own: every re-enrolment paste retires one, and a card with a line per
   * paste stops answering "which Mac runs which room". Optional so a payload from before B2 reads
   * as zero.
   */
  earlier_installs?: number;
  earlier?: EarlierInstall[];
  /**
   * ETA-DELIVERY-EVIDENCE phase 1, amendment 1. This room's currently OPEN (`status:
   * "recording"`) `bench_session`, joined by room_id in `readFleet` — a JOIN of existing
   * session/chunk data, not a new signal (lib/bench.ts's `listBenchSessions`). Null when there
   * is no such session: paused, ended, or never started, which is the same "no flag" case as
   * controls C and D in the PRD's acceptance table. Optional so every existing FleetRow literal
   * in the test suite, built before this field existed, still type-checks.
   */
  open_session?: { status: string; started_at: string; last_any_chunk_at: string | null } | null;
};

/** B2-D3 — what the "N earlier installs" disclosure lists: the id and when it was retired. */
export type EarlierInstall = { install_id: string; retired_at: string };

/**
 * B2-D3 — an install the card cannot put on a room row, listed ONCE under "Unassigned" rather than
 * dropped. Three ways in:
 *   · `room_not_on_card` — its room is disabled or a scratch room and nothing live holds it there;
 *   · `never_enrolled`   — minted, never pasted, past the 30-minute TTL (the nightly cleanup takes
 *                          it a day later). Every machine column on it is null;
 *   · `second_bound`     — a second enrolled, un-retired install in one room. The partial unique
 *                          index forbids it; if it ever existed, grouping must not hide it.
 */
export type UnassignedInstall = {
  install_id: string;
  room_id: string;
  hostname: string | null;
  created_at: string;
  retired_at: string | null;
  why: "room_not_on_card" | "never_enrolled" | "second_bound";
};

export type FleetPayload = {
  now: string;
  rows: FleetRow[];
  /** The STABLE release. The card header shows this and only this — §5.8: the header is unchanged. */
  latest_release: ReleaseView | null;
  /**
   * The newest non-withdrawn release on each channel (Fix 1, F6). A row is only "behind" against
   * the shelf it actually asks for: Home Office on `test` must not be measured against `stable`.
   * Null for a channel with nothing published, which means the row shows no version word at all.
   */
  releases: { stable: ReleaseView | null; test: ReleaseView | null };
  /**
   * Migration 0102. The same two shelves for Linux rows. `releases` above is the MAC shelf and stays so:
   * a Linux row measured against a Mac version would wear `update pending` for ever. Optional: a payload
   * from before 0102 has none, and reads as nothing published for Linux.
   */
  linux_releases?: { stable: ReleaseView | null; test: ReleaseView | null };
  degraded: string[];
  /** B2-D3. Installs that belong on no row of this card. Optional: absent before B2 reads as none. */
  unassigned?: UnassignedInstall[];
};

/** A room as `readFleet` reads it — the only four columns grouping needs. */
export type FleetRoom = { id: string; slug: string; name: string; disabled_at: string | null };

/**
 * PURE — B2-D3. One row per room on the card, the bound install as the row, retired installs as a
 * count on it, and everything that fits no row under "Unassigned".
 *
 * THE FIRST THREE FIELDS OF EACH ROW ARE WHAT `readFleet` ALREADY COMPUTED, moved here unchanged so
 * they can be tested without a database: `install` is the bound Mac, `pending` an in-TTL mint, and
 * `last_retired` the newest enrolled-then-retired install when nothing is bound — which is what
 * keeps the `retired` row state meaning "this room HAD a Mac". `deriveRow` reads none of the new
 * fields and is unchanged by grouping.
 *
 * NOTHING ENROLLED AND UN-RETIRED CAN DISAPPEAR. The partial unique index allows one per room; if a
 * second ever existed it would not be `install`, `pending` or retired, so it goes to Unassigned as
 * `second_bound` rather than off the card. `installs` must be newest first, as `readFleet` reads it.
 */
export function groupFleet(input: {
  rooms: FleetRoom[];
  installs: InstallView[];
  nowMs: number;
  tokenTtlMs: number;
}): { rows: FleetRow[]; unassigned: UnassignedInstall[] } {
  const { rooms, installs, nowMs, tokenTtlMs } = input;
  const onCard = new Set(rooms.map((r) => r.id));
  const unassigned: UnassignedInstall[] = [];
  const park = (i: InstallView, why: UnassignedInstall["why"]) =>
    unassigned.push({
      install_id: i.install_id,
      room_id: i.room_id,
      hostname: i.hostname,
      created_at: i.created_at,
      retired_at: i.retired_at,
      why,
    });

  const rows: FleetRow[] = rooms.map((room) => {
    const mine = installs.filter((i) => i.room_id === room.id);
    const bound = mine.find((i) => i.enrolled_at && !i.retired_at) ?? null;
    const pending =
      mine.find(
        (i) =>
          !i.enrolled_at && !i.retired_at && nowMs - new Date(i.created_at).getTime() < tokenTtlMs,
      ) ?? null;
    const lastRetired = bound ? null : (mine.find((i) => i.retired_at && i.enrolled_at) ?? null);
    const earlier = mine
      .filter((i) => i.retired_at)
      .map((i) => ({ install_id: i.install_id, retired_at: i.retired_at! }));

    for (const i of mine) {
      if (i.retired_at || i === bound || i === pending) continue;
      if (i.enrolled_at) park(i, "second_bound");
      else if (nowMs - new Date(i.created_at).getTime() >= tokenTtlMs) park(i, "never_enrolled");
      // An in-TTL mint that is not `pending` is a second copy of the command for the same room;
      // it is normal, it expires in minutes, and it is not a Mac.
    }

    return {
      room_id: room.id,
      room_slug: room.slug,
      room_name: room.name,
      disabled: Boolean(room.disabled_at),
      install: bound,
      pending,
      last_retired: lastRetired,
      earlier_installs: earlier.length,
      earlier,
    };
  });

  for (const i of installs) if (!onCard.has(i.room_id)) park(i, "room_not_on_card");
  return { rows, unassigned };
}

/** PURE — the release a row should be measured against: the one on its own channel (F6). */
export function releaseForRow(
  row: FleetRow,
  releases: { stable: ReleaseView | null; test: ReleaseView | null } | null | undefined,
  linuxReleases?: { stable: ReleaseView | null; test: ReleaseView | null } | null,
): ReleaseView | null {
  // A row is only behind on ITS OWN platform's shelf (0102). A Mac row reads `releases` exactly as before.
  const shelf = installPlatform(row.install) === "linux" ? linuxReleases : releases;
  if (!shelf) return null;
  // A row with no install, or an install below 0.1.8 that reports no channel, is on stable by
  // construction — every install that predates R3 is.
  const channel = row.install?.update_channel ?? "stable";
  return shelf[channel] ?? null;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** §6 polling. Both cadences "match the existing Rooms Live monitor", and these are its numbers. */
export const FLEET_POLL_MS = 20_000;
export const CHECKLIST_POLL_MS = 3_000;

/**
 * THE LAST-SEEN ALARM WINDOW — §6 marks it UNKNOWN and asks the builder to establish it "against
 * an ordinary day, per R18".
 *
 * IT IS NOT ESTABLISHED HERE, AND SAYING SO IS THE POINT. An ordinary day of the native app
 * cannot be observed yet: the app is Build R2 and does not exist. Measuring the browser kiosk
 * instead would establish the cadence of a different program.
 *
 * So this is INHERITED, not invented. lib/bench-bus-constants.ts already decides exactly this
 * question for the kiosk — "how long a listener may be gone before 'it might come back' becomes
 * 'somebody has to walk there'" — and answers ten minutes. The fleet card asks the identical
 * question about a different process on the same Mac, and a second, differently-guessed number
 * would only mean two screens disagreeing about when a room is dark.
 *
 * R18 IS THEREFORE STILL OPEN and is carried into R2, where a real Mac running a real day can
 * settle it. This is a defensible default with a stated basis, not a measurement.
 */
export const LAST_SEEN_ALARM_MS = 10 * 60_000;

/** §6: "A warning appears at 30 days or fewer." */
export const SESSION_WARN_DAYS = 30;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function msOf(v: string | Date | null | undefined): number | null {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** "4 s ago", "12 m ago", "3 days ago", "never". The card's Last seen column. */
export function fmtSeen(iso: string | null, nowMs: number): string {
  const t = msOf(iso);
  if (t === null) return "never";
  const ms = Math.max(0, nowMs - t);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Clock time for a step stamp: "14:34", in the viewer's own zone. */
export function fmtClock(iso: string | null): string {
  const t = msOf(iso);
  if (t === null) return "—";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * "412.3 GB free" — the Machine cell's last line (V, 9 September 2026).
 *
 * DECIMAL UNITS, because that is what macOS shows in Get Info and About This Mac, and an operator
 * comparing this row against the Finder must see the same number. Null in, null out: `disk_free_bytes`
 * is never 0 and never -1 (the app omits it rather than guessing), so there is nothing here that
 * turns "could not read the volume" into "the disk is full".
 */
export function fmtBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units: Array<[number, string, number]> = [
    [1e12, "TB", 2],
    [1e9, "GB", 1],
    [1e6, "MB", 0],
  ];
  for (const [scale, unit, dp] of units) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(dp)} ${unit} free`;
  }
  return `${Math.round(bytes / 1000)} kB free`;
}

/**
 * The reason sentences the App cell renders, one per outcome (§13.4, R3-7).
 *
 * THE FIRST TWO ARE THE MOCKUP'S OWN WORDS and are the contract. The other three the mockup does
 * not show, and they are written to the same shape: plain, past tense, no jargon, and no
 * instruction — nothing here is something an operator can act on from a screen, and a sentence
 * that implied otherwise would send someone to a room for no reason.
 */
export const UPDATE_FAILURE_REASON: Record<Exclude<UpdateResult, "ok">, string> = {
  checksum_mismatch: "The downloaded file did not match its checksum.",
  signature_mismatch: "The downloaded app was not signed by Even.",
  download_failed: "The download did not finish.",
  expand_failed: "The downloaded file could not be unpacked.",
  swap_failed:
    "The new version did not verify once it was in place, so the previous one was put back.",
  // Fix 2, G1. NOT a corrupted download — a correctly signed one that is labelled wrong. The
  // sentence says "was published as" rather than "is broken" because the fault is on the shelf,
  // not on the Mac, and the person reading the row is the person who publishes.
  version_mismatch:
    "The downloaded app was published as a different version from the one it says it is.",
};

/** Whole days until the session expires. Negative once it has. */
export function daysUntil(iso: string | null, nowMs: number): number | null {
  const t = msOf(iso);
  if (t === null) return null;
  return Math.floor((t - nowMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// The five checklist steps (§6, D11)
// ---------------------------------------------------------------------------

/**
 * `not_applicable` exists for ONE step on ONE platform: a Linux room has no operating-system microphone
 * permission, so step 3 has nothing to wait for and nothing to be done. It is not `done` — a green tick
 * would claim a permission was granted, and nothing granted one.
 */
export type StepState = "done" | "waiting" | "blocked" | "not_applicable";

export type InstallPlatform = ReleasePlatform;

/**
 * PURE — which platform an install runs on, read off what the machine REPORTED about itself.
 *
 * `os_version` is the only platform fact any poll carries. The Mac app writes `macOS <major>.<minor>`
 * (apps/room-recorder MachineFacts.osVersion); the Linux room-bench writes /etc/os-release's
 * PRETTY_NAME ("Ubuntu 26.04 LTS"). ANYTHING ELSE IS A MAC, including a row that has not polled yet:
 * every install before the Linux port is a Mac, and a guess must never move a Mac row off the wording
 * and rules it has always had.
 */
export function installPlatform(i: Pick<InstallView, "os_version"> | null | undefined): InstallPlatform {
  const os = i?.os_version?.trim() ?? "";
  if (/^macOS\b/.test(os)) return "macos";
  return /\b(ubuntu|debian|linux)\b/i.test(os) ? "linux" : "macos";
}

export type Step = {
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  state: StepState;
  /** What actually happened, shown only on `done`. Never a claim the page made up. */
  did: string | null;
  /** The ONE instruction. §6: "A blocked step shows one instruction." */
  note: string | null;
  /** `bad` on blocked, `warn` for the auto-login reminder that is never done. */
  tone: "plain" | "bad" | "warn";
};

const machineLine = (i: InstallView): string => {
  const bits = [i.hostname ?? (installPlatform(i) === "linux" ? "this machine" : "this Mac"), i.hardware_model, i.os_version].filter(Boolean);
  return bits.join(" · ");
};

/**
 * PURE — the five steps, from one install row and the moment the page copied the command.
 *
 * `install` is null until the mint returns; every step but 1 is `waiting` in that case, which is
 * exactly the state the operator sees between clicking Copy and pasting into Terminal.
 */
export function deriveSteps(input: {
  install: InstallView | null;
  /** ISO instant the page put the command on the clipboard. The ONLY page-driven input here. */
  copiedAt: string | null;
}): Step[] {
  const i = input.install;

  // ── 1. Command copied ────────────────────────────────────────────────────────────────────
  // NEVER blocked, and never says "Installed". This step records a clipboard write and claims
  // nothing about a Mac. Its note says so out loud, because it is the one place on this card
  // where a page action turns something green and the operator must not read it as progress.
  const step1: Step = input.copiedAt
    ? {
        n: 1,
        title: "Command copied",
        state: "done",
        did: `Command copied ${fmtClock(input.copiedAt)}`,
        note: "This records that the command was copied. It does not mean the install finished.",
        tone: "plain",
      }
    : {
        n: 1,
        title: "Command copied",
        state: "waiting",
        did: null,
        note: "Press Copy install command, then paste it into Terminal on the room Mac.",
        tone: "plain",
      };

  // ── 2. App running ───────────────────────────────────────────────────────────────────────
  // DONE on `launched_by = launchd`, BLOCKED on `launched_by = user`. The distinction is the
  // whole point of the step: an app someone double-clicked runs until the window is closed, and
  // a room that records only while a person is standing in it is not installed. §6 gives the
  // blocked instruction as "report it" — there is no setting the operator can change.
  //
  // ON LINUX THERE IS NO launchd AND NO `launched_by`. room-bench is a systemd service that starts at
  // boot with nobody logged in, so there is no "opened by a person" failure to tell apart: the first
  // poll IS the proof the service runs. Nothing is written to `launched_by` to make this turn green.
  const linux = installPlatform(i) === "linux";
  const started = i?.first_seen_at ?? null;
  const step2: Step = linux
    ? started
      ? {
          n: 2,
          title: "App running",
          state: "done",
          did: `Running on ${machineLine(i!)} · systemd service · ${fmtClock(started)}`,
          note: "Reported from this machine's first poll after the command ran.",
          tone: "plain",
        }
      : {
          n: 2,
          title: "App running",
          state: "waiting",
          did: null,
          note: "Paste the command into a terminal on the room machine and press Return. This turns done on the machine's first poll.",
          tone: "plain",
        }
    : i?.launched_by === "launchd"
      ? {
          n: 2,
          title: "App running",
          state: "done",
          did: `App running on ${machineLine(i)} · started by launchd · ${fmtClock(started)}`,
          note: "Reported from this Mac's first poll after the command ran.",
          tone: "plain",
        }
      : i?.launched_by === "user"
        ? {
            n: 2,
            title: "App running",
            state: "blocked",
            did: null,
            note: "App opened but not resident. Started by user, not launchd. Wait 10 seconds. If this stays, stop and report.",
            tone: "bad",
          }
        : {
            n: 2,
            title: "App running",
            state: "waiting",
            did: null,
            note: "Paste the command in Terminal and press Return. This turns done on the Mac's first poll.",
            tone: "plain",
          };

  // ── 3. Microphone allowed ────────────────────────────────────────────────────────────────
  // The blocked instruction is the System Settings path, because that is the only thing that
  // fixes it — and the step clears itself on the next poll after the switch is turned on, so the
  // note says there is nothing to press here.
  //
  // ON LINUX: NOT APPLICABLE, never `done`. The column stays `unknown` because nothing on the machine
  // measures a permission, and step 4 is where audio arriving is proved.
  const step3: Step = linux
    ? {
        n: 3,
        title: "Microphone allowed",
        state: "not_applicable",
        did: null,
        note: "Not applicable on Linux: there is no microphone permission to grant. Step 4 shows whether audio arrives.",
        tone: "plain",
      }
    : i?.mic_state === "authorized"
      ? {
          n: 3,
          title: "Microphone allowed",
          state: "done",
          did: `Authorized, reported ${fmtClock(i.last_seen_at)}.`,
          note: null,
          tone: "plain",
        }
      : i?.mic_state === "denied"
        ? {
            n: 3,
            title: "Microphone allowed",
            state: "blocked",
            did: null,
            note: "Microphone denied. On this Mac: System Settings → Privacy & Security → Microphone → turn on EvenScribe Room Recorder. This step clears itself on the next poll — nothing to press here.",
            tone: "bad",
          }
        : {
            n: 3,
            title: "Microphone allowed",
            state: "waiting",
            did: null,
            note: "Click Allow on the microphone prompt when it appears.",
            tone: "plain",
          };

  // ── 4. Tape advancing ────────────────────────────────────────────────────────────────────
  // TWO CONSECUTIVE POLLS, which is why room_install carries a streak and not just a boolean.
  // §6: this step is NEVER blocked. A room with no audio stays waiting, because "no audio yet"
  // and "audio will never come" look identical from here and only one of them is worth an alarm.
  const tapeDone = Boolean(i && i.tape_advancing && i.tape_poll_streak >= 2);
  const step4: Step = tapeDone
    ? {
        n: 4,
        title: "Tape advancing",
        state: "done",
        did: `Audio arriving since ${fmtClock(i!.tape_advancing_since)} · two polls in a row · listener app_${i!.install_id}`,
        note: null,
        tone: "plain",
      }
    : {
        n: 4,
        title: "Tape advancing",
        state: "waiting",
        did: null,
        note:
          i?.mic_state === "denied"
            ? "No audio can arrive until the microphone is allowed."
            : "Turns done after two polls in a row report audio arriving from this room.",
        tone: "plain",
      };

  // ── 5. Machine settings ──────────────────────────────────────────────────────────────────
  // NEVER SLEEP is reported and can turn done. AUTOMATIC LOGIN IS NOT REPORTED BY ANYTHING, so
  // it stays a reminder for ever — §6 says it "never turns done", and this step honours that by
  // carrying the reminder into the done branch rather than dropping it once never-sleep lands.
  //
  // ON LINUX THE LOGIN RULE IS THE OPPOSITE ONE. The installer turns automatic login OFF and boots to a
  // text console, because both services run with nobody logged in. The Mac reminder would tell an
  // operator to undo that, so Linux gets its own sentence, and it is not a warning: nothing is missing.
  const autoLoginNote =
    "Automatic login: set it in System Settings → Users & Groups → Automatic login (reminder, not checked).";
  const linuxLoginNote =
    "Nobody needs to log in: the recorder runs as a system service. After a restart this machine shows a text screen, not a desktop, by design — watch this checklist from another device.";
  const step5: Step = linux
    ? i?.never_sleep === true
      ? {
          n: 5,
          title: "Machine settings",
          state: "done",
          did: "Never sleep: detected (sleep, suspend and hibernate are switched off)",
          note: linuxLoginNote,
          tone: "plain",
        }
      : {
          n: 5,
          title: "Machine settings",
          state: "waiting",
          did: null,
          note:
            i?.never_sleep === false
              ? "Sleep is still switched on for this machine. Paste the install command again; it switches sleep off. " + linuxLoginNote
              : "Never sleep turns done when the recorder reports it. " + linuxLoginNote,
          tone: "plain",
        }
    : i?.never_sleep === true
      ? {
          n: 5,
          title: "Machine settings",
          state: "done",
          did: "Never sleep: detected",
          note: autoLoginNote,
          tone: "warn",
        }
      : {
          n: 5,
          title: "Machine settings",
          state: "waiting",
          did: null,
          note:
            i?.never_sleep === false
              ? "Never sleep is off. On this Mac: System Settings → Displays → Advanced → turn on “Prevent automatic sleeping when the display is off”. " +
                autoLoginNote
              : "Never sleep turns done when the app reports it. " + autoLoginNote,
          tone: "warn",
        };

  return [step1, step2, step3, step4, step5];
}

// ---------------------------------------------------------------------------
// Row words and row state (§6, D13)
// ---------------------------------------------------------------------------

/** The four words a room row may wear. §6 "States" are the machine states; these are the pills. */
export type RoomWord = "installed" | "not installed" | "needs re-enrol" | "update pending";

export type RowState = "not_installed" | "enrolling" | "healthy" | "needs_attention" | "retired";

export type RowView = {
  state: RowState;
  words: RoomWord[];
  /** Why this row wants attention. Empty on a healthy row. One line each, worst first. */
  attention: string[];
  /** Session expiry, already worded: "session expires in 341 d" / "session expired". */
  session_label: string | null;
  session_warn: boolean;
  // ── Build R3, state C and state E of the 8 September mockup delta ─────────────────────────
  /**
   * The Tape cell's words. `idle, no session` when the app says no session is open (R3-3);
   * otherwise what the cell already said. Null when no Mac is bound.
   */
  tape_label: string | null;
  /**
   * STATE C. The one sentence the App cell carries under the version, when the last update this
   * Mac attempted did not succeed. Null when the last result was `ok` or absent — R3-7: nothing
   * new appears on the card while updates work.
   */
  update_note: string | null;
  /** STATE C's pill, beside `installed`. True on exactly the same condition as `update_note`. */
  update_failed: boolean;
  /** STATE E. `channel stable` / `channel test`, from `update_channel`. Null when unreported. */
  channel_label: string | null;
  /**
   * STATE E. The dim line under the app version. `latest`, `latest 0.1.8` — or `test channel` on a
   * Mac that asks the `test` channel, where the card's stable release header is not what that Mac
   * would download and "latest 0.1.8" would be answering a question nobody asked.
   */
  version_hint: string | null;
  /** V, 9 Sep. "412.3 GB free" for the Machine cell. Null when the app could not read it. */
  disk_label: string | null;
  // ── Release B2 ────────────────────────────────────────────────────────────────────────────
  /**
   * B2-D6. Headroom on the captures volume: `red` under 5 GB, `amber` under 20 GB, `ok` above, and
   * `unknown` when the app did not report it. NEVER `ok` on a missing number — a card that shows
   * green for "we do not know" is the failure this field exists to prevent. Warn only: nothing is
   * deleted in B2.
   */
  disk_level: DiskLevel;
  /** B2-D6. Always GB with one decimal ("18.4 GB free"), or "disk not reported". */
  disk_text: string;
  /** B2-D7, passed through. Null when not reported. */
  peak: number | null;
  zero_ratio: number | null;
  /** B2-D10, passed through, read-only. Null when never reported. */
  input_devices: InputDevice[] | null;
  /**
   * B2-D5, generalised 12 Sep. True while ANY assigned channel is waiting for the Mac to report it —
   * `test` as well as `stable`, since Tier 1 §3 made both assignable. The card shows that an
   * assignment is outstanding until then, and after that says nothing: the Mac's own report is the
   * only proof it moved, and the card never names the destination it cannot verify.
   */
  assigned_pending: boolean;
  /** B2-D5. Whether the card offers "Move to stable": a bound Mac that reports `test`, not yet assigned. */
  can_move_to_stable: boolean;
  // ── Release R4 ────────────────────────────────────────────────────────────────────────────
  /** R4-D4, passed through. Null when not reported. */
  input_volume: number | null;
  input_volume_settable: boolean | null;
  /** R4-D4. "62%", "not settable", or "—" — see `volumeText`. */
  volume_text: string;
  /** R4-D5. Whether the card offers the device select and volume slider: a bound Mac, and only that. */
  can_set_audio_input: boolean;
  // ── Tier 1 §2 ─────────────────────────────────────────────────────────────────────────────
  /** The install's named states, passed through for the chip. [] when none or never evaluated. */
  state_flags: InstallStateFlag[];
  /** Tier 1 §3. The Mac reports a locked channel: an assignment will not move it. Shown as a chip. */
  channel_locked: boolean;
  // ── ETA-DELIVERY-EVIDENCE phase 1, amendment 1 ───────────────────────────────────────────
  /**
   * Minutes since this room's open session last delivered a chunk (or since it started, on the
   * zero-chunks-ever fallback `isBenchStalled` already applies) — null while nothing is wrong.
   * A NUMBER, not a boolean, because the chip must say "no audio delivered for Nm": D-6 in the
   * place it matters most is spelling a degraded state differently from a fine one, and a bare
   * flag would still have to be worded by something downstream.
   */
  not_delivering_minutes: number | null;
};

export type DiskLevel = "ok" | "amber" | "red" | "unknown";

/** B2-D6 thresholds, decimal GB as `fmtBytes` uses them. */
export const DISK_AMBER_BYTES = 20_000_000_000;
export const DISK_RED_BYTES = 5_000_000_000;

/** PURE — B2-D6. The colour a disk reading earns. Null, 0 or negative is `unknown`, never `ok`. */
export function diskLevel(bytes: number | null | undefined): DiskLevel {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "unknown";
  if (bytes < DISK_RED_BYTES) return "red";
  if (bytes < DISK_AMBER_BYTES) return "amber";
  return "ok";
}

/** PURE — B2-D6. "18.4 GB free", one decimal, whatever the size; "disk not reported" otherwise. */
export function diskText(bytes: number | null | undefined): string {
  return diskLevel(bytes) === "unknown"
    ? "disk not reported"
    : `${(bytes! / 1_000_000_000).toFixed(1)} GB free`;
}

/**
 * PURE — R4-D4. The volume beside the device name: a whole percentage, `not settable` when the app
 * said the device has no settable volume (whatever number it last reported), and `—` when nothing
 * was reported. NEVER "0%" for a missing reading — that would read as a muted input.
 */
export function volumeText(volume: number | null | undefined, settable: boolean | null | undefined): string {
  if (settable === false) return "not settable";
  if (volume === null || volume === undefined || !Number.isFinite(volume)) return "—";
  return `${Math.round(volume * 100)}%`;
}

/**
 * PURE — B2-D4. The receipt's own sentence, as the card prints it: first letter up, one full stop.
 * Null when the Mac sent none. It is already bounded to 300 characters by `cleanPollFields`, and
 * React escapes it, so it is text on a screen and nothing else.
 */
export function receiptSentence(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * PURE — one row's state, words and reasons.
 *
 * PRECEDENCE, first match wins, and the order is the operator's order:
 *
 *   1 NOT INSTALLED   no enrolled install. If a token is outstanding it reads `enrolling`, which
 *                     is the same absence with a reason and a countdown attached.
 *   2 NEEDS RE-ENROL  the session has expired. The app is on that Mac and is polling into 401s;
 *                     it will not record again until a second paste. This outranks every other
 *                     complaint because it is the only one that has already stopped the room.
 *   3 NEEDS ATTENTION mic denied, tape not advancing, session expiring inside 30 days, last
 *                     seen older than the alarm window, or NOT_DELIVERING (ETA-DELIVERY-EVIDENCE
 *                     phase 1: an open session whose chunk clock has gone stale — imported from
 *                     `isBenchStalled`, never re-derived).
 *   4 HEALTHY         none of the above. `update pending` rides alongside as a word, never as a
 *                     state: a room on the previous version is recording perfectly well.
 */
export function deriveRow(input: {
  row: FleetRow;
  /**
   * The newest non-withdrawn release ON THIS ROW'S CHANNEL — use `releaseForRow`. Null means that
   * channel has nothing published, and a row measured against nothing wears no version word.
   */
  latestRelease: ReleaseView | null;
  nowMs: number;
}): RowView {
  const { row, latestRelease, nowMs } = input;
  const i = row.install;
  const words: RoomWord[] = [];
  const attention: string[] = [];

  // ── Build R3 row facts, needed by every branch that returns an install ───────────────────
  //
  // THE TAPE CELL NOW HAS THREE ANSWERS, NOT TWO (R3-3, mockup states A and B). `idle, no session`
  // is the one the approved mockup always drew and the shipped code never produced. It is said
  // only when the app ACTUALLY REPORTED that no session is open: `session_open` is null on every
  // install below 0.1.8 and on the first poll after enrolment, and null is "not reported", which
  // must not be read as "idle".
  const sessionOpen = i?.session_open ?? null;

  // ── ETA-DELIVERY-EVIDENCE phase 1, amendment 1 — NOT_DELIVERING, computed HERE at read time ──
  //
  // D-11: a signal about absence cannot be emitted by the thing that is absent, so this is not
  // stored on `room_install` and not evaluated in `evaluateInstallStates` — it is derived fresh
  // against `nowMs` every time the row is read, exactly where the fleet's stall rule already
  // lives. `isBenchStalled` (imported, never re-derived) is that rule: a `recording` session
  // whose newest chunk — falling back to `started_at` on zero chunks — is older than
  // STALLED_BADGE_MINUTES. Calling it against `row.open_session` (a plain JOIN, not a new
  // signal) catches all three incidents the same way: OPD 7's wedge (chunks stopped), OPD 3's
  // vanished Mac (chunks stopped because nothing ran to produce them — no further poll needed to
  // notice), and OPD 6's phantom (zero chunks ever, via the started_at fallback). A retired
  // install's session, if any is somehow still joined, is not this Mac's to answer for.
  const openSession = i && !i.retired_at ? (row.open_session ?? null) : null;
  const notDelivering = openSession !== null && isBenchStalled(openSession, nowMs);
  const notDeliveringMinutes = !notDelivering
    ? null
    : Math.floor((nowMs - (msOf(openSession!.last_any_chunk_at) ?? msOf(openSession!.started_at) ?? nowMs)) / 60_000);

  const tapeLabel = !i
    ? null
    : sessionOpen === false
      ? "idle, no session"
      : i.tape_advancing
        ? "advancing"
        : sessionOpen === true
          ? // Incident 3's exact shape: the system must never say "recording" on a row this build
            // itself has already called NOT_DELIVERING. `notDelivering` takes precedence over the
            // ordinary "recording, not advancing" wording — the chip carries the fact instead.
            notDelivering
            ? "not advancing"
            : "recording, not advancing"
          : "not advancing";

  // STATE C. `ok` shows nothing; absent shows nothing. Only a failure speaks (R3-7).
  const failure =
    i && i.last_update_result && i.last_update_result !== "ok" ? i.last_update_result : null;
  // THE VERSION COMES FROM ITS OWN COLUMN (Fix 1, V's ruling of 9 September). The first cut of R3
  // had no column for it, so the app packed it into the head of `last_update_error` and this
  // function parsed it back out on a delimiter. That made a free-text column load-bearing — one
  // hand-edit, one truncation, and the sentence lost its subject. `last_update_version` is read
  // here and nothing is parsed.
  const updateNote = !failure
    ? null
    : [
        i!.last_update_version
          ? `Update to ${i!.last_update_version} stopped at ${fmtClock(i!.last_update_at)}.`
          : // A receipt with no version is still a report worth making, just a shorter one. Never
            // an invented version.
            `Update stopped at ${fmtClock(i!.last_update_at)}.`,
        // ─── B2-D4: THE RECEIPT'S OWN SENTENCE, AND THIS IS THE LINK THAT USED TO DROP IT ──────
        // The Mac wrote why it stopped into update-result.json, the poll carried it as
        // `last_update_error`, the row stored it — and this line printed the outcome's stock
        // sentence instead, so a canary rollback read "did not verify once it was in place" on a
        // build that verified perfectly and simply never polled. The stock sentence is now the
        // fallback for a receipt with no reason in it, which is every pre-R3 receipt.
        receiptSentence(i!.last_update_error) ??
          UPDATE_FAILURE_REASON[failure] ??
          // An outcome this build does not know the words for. Say the code rather than nothing:
          // a row that names a machine-readable reason is still a report, and silence is not.
          `The update stopped with ${failure}.`,
        i!.app_version
          ? `This Mac still runs ${i!.app_version} and is still recording.`
          : "This Mac still runs the version it had and is still recording.",
      ].join(" ");

  const channelLabel = i?.update_channel ? `channel ${i.update_channel}` : null;
  const diskLabel = fmtBytes(i?.disk_free_bytes ?? null);
  const versionHint = !i?.app_version
    ? null
    : i.update_channel === "test"
      ? // STATE E of the approved mockup: a Mac on `test` reads `test channel` under its version.
        // The card's header release is stable, and "latest 0.1.8" beside a test build answers a
        // question nobody asked.
        "test channel"
      : !latestRelease
        ? // This row's channel has nothing published. Saying "latest" would assert the Mac is up
          // to date against a shelf that is empty (F6).
          null
        : i.app_version !== latestRelease.version
          ? `latest ${latestRelease.version}`
          : "latest";
  const r3 = {
    tape_label: tapeLabel,
    update_note: updateNote,
    update_failed: failure !== null,
    channel_label: channelLabel,
    disk_label: diskLabel,
    version_hint: versionHint,
    // ── Release B2 ──────────────────────────────────────────────────────────────────────────
    disk_level: diskLevel(i?.disk_free_bytes ?? null),
    disk_text: diskText(i?.disk_free_bytes ?? null),
    peak: i?.peak ?? null,
    zero_ratio: i?.zero_ratio ?? null,
    input_devices: i?.input_devices ?? null,
    // B2-D5, generalised by the 12 Sep ruling. WAS `assigned_channel === "stable"`, written when
    // stable was the only assignable value; Tier 1 §3 made `test` assignable through the API and the
    // MCP, and under the old test a pending `test` assignment rendered NOTHING — the one case where
    // a card that says nothing is worse than one that says the wrong channel. Any assignment the Mac
    // has not yet reported is pending. A Mac that reports no channel at all (below 0.1.8) has not
    // reported the assigned one either, so its assignment is pending too.
    assigned_pending: Boolean(i && i.assigned_channel && i.update_channel !== i.assigned_channel),
    can_move_to_stable: Boolean(
      i && !i.retired_at && i.update_channel === "test" && i.assigned_channel !== "stable",
    ),
    // ── Release R4 ──────────────────────────────────────────────────────────────────────────
    input_volume: i?.input_volume ?? null,
    input_volume_settable: i?.input_volume_settable ?? null,
    volume_text: volumeText(i?.input_volume ?? null, i?.input_volume_settable ?? null),
    can_set_audio_input: Boolean(i && i.enrolled_at && !i.retired_at),
    // ── Tier 1 §2 ──────────────────────────────────────────────────────────────────────────
    // A retired row's last flags describe a Mac that no longer serves the room: not shown.
    state_flags: i && !i.retired_at ? (i.state_flags ?? []) : [],
    channel_locked: Boolean(i && !i.retired_at && i.channel_locked === true),
    // ── ETA-DELIVERY-EVIDENCE phase 1, amendment 1 ──────────────────────────────────────────
    not_delivering_minutes: notDeliveringMinutes,
  };

  // ── Session wording, needed by two branches below ────────────────────────────────────────
  const days = i ? daysUntil(i.session_expires_at, nowMs) : null;
  const expired = days !== null && days < 0;
  const sessionLabel =
    days === null ? null : expired ? "session expired" : `session expires in ${days} d`;
  const sessionWarn = days !== null && days <= SESSION_WARN_DAYS;

  // ── 1. Nothing bound ─────────────────────────────────────────────────────────────────────
  // Three ways to have no Mac, and they are not the same fact. A token is out and the paste has
  // not happened yet (`enrolling`); a Mac was bound and was retired (`retired`); or this room has
  // never had one (`not_installed`). All three wear the same word, because the word answers "can
  // this room record" and the answer is no in every case.
  if (!i) {
    words.push("not installed");
    return {
      state: row.pending ? "enrolling" : row.last_retired ? "retired" : "not_installed",
      words,
      attention: [],
      session_label: null,
      session_warn: false,
      ...r3,
    };
  }

  words.push("installed");

  // `update pending` is a WORD, never a state — see the doc comment above.
  //
  // `latestRelease` here is THIS ROW'S CHANNEL's release (F6). It used to be the stable release for
  // every row, which would have left Home Office on `test` wearing this word for ever against a
  // build it is never offered. A channel with nothing published gives null and no word.
  if (
    latestRelease &&
    !latestRelease.withdrawn_at &&
    i.app_version &&
    i.app_version !== latestRelease.version
  ) {
    words.push("update pending");
  }

  // ── 2. Expired session outranks everything ───────────────────────────────────────────────
  if (expired) {
    return {
      state: "needs_attention",
      words: [...words.filter((w) => w !== "installed"), "needs re-enrol"],
      attention: [
        "Room session expired. The app stopped polling on a 401 and will not record until this Mac is enrolled again.",
      ],
      session_label: sessionLabel,
      session_warn: true,
      ...r3,
    };
  }

  // ── 3. The four attention reasons, worst first ───────────────────────────────────────────
  if (i.mic_state === "denied") {
    attention.push("Microphone denied on this Mac. Nothing will be recorded until it is allowed.");
  }
  const seenMs = msOf(i.last_seen_at);
  const darkFor = seenMs === null ? null : nowMs - seenMs;
  if (darkFor === null || darkFor > LAST_SEEN_ALARM_MS) {
    attention.push(
      seenMs === null
        ? "Enrolled but has never polled. The app may not be running on that Mac."
        : "No poll from this Mac for over 10 minutes. Nothing is coming back on its own.",
    );
  } else if (!i.tape_advancing && sessionOpen === true) {
    // Only worth saying while the Mac is actually reachable — an offline Mac's tape state is a
    // stale reading, and reporting both would name the same silence twice.
    //
    // ─── AND ONLY WHILE A SESSION IS OPEN (R3-3) ─────────────────────────────────────────
    // This clause used to test `tape_advancing` alone, and that was the bug: an idle room with
    // nobody in it is not putting audio on the tape because there is no audio, which is not a
    // fault and is not something to send a person about. Home Office wore this warning while
    // perfectly healthy. R3 makes it worse before it makes it better — every update restarts the
    // app, and the first poll after a restart always reports the tape as not advancing — so the
    // fix ships in the same build as the restarts that would have multiplied it.
    //
    // `=== true`, NOT a truthiness test. `session_open` is null on every install below 0.1.8, and
    // null means "this app cannot tell me", which is not grounds for an alarm on a clinical
    // screen. A room on 0.1.7 therefore stops raising this line until it updates itself, which is
    // the correct trade: the warning it raised was false on an idle room anyway.
    attention.push("Tape not advancing. The room is not putting audio on the day tape.");
  }
  if (sessionWarn) {
    attention.push(`Room session ${sessionLabel}. Re-enrol this Mac with a second paste.`);
  }

  // STATE C IS NOT AN ATTENTION LINE, and that is a deliberate difference from every other fact on
  // this row. V named state C on 9 September: the sentence belongs in the App cell, under the
  // version that did not change, because the failure is a fact ABOUT THE VERSION. The row still
  // wears an `update failed` pill, and the row's STATE is untouched — a Mac that failed an update
  // is recording perfectly well on the version it has, exactly like `update pending`.

  return {
    // A FAILED UPDATE MARKS THE ROW WITHOUT ADDING A LINE TO `attention`. The approved mockup
    // draws state C's row with the attention background (`tr class="attn"`), and it draws the
    // sentence in the App cell and nowhere else. Pushing the sentence onto `attention` would
    // print it a second time in the Actions cell, where every other attention line renders; not
    // marking the row at all would leave a failure the same colour as a healthy room. So the
    // state is raised here and the words stay where V put them.
    //
    // ETA-DELIVERY-EVIDENCE phase 1, amendment 1 — `notDelivering` joins this OR-condition on
    // the same footing as `attention.length > 0` and `failure !== null`: D-6 (a degraded state
    // must not be spelled the same as a fine one) requires the ROW to move, not merely a chip to
    // appear beside an otherwise-healthy one. THIS IS NOT THE `8968b71` MECHANISM the amended
    // PRD names (`DEGRADED_STATE_FLAGS`, `bench/device-missing-row-state`) — that commit is not
    // an ancestor of this branch's base (de92359); it lives only on that unmerged branch. See
    // the Builder's report for the flag. The observable outcome is the same either way.
    state: attention.length > 0 || failure !== null || notDelivering ? "needs_attention" : "healthy",
    words,
    attention,
    session_label: sessionLabel,
    session_warn: sessionWarn,
    ...r3,
  };
}
