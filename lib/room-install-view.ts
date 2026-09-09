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
 */

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
  /** The reason line that went with it. */
  last_update_error: string | null;
  /** When the swap script recorded that outcome, by the Mac's clock. */
  last_update_at: string | null;
  /** V, 9 Sep. Free bytes on the captures volume. NULL = not reported. NEVER 0. */
  disk_free_bytes: number | null;
};

export type UpdateChannel = "stable" | "test";

/** §13.4 — the six outcomes update-result.json can carry. */
export type UpdateResult =
  | "ok"
  | "checksum_mismatch"
  | "signature_mismatch"
  | "download_failed"
  | "expand_failed"
  | "swap_failed";

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
};

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
};

export type FleetPayload = {
  now: string;
  rows: FleetRow[];
  latest_release: ReleaseView | null;
  degraded: string[];
};

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
};

/**
 * The separator the app puts between the version it was attempting and what it measured.
 *
 * ─── WHY THE VERSION TRAVELS INSIDE THE REASON LINE ──────────────────────────────────────
 * §13.4 fixes the R3 columns at five, and V's 9 September addition made six. NONE of them is the
 * version an update was attempting, and the mockup's sentence names it: "Update to 0.1.8 stopped
 * at 09:14." Rather than invent a seventh column against a ratified list, the app writes the
 * version at the head of `last_update_error`, which §13.4 calls "the reason line", and this module
 * reads it back. Writer and reader ship in the same build.
 *
 * A LINE THAT DOES NOT MATCH IS STILL RENDERED, whole, as the reason, with no version in the
 * sentence. A truncated or hand-edited value must degrade to a shorter true sentence, never to a
 * crash and never to a version this module made up. FLAGGED in the build report for V.
 */
export const UPDATE_ERROR_SEPARATOR = " — ";

/** PURE — the version an update was attempting, out of the reason line. Null when unreadable. */
export function attemptedVersion(lastUpdateError: string | null): string | null {
  if (!lastUpdateError) return null;
  const head = lastUpdateError.split(UPDATE_ERROR_SEPARATOR)[0]?.trim() ?? "";
  return /^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z.]+)?$/.test(head) ? head : null;
}

/** Whole days until the session expires. Negative once it has. */
export function daysUntil(iso: string | null, nowMs: number): number | null {
  const t = msOf(iso);
  if (t === null) return null;
  return Math.floor((t - nowMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// The five checklist steps (§6, D11)
// ---------------------------------------------------------------------------

export type StepState = "done" | "waiting" | "blocked";

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
  const bits = [i.hostname ?? "this Mac", i.hardware_model, i.os_version].filter(Boolean);
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
  const started = i?.first_seen_at ?? null;
  const step2: Step =
    i?.launched_by === "launchd"
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
  const step3: Step =
    i?.mic_state === "authorized"
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
  const autoLoginNote =
    "Automatic login: set it in System Settings → Users & Groups → Automatic login (reminder, not checked).";
  const step5: Step =
    i?.never_sleep === true
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
};

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
 *   3 NEEDS ATTENTION mic denied, tape not advancing, session expiring inside 30 days, or last
 *                     seen older than the alarm window.
 *   4 HEALTHY         none of the above. `update pending` rides alongside as a word, never as a
 *                     state: a room on the previous version is recording perfectly well.
 */
export function deriveRow(input: {
  row: FleetRow;
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
  const tapeLabel = !i
    ? null
    : sessionOpen === false
      ? "idle, no session"
      : i.tape_advancing
        ? "advancing"
        : sessionOpen === true
          ? "recording, not advancing"
          : "not advancing";

  // STATE C. `ok` shows nothing; absent shows nothing. Only a failure speaks (R3-7).
  const failure =
    i && i.last_update_result && i.last_update_result !== "ok" ? i.last_update_result : null;
  const updateNote = !failure
    ? null
    : [
        attemptedVersion(i!.last_update_error) === null
          ? `Update stopped at ${fmtClock(i!.last_update_at)}.`
          : `Update to ${attemptedVersion(i!.last_update_error)} stopped at ${fmtClock(i!.last_update_at)}.`,
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
      ? "test channel"
      : latestRelease && i.app_version !== latestRelease.version
        ? `latest ${latestRelease.version}`
        : "latest";
  const r3 = {
    tape_label: tapeLabel,
    update_note: updateNote,
    update_failed: failure !== null,
    channel_label: channelLabel,
    disk_label: diskLabel,
    version_hint: versionHint,
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
    state: attention.length > 0 || failure !== null ? "needs_attention" : "healthy",
    words,
    attention,
    session_label: sessionLabel,
    session_warn: sessionWarn,
    ...r3,
  };
}
