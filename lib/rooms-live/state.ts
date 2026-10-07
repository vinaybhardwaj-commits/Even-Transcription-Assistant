/**
 * lib/rooms-live/state.ts — the six Rooms Live states (SPEC-v1 §3). PURE: facts and a clock go in, one state comes out. No I/O, no Date.now().
 *
 * RULES, first match wins (all ages from server timestamps):
 *   1 off        listener age > 10 s AND heartbeat age > 180 s AND ext/poller age > 180 s. (A source that could not be read is `unknown`, never `off`.)
 *   2 unplugged  state_flags has DEVICE_MISSING, or input_devices lacks input_device_name, while the listener is fresh (<= 10 s).
 *   3 notrec     listener fresh and no open SERVER session (server truth beats listener.recording_session_id); also a stale listener that rule 1 did not catch
 *                (detail app_not_responding).
 *   -  muted     open session AND state_flags SILENT_WHILE_RECORDING (the recorder's own 2-minute test).
 *   -  stale     a stale level never yields muted/quiet/listening by itself: notrec, detail level_stale.
 *   4 muted      ("Mic silent") open session AND zero_ratio >= 0.995 sustained for >= 60 s: a real silenced input is exact digital zero. 0.95-0.995 is NOT silence (FIX-1 F3b).
 *   5 quiet      open session AND not muted AND 10 s mean rms < max(0.008, 1.5 x the room's p25 rms over the last 15 min).
 *   6 listening  open session AND not muted AND at or above that threshold, or any single row in the last 10 s >= 2.5 x the baseline (never below 0.008).
 * LEVEL `stale`: levels_at older than 6 s, OR the identical (rms, zero) pair for more than 6 s. DIGITAL SILENCE IS THE EXCEPTION to the second test: a muted mic
 * legitimately reports (0, 1.0) minute after minute (live: OPD 3), so an identical pair with rms 0 and zero >= 0.95 is not "frozen". A frozen tail after an unplug
 * has a non-zero rms (live: 0.0164 / 0.73, 0.0125 / 0.00) and is caught.
 * Steward overlay: a newest decision within 10 min with action scribe_start and mode live sets detail_code "restarting" (the state itself is unchanged).
 */
export const LISTENER_FRESH_S = 10;
export const HEARTBEAT_FRESH_S = 180;
export const EXT_FRESH_S = 180;
export const LEVEL_FRESH_S = 6;
export const MUTE_ZERO = 0.995;
export const MUTE_SUSTAIN_S = 60;
export const QUIET_FLOOR = 0.008;
export const BASELINE_FACTOR = 1.5;
export const SPIKE_FACTOR = 2.5;
export const MEAN_WINDOW_S = 10;
export const BASELINE_WINDOW_S = 15 * 60;
export const BASELINE_MIN_ROWS = 30;
export const STEWARD_OVERLAY_S = 10 * 60;
export const MUTE_ROW_MAX_AGE_S = 15;

export type RoomStateName = "off" | "unplugged" | "notrec" | "muted" | "quiet" | "listening" | "unknown";

export type LevelRow = { t: number; rms: number; zero: number | null };

export type StateInput = {
  now: number;
  /** bench_listener row; null = none */
  listener: { last_poll_at: number | null; levels_at: number | null; rms: number | null; zero: number | null } | null;
  install: { flags: readonly string[]; state_changed_at: number | null; input_device_name: string | null; input_devices: readonly string[] | null } | null;
  session: { open: boolean; since: number | null; chunk_age_s: number | null };
  heartbeat_at: number | null;
  ext_at: number | null;
  /** recording rows of the last 15 min, any order */
  levels: readonly LevelRow[];
  steward: { action: string; mode: string; at: number } | null;
  /** which sources answered; false = that read failed (degraded) */
  known: { listener: boolean; install: boolean; session: boolean; heartbeat: boolean; ext: boolean; levels: boolean };
};

export type StateResult = {
  state: RoomStateName;
  detail_code: string | null;
  state_since: number | null;
  level: { rms: number | null; zero: number | null; at: number | null; stale: boolean };
  baseline_rms: number | null;
  device: { name: string | null; missing: boolean };
  ages_s: { listener: number | null; heartbeat: number | null; ext: number | null };
};

const ageS = (now: number, t: number | null): number | null => (t === null || !Number.isFinite(t) ? null : Math.max(0, (now - t) / 1000));

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
}

export function deviceMissing(i: StateInput["install"]): boolean {
  if (!i) return false;
  if (i.flags.includes("DEVICE_MISSING")) return true;
  return !!i.input_device_name && Array.isArray(i.input_devices) && !i.input_devices.includes(i.input_device_name);
}

/** the level series: history rows plus the listener's own newest reading when it is newer than the last row */
function series(inp: StateInput): LevelRow[] {
  const rows = [...inp.levels].filter((r) => Number.isFinite(r.t) && r.t <= inp.now + 2000).sort((a, b) => a.t - b.t);
  const l = inp.listener;
  if (l && l.levels_at !== null && l.rms !== null && (rows.length === 0 || l.levels_at > rows[rows.length - 1]!.t)) rows.push({ t: l.levels_at, rms: l.rms, zero: l.zero });
  return rows;
}

const isMuteRow = (r: LevelRow): boolean => r.zero !== null && r.zero >= MUTE_ZERO;
const isDigitalSilence = (r: LevelRow): boolean => r.rms <= 0.0005 && r.zero !== null && r.zero >= 0.95;

/** milliseconds for which the newest (rms, zero) pair has been identical, from the series */
function identicalForMs(rows: readonly LevelRow[]): number {
  if (rows.length === 0) return 0;
  const last = rows[rows.length - 1]!;
  let first = last.t;
  for (let i = rows.length - 2; i >= 0; i--) {
    const r = rows[i]!;
    if (r.rms === last.rms && r.zero === last.zero) first = r.t;
    else break;
  }
  return last.t - first;
}

export function computeState(inp: StateInput): StateResult {
  const { now } = inp;
  const l = inp.listener;
  const listenerAge = ageS(now, l?.last_poll_at ?? null);
  const hbAge = ageS(now, inp.heartbeat_at);
  const extAge = ageS(now, inp.ext_at);
  const listenerFresh = listenerAge !== null && listenerAge <= LISTENER_FRESH_S;
  const rows = series(inp);
  const newest = rows.length ? rows[rows.length - 1]! : null;
  const levelAt = l?.levels_at ?? newest?.t ?? null;
  const levelAge = ageS(now, levelAt);
  const frozen = !!newest && !isDigitalSilence(newest) && identicalForMs(rows) > LEVEL_FRESH_S * 1000;
  const levelStale = levelAge === null || levelAge > LEVEL_FRESH_S || frozen;

  const baseRows = rows.filter((r) => now - r.t <= BASELINE_WINDOW_S * 1000 && (r.zero === null || r.zero < MUTE_ZERO));
  const baseline = baseRows.length >= BASELINE_MIN_ROWS ? percentile(baseRows.map((r) => r.rms), 25) : null;
  const threshold = Math.max(QUIET_FLOOR, BASELINE_FACTOR * (baseline ?? 0));

  const miss = deviceMissing(inp.install);
  const out = (state: RoomStateName, detail: string | null, since: number | null): StateResult => {
    const overlay = inp.steward && inp.steward.action === "scribe_start" && inp.steward.mode === "live" && now - inp.steward.at <= STEWARD_OVERLAY_S * 1000 && inp.steward.at <= now + 5000;
    return {
      state,
      detail_code: overlay && state !== "listening" && state !== "quiet" && state !== "muted" ? "restarting" : detail,
      state_since: since,
      level: { rms: l?.rms ?? newest?.rms ?? null, zero: l?.zero ?? newest?.zero ?? null, at: levelAt, stale: levelStale },
      baseline_rms: baseline,
      device: { name: inp.install?.input_device_name ?? null, missing: miss },
      ages_s: { listener: listenerAge, heartbeat: hbAge, ext: extAge },
    };
  };

  // sources that failed make the room `unknown`, never a guess
  if (!inp.known.listener || !inp.known.install || !inp.known.session) return out("unknown", "source_unavailable", null);

  // 1 off
  if (!listenerFresh) {
    if (!inp.known.heartbeat || !inp.known.ext) return out("unknown", "source_unavailable", null);
    if ((hbAge === null || hbAge > HEARTBEAT_FRESH_S) && (extAge === null || extAge > EXT_FRESH_S)) return out("off", null, null);
    // 3 (stale listener, Mac still talking)
    return out("notrec", "app_not_responding", null);
  }
  // 2 unplugged
  if (miss) return out("unplugged", null, inp.install?.state_changed_at ?? null);
  // 3 not recording (server truth)
  if (!inp.session.open) return out("notrec", null, null);

  // open session from here
  if (inp.install?.flags.includes("SILENT_WHILE_RECORDING")) return out("muted", "silent_flag", sinceOfRun(rows, isMuteRow));
  if (!inp.known.levels && rows.length < 3) return out("unknown", "levels_unavailable", null);
  if (levelStale) return out("notrec", "level_stale", null);

  // 4 muted ("Mic silent"): zero_ratio >= 0.995 on every row of an unbroken run that has lasted >= 60 s and is still current
  const run = sinceOfRun(rows, isMuteRow);
  if (run !== null && newest && now - newest.t <= MUTE_ROW_MAX_AGE_S * 1000 && newest.t - run >= MUTE_SUSTAIN_S * 1000) return out("muted", null, run);

  // 5 / 6 quiet vs listening
  // exact-zero rows count as silence (rms ~0) here: a mute that is younger than 60 s reads as Quiet, never as a stale level
  const recent = rows.filter((r) => now - r.t <= MEAN_WINDOW_S * 1000);
  if (recent.length === 0) return out("notrec", "level_stale", null);
  const mean = recent.reduce((a, r) => a + r.rms, 0) / recent.length;
  // a spike is 2.5 x the room's own baseline, but never below the quiet floor: a near-silent mic (baseline ~0.0003) would otherwise call 0.0008 "speech" (found in the live smoke, OPD 5)
  const spikeAt = baseline === null ? Infinity : Math.max(QUIET_FLOOR, SPIKE_FACTOR * baseline);
  const spike = recent.some((r) => r.rms >= spikeAt);
  const loud = mean >= threshold || spike;
  const rowLoud = (r: LevelRow): boolean => r.rms >= threshold || r.rms >= spikeAt;
  if (loud) return out("listening", null, sinceOfRun(rows, (r) => !isMuteRow(r) && rowLoud(r)));
  return out("quiet", null, sinceOfRun(rows, (r) => !isMuteRow(r) && !rowLoud(r)));
}

/** the earliest time of the unbroken run of rows matching `pred` that ends at the newest row; null when the newest does not match */
export function sinceOfRun(rows: readonly LevelRow[], pred: (r: LevelRow) => boolean): number | null {
  if (rows.length === 0 || !pred(rows[rows.length - 1]!)) return null;
  let since = rows[rows.length - 1]!.t;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (!pred(rows[i]!)) break;
    since = rows[i]!.t;
  }
  return since;
}
