/**
 * lib/fleet/verbs.ts — the CLOSED, SIGNED command catalogue (TS-H4 #41, PRD §6). Fifteen verbs, nothing else: the server refuses to sign or queue any other
 * name, and every verb's params are a closed schema (unknown keys are refused). There is no free-form command text anywhere.
 *
 *   diagnose (read-only, 3)   helper_status · collect_diag · report_diag
 *   helper   (root daemon, 5) coreaudiod_reset · usb_reseat · restart_recorder · reload_launchagent · wake
 *   power    (root daemon, 2) pmset_enforce · schedule_poweron   (TS-H6 #43)
 *   app      (via XPC, 5)     list_audio_inputs · select_audio_input · self_test · pieces_inventory · pieces_reupload
 * (#42 gives the audio/lifecycle split, #43 `wake`; "5 helper verbs" is read as the four #42 helper verbs plus `wake` — the one place this build had to choose.)
 * Not provided, ever: shell, arbitrary file read/write, keychain access, account changes, network configuration, autologin.
 *
 * Canonical JSON is integers-only, so the two fractions the PRD names are integer percents here: `input_volume_pct`, `volume_pct` (0..100).
 */
export type VerbGroup = "diagnose" | "helper" | "power" | "app";
export type VerbSpec = {
  group: VerbGroup;
  /** where it runs: the root helper, or the app through XPC */
  runs: "helper" | "app";
  /** a privileged verb needs an `approval_ref` to be queued in clinic hours (07:30-21:30 IST) */
  privileged: boolean;
  /** true when this verb changes nothing on the Mac */
  readOnly: boolean;
};

export const CATALOGUE = {
  helper_status: { group: "diagnose", runs: "helper", privileged: false, readOnly: true },
  collect_diag: { group: "diagnose", runs: "helper", privileged: false, readOnly: true },
  report_diag: { group: "diagnose", runs: "app", privileged: false, readOnly: true },
  coreaudiod_reset: { group: "helper", runs: "helper", privileged: true, readOnly: false },
  usb_reseat: { group: "helper", runs: "helper", privileged: true, readOnly: false },
  restart_recorder: { group: "helper", runs: "helper", privileged: true, readOnly: false },
  reload_launchagent: { group: "helper", runs: "helper", privileged: true, readOnly: false },
  wake: { group: "helper", runs: "helper", privileged: false, readOnly: false },
  pmset_enforce: { group: "power", runs: "helper", privileged: false, readOnly: false },
  schedule_poweron: { group: "power", runs: "helper", privileged: false, readOnly: false },
  list_audio_inputs: { group: "app", runs: "app", privileged: false, readOnly: true },
  select_audio_input: { group: "app", runs: "app", privileged: false, readOnly: false },
  self_test: { group: "app", runs: "app", privileged: false, readOnly: false },
  pieces_inventory: { group: "app", runs: "app", privileged: false, readOnly: true },
  pieces_reupload: { group: "app", runs: "app", privileged: false, readOnly: false },
} as const satisfies Record<string, VerbSpec>;

export type FleetVerb = keyof typeof CATALOGUE;
export const FLEET_VERBS = Object.keys(CATALOGUE) as FleetVerb[];
export const isFleetVerb = (v: unknown): v is FleetVerb => typeof v === "string" && Object.prototype.hasOwnProperty.call(CATALOGUE, v);

/** Server envelope-signing key ids (PRD §5.1 `server_key_ids`): current + next. The helper compiles in BOTH public keys; the signer is never served. */
export const FLEET_SERVER_KEY_IDS: readonly string[] = ["fk1", "fk2"];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const intIn = (x: unknown, lo: number, hi: number): boolean => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const str = (x: unknown, min: number, max: number): boolean => typeof x === "string" && x.length >= min && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x) && !/[\uD800-\uDFFF]/.test(x);
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** schedule_poweron `time`: 24-hour HH:MM, zero padded (the helper defaults to 07:05 when it is absent) */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCOPES = ["recorder", "audio", "power", "chrome", "helper"];

/** Only these keys, each optional unless listed in `required`; every present value must pass its check. */
function closed(p: Record<string, unknown>, checks: Record<string, (v: unknown) => boolean>, required: string[] = []): boolean {
  for (const k of Object.keys(p)) if (!Object.prototype.hasOwnProperty.call(checks, k) || !checks[k]!(p[k])) return false;
  return required.every((k) => Object.prototype.hasOwnProperty.call(p, k));
}

/** True when `params` is exactly the closed shape `verb` takes (PRD §6). */
export function paramsValid(verb: unknown, params: unknown): boolean {
  if (!isFleetVerb(verb) || !isObj(params)) return false;
  switch (verb) {
    case "collect_diag": return closed(params, { scope: (v) => typeof v === "string" && SCOPES.includes(v), log_lines: (v) => intIn(v, 1, 500) }, ["scope"]);
    case "select_audio_input": return closed(params, { device_uid: (v) => str(v, 1, 128), input_volume_pct: (v) => intIn(v, 0, 100) }, ["device_uid"]);
    case "self_test": return closed(params, { volume_pct: (v) => intIn(v, 0, 100) });
    case "usb_reseat": return closed(params, { port: (v) => str(v, 1, 32) });
    case "restart_recorder": return closed(params, { force: (v) => typeof v === "boolean" });
    case "schedule_poweron": return closed(params, { time: (v) => typeof v === "string" && HHMM.test(v) });
    case "pieces_inventory":
    case "pieces_reupload": return closed(params, { since: (v) => typeof v === "string" && ISO_MS.test(v) && Number.isFinite(Date.parse(v)) });
    default: return Object.keys(params).length === 0;
  }
}

/** A `force` restart acts on a possibly-open session: it needs an approval_ref at ANY hour. */
export const needsApprovalAlways = (verb: FleetVerb, params: Record<string, unknown>): boolean => verb === "restart_recorder" && params.force === true;

const IST_OFFSET_MS = 5.5 * 3_600_000;
/** 07:30 inclusive to 21:30 exclusive, IST, every day. */
export function inClinicHours(ms: number): boolean {
  const m = new Date(ms + IST_OFFSET_MS);
  const mins = m.getUTCHours() * 60 + m.getUTCMinutes();
  return mins >= 7 * 60 + 30 && mins < 21 * 60 + 30;
}

export const APPROVAL_REF_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Verbs that RESET or RESTART something on a Mac that may be recording (#42 gates). While the room has an open session (recording or paused) they need an `approval_ref`,
 * and `restart_recorder` additionally needs `force:true`. (`usb_reseat` is included: it is a reset of the input hardware.)
 */
export const SESSION_GATED_VERBS: readonly FleetVerb[] = ["coreaudiod_reset", "usb_reseat", "restart_recorder", "reload_launchagent"];

/** Device ceilings, enforced at enqueue (the helper compiles in the same numbers as its own last line of defence). A command counts from the moment it is issued unless it expired undelivered. */
export const CEILINGS = {
  /** at most this many coreaudiod_reset per device per window */
  coreaudiod_reset: { max: 1, windowS: 30 * 60 },
  /** at most this many privileged verbs per device per window */
  privileged: { max: 10, windowS: 60 * 60 },
} as const;
