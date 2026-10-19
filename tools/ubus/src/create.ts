import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Archive, systemVolumeProbe, type VolumeProbe } from "./archive.js";
import {
  CommandEtaAdapter,
  CommandHerdr,
  CommandWhois,
  FakeHandoff,
  FakeHerdr,
  FakeOpenBot,
  HttpHandoff,
  HttpOpenBot,
  MapWhois,
  SqliteEtaAdapter,
  type EtaAdapter,
  type HandoffAdapter,
  type HerdrAdapter,
  type OpenBotAdapter,
  type Whois,
} from "./adapters.js";
import { Ubus } from "./bus.js";
import { type UbusConfig } from "./config.js";
import { Store } from "./store.js";
import { SystemClock, type Clock } from "./util.js";

export interface CreateOverrides {
  clock?: Clock;
  eta?: EtaAdapter;
  herdr?: HerdrAdapter;
  openbot?: OpenBotAdapter;
  handoff?: HandoffAdapter;
  whois?: Whois;
  probe?: VolumeProbe;
  freeRatio?: () => number;
}

export function createUbus(config: UbusConfig, overrides: CreateOverrides = {}): Ubus {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.auditPath), { recursive: true, mode: 0o700 });
  const clock = overrides.clock ?? new SystemClock();
  const store = new Store(config.dbPath);
  const eta = overrides.eta ?? buildEta(config);
  const herdr = overrides.herdr ?? buildHerdr(config);
  const openbot = overrides.openbot ?? buildOpenbot(config);
  const handoff = overrides.handoff ?? buildHandoff(config);
  const probe = overrides.probe ?? systemVolumeProbe();
  const box: { ubus?: Ubus } = {};
  const archive = new Archive(
    config.spoolDir,
    config.coldRoot,
    config.volumeMount,
    config.expectedVolumeUuid,
    clock,
    probe,
    (info) => box.ubus?.raiseAlert(info),
    {
      maxSpoolBytes: config.limits.maxSpoolBytes,
      minFreeRatio: config.limits.minFreeRatio,
      freeRatio: overrides.freeRatio,
    },
  );
  box.ubus = new Ubus(config, store, archive, eta, herdr, openbot, handoff, clock, () => loadGroupFile(config.groupsFile));
  return box.ubus;
}

export function buildWhois(config: UbusConfig, override?: Whois): Whois {
  if (override) return override;
  if (config.whois.mode === "command") return new CommandWhois(config.whois.command);
  return new MapWhois(new Map());
}

function buildEta(config: UbusConfig): EtaAdapter {
  if (config.eta.mode === "command") {
    return new CommandEtaAdapter(config.eta.postCommand ?? [], config.eta.tailDbPath || config.eta.dbPath || "", config.eta.table);
  }
  return new SqliteEtaAdapter(config.eta.dbPath || `${config.dataDir}/eta-fake.db`, {
    readOnly: config.eta.readOnly,
    table: config.eta.table,
  });
}

function buildHerdr(config: UbusConfig): HerdrAdapter {
  if (config.herdr.mode === "command" && config.herdr.command?.length) return new CommandHerdr(config.herdr.command);
  return new FakeHerdr();
}

function buildOpenbot(config: UbusConfig): OpenBotAdapter {
  if (config.openbot.mode === "http" && config.openbot.baseUrl) return new HttpOpenBot(config.openbot.baseUrl);
  return new FakeOpenBot();
}

function buildHandoff(config: UbusConfig): HandoffAdapter {
  if (config.handoff.mode === "http" && config.handoff.url) return new HttpHandoff(config.handoff.url);
  return new FakeHandoff();
}

function loadGroupFile(file: string): { defs: Record<string, { members?: string[]; dynamic?: "grok" | "panes" | "all"; machine?: string; owner_gated_grok?: boolean; restricted?: boolean }>; mtime: number } {
  if (!existsSync(file)) return { defs: {}, mtime: 0 };
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return { defs: raw as never, mtime: statSync(file).mtimeMs };
}
