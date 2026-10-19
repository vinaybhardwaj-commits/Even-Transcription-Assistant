import { readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const NODE_NAMES = ["mini", "air", "t4", "c3", "c4", "asus", "yoga"];

export interface NodelinkConfig {
  node: string;
  hubUrl: string;
  scanIntervalMs: number;
  heartbeatIntervalMs: number;
  flushIntervalMs: number;
  stallMs: number;
  herdrSessions: string[];
  /** herdr executable; install resolves it to an absolute path (launchd/systemd have a minimal PATH). */
  herdrBin: string;
  /** herdr session that lanes.tsv panes live in (lanes.tsv has no session column). */
  laneSession: string;
  /** lanes.tsv host label (lowercase) -> node name. Hosts are otherwise matched exactly. */
  hostAliases: Record<string, string>;
  lanesTsv: string;
  keyFile: string;
  spoolDb: string;
  stateFile: string;
  /** Lane name -> policy. auto_relaunch defaults to off. */
  lanePolicy: Record<string, { auto_relaunch?: boolean }>;
  /** Command for relaunching a lane: [exe, ...args]; the lane name is appended. */
  relaunchCmd: string[] | null;
}

export function ubusDir(): string {
  return join(process.env.UBUS_HOME || join(homedir(), ".ubus"));
}

export function defaultConfig(): NodelinkConfig {
  const d = ubusDir();
  const host = hostname().toLowerCase();
  const guess = NODE_NAMES.find((n) => host.startsWith(n)) ?? host.split(/[.-]/)[0];
  return {
    node: guess,
    hubUrl: "http://127.0.0.1:8787",
    scanIntervalMs: 15_000,
    heartbeatIntervalMs: 30_000,
    flushIntervalMs: 5_000,
    stallMs: 10 * 60_000,
    herdrSessions: ["default"],
    herdrBin: "herdr",
    laneSession: "default",
    hostAliases: { "asus-ubuntu": "asus" },
    lanesTsv: join(homedir(), "oc", "bc", "out", "lanes.tsv"),
    keyFile: join(d, "node.key"),
    spoolDb: join(d, "nodelink-spool.db"),
    stateFile: join(d, "nodelink.state.json"),
    lanePolicy: {},
    relaunchCmd: null,
  };
}

export function loadConfig(path = join(ubusDir(), "nodelink.json")): NodelinkConfig {
  const cfg = defaultConfig();
  try {
    Object.assign(cfg, JSON.parse(readFileSync(path, "utf8")) as Partial<NodelinkConfig>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`bad config ${path}`);
  }
  return cfg;
}

/** Refuses a key file that is group/world accessible. The key is returned, never logged. */
export function readNodeKey(file: string): string {
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`refusing ${file}: mode must be 0600`);
  const key = readFileSync(file, "utf8").trim();
  if (!key) throw new Error(`empty key file ${file}`);
  return key;
}
