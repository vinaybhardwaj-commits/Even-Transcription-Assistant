import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHandoff, FakeHerdr, FakeOpenBot, MapWhois, SqliteEtaAdapter, type HerdrAgent } from "../src/adapters.js";
import { ScriptedProbe } from "../src/archive.js";
import type { Caller } from "../src/bus.js";
import { Ubus } from "../src/bus.js";
import { defaultConfig, type UbusConfig } from "../src/config.js";
import { TIME_MACHINE_VOLUME_UUID } from "../src/constants.js";
import { createUbus } from "../src/create.js";
import { ManualClock } from "../src/util.js";

export interface TestRig {
  dir: string;
  clock: ManualClock;
  cfg: UbusConfig;
  eta: SqliteEtaAdapter;
  herdr: FakeHerdr;
  openbot: FakeOpenBot;
  handoff: FakeHandoff;
  whois: MapWhois;
  probe: ScriptedProbe;
  ubus: Ubus;
  cleanup: () => void;
}

export function setup(patch?: (cfg: UbusConfig) => void): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "ubus-"));
  const clock = new ManualClock(Date.parse("2026-10-11T08:00:00.000Z"));
  const cfg = defaultConfig(dir);
  cfg.spoolDir = join(dir, "spool");
  cfg.auditPath = join(dir, "audit", "audit.jsonl");
  cfg.stopFile = join(dir, "STOP");
  cfg.dbPath = join(dir, "ubus.db");
  cfg.groupsFile = join(process.cwd(), "test", "fixtures", "groups.json");
  cfg.volumeMount = join(dir, "volume");
  cfg.coldRoot = join(dir, "volume", "cold", "ubus-log");
  cfg.expectedVolumeUuid = TIME_MACHINE_VOLUME_UUID;
  cfg.eta = { mode: "sqlite", dbPath: join(dir, "eta.db"), readOnly: false, table: "posts" };
  patch?.(cfg);
  const eta = new SqliteEtaAdapter(cfg.eta.dbPath || join(dir, "eta.db"));
  const herdr = new FakeHerdr();
  const openbot = new FakeOpenBot();
  const handoff = new FakeHandoff();
  const whois = new MapWhois(new Map());
  const probe = new ScriptedProbe({ mounted: true, uuid: TIME_MACHINE_VOLUME_UUID, writable: true });
  const ubus = createUbus(cfg, { clock, eta, herdr, openbot, handoff, whois, probe });
  return {
    dir,
    clock,
    cfg,
    eta,
    herdr,
    openbot,
    handoff,
    whois,
    probe,
    ubus,
    cleanup() {
      ubus.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function caller(handle?: string, machine = "mini"): Caller {
  return { handle, machine, machineVerified: true, via: "local" };
}

export async function register(
  ubus: Ubus,
  handle: string,
  extra: Record<string, unknown> = {},
  machine = "mini",
): Promise<Record<string, unknown>> {
  return ubus.call(
    "ubus_register",
    {
      handle,
      machine,
      runtime: "claude-code",
      session: `s:${handle}`,
      owner: "fable",
      orchestrator: "fable",
      ...extra,
    },
    caller(undefined, machine),
  );
}

export function pane(name: string, owner: string, machine = "mini", state: HerdrAgent["state"] = "idle"): HerdrAgent {
  return { name, machine, runtime: "claude-code", state, busy: state === "busy", owner, herdrSession: "default" };
}

/** process.env without the caller's ubus/herdr identity, so spawned hooks and shims derive only what the test sets. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "UBUS_HANDLE" || k.startsWith("HERDR_") || k === "UBUS_SESSION" || k === "UBUS_SESSION_ID" || k === "CLAUDE_SESSION_ID") delete env[k];
  }
  return env;
}
