/**
 * lib/fleet/verbs.ts — the CLOSED command catalogue v1 (PRD §6), names only. The server refuses to queue anything else, so there is no route and no code path by
 * which an arbitrary shell string can become a command. Per-verb param schemas and the helper-side gates arrive with TS-H4 (#41).
 * Not provided, ever: shell, arbitrary file read/write, keychain access, account changes, network configuration, autologin.
 */
export const FLEET_VERBS = [
  "helper_status", "collect_diag", "report_diag",
  "list_audio_inputs", "select_audio_input", "coreaudiod_reset", "usb_reseat", "self_test",
  "restart_recorder", "reload_launchagent", "pieces_inventory", "pieces_reupload",
  "wake", "pmset_enforce", "schedule_poweron",
  "chrome_policy_apply", "chrome_relaunch", "open_pulse", "policy_cycle",
  "update_bundle", "rollback_bundle",
  "rotate_identity", "set_local_kill_switch", "retire_legacy", "breakglass_enable", "breakglass_disable",
] as const;
export type FleetVerb = (typeof FLEET_VERBS)[number];
export const isFleetVerb = (v: unknown): v is FleetVerb => typeof v === "string" && (FLEET_VERBS as readonly string[]).includes(v);

/** Server envelope-signing key ids (PRD §5.1 `server_key_ids`): current + next. Ids only; the public keys and the signer arrive with TS-H4 (#41). */
export const FLEET_SERVER_KEY_IDS: readonly string[] = ["fk1", "fk2"];
