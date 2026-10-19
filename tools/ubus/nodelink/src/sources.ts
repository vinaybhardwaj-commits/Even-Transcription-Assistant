import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnvironKeys } from "./classify.js";
import type { NodelinkConfig } from "./config.js";
import type { LaneRow, PaneInfo, ProcInfo, Sources } from "./types.js";

const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 << 20 });

function linuxProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  let btime = 0;
  try {
    btime = Number(/^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1] ?? 0);
  } catch { /* ignore */ }
  const hz = 100;
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const comm = readFileSync(`/proc/${d}/comm`, "utf8").trim();
      if (!/^(claude|opencode|codex)/.test(comm)) continue;
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cpuMs = ((Number(f[11]) + Number(f[12])) * 1000) / hz;
      const startMs = btime ? (btime + Number(f[19]) / hz) * 1000 : null;
      const args = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean);
      let cwd: string | null = null;
      try { cwd = readlinkSync(`/proc/${d}/cwd`); } catch { /* ignore */ }
      let bedrockEnv = false;
      try { bedrockEnv = parseEnvironKeys(readFileSync(`/proc/${d}/environ`)).has("CLAUDE_CODE_USE_BEDROCK"); } catch { /* ignore */ }
      out.push({ pid: Number(d), comm, args, cwd, cpuMs, startMs, bedrockEnv });
    } catch { /* process vanished */ }
  }
  return out;
}

function parseCpuTime(s: string): number {
  // [[dd-]hh:]mm:ss(.xx)
  const [dayPart, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const p = rest.split(":").map(Number);
  while (p.length < 3) p.unshift(0);
  return (((Number(dayPart) * 24 + p[0]) * 60 + p[1]) * 60 + p[2]) * 1000;
}

function macProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  // comm may contain spaces, so it comes from its own call: "pid comm-with-spaces"
  const comms = new Map<number, string>();
  for (const line of sh("ps", ["-axo", "pid=,comm="]).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) comms.set(Number(m[1]), (m[2].split("/").pop() ?? "").trim());
  }
  const now = Date.now();
  for (const line of sh("ps", ["-axo", "pid=,cputime=,etime=,args="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const comm = comms.get(pid) ?? "";
    if (!/^(claude|opencode|codex)/.test(comm)) continue;
    let cwd: string | null = null;
    try {
      cwd = /^n(.*)$/m.exec(sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))?.[1] ?? null;
    } catch { /* ignore */ }
    let bedrockEnv = false;
    try {
      // presence check only: the output is searched for the key and discarded
      bedrockEnv = sh("ps", ["eww", "-p", String(pid)]).includes("CLAUDE_CODE_USE_BEDROCK=");
    } catch { /* ignore */ }
    out.push({ pid, comm, args: m[4].split(/\s+/).filter(Boolean), cwd, cpuMs: parseCpuTime(m[2]), startMs: now - parseCpuTime(m[3]), bedrockEnv });
  }
  return out;
}

function newestMtime(dir: string, maxEntries = 3000): number | null | "unknown" {
  let newest = 0, seen = 0, capped = false;
  const walk = (d: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (seen++ > maxEntries) { capped = true; return; }
      if (n === ".git" || n === "node_modules" || n === "dist") continue;
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.isDirectory() && depth < 4) walk(p, depth + 1);
      } catch { /* ignore */ }
    }
  };
  walk(dir, 0);
  return capped ? "unknown" : newest || null;
}

export function realSources(cfg: NodelinkConfig): Sources {
  const herdrArgs = (session: string) => (session === "default" ? [] : ["--session", session]);
  let herdrMissing = false;
  return {
    herdrMissing: () => herdrMissing,
    procs: () => (process.platform === "darwin" ? macProcs() : linuxProcs()),
    panes(): PaneInfo[] {
      const out: PaneInfo[] = [];
      herdrMissing = false;
      for (const session of cfg.herdrSessions) {
        try {
          const j = JSON.parse(sh(cfg.herdrBin, [...herdrArgs(session), "pane", "list"])) as { result?: { panes?: Array<Record<string, unknown>> } };
          for (const p of j.result?.panes ?? []) {
            out.push({ session, paneId: String(p.pane_id), cwd: typeof p.cwd === "string" ? p.cwd : null, agentStatus: String(p.agent_status ?? "unknown") });
          }
        } catch (err) {
          // a missing or unusable binary is an install fault, not "session not running"
          // any spawn failure (ENOENT, EACCES, ETIMEDOUT, ...) has err.code and no exit status; a non-zero exit has err.status
          const e = err as NodeJS.ErrnoException & { status?: number | null };
          if (typeof e?.code === "string" && typeof e.status !== "number") { herdrMissing = true; break; }
        }
      }
      return out;
    },
    paneTail(pane, lines) {
      return sh(cfg.herdrBin, [...herdrArgs(pane.session), "pane", "read", pane.paneId, "--source", "recent", "--lines", String(lines)]);
    },
    lanes(): LaneRow[] {
      let text: string;
      try { text = readFileSync(cfg.lanesTsv, "utf8"); } catch { return []; }
      const rows: LaneRow[] = [];
      for (const line of text.split("\n")) {
        const c = line.split("\t").length > 1 ? line.split("\t") : line.trim().split(/\s+/);
        if (c.length < 4 || !c[0]) continue;
        let startMs: number | null = null;
        const hm = /^(\d{1,2}):(\d{2})$/.exec(c[4] ?? "");
        if (hm) {
          const d = new Date();
          d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
          if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
          startMs = d.getTime();
        }
        rows.push({ lane: c[0], pane: c[2], host: c[3], model: c[5] || null, startMs, session: c[6] || undefined });
      }
      return rows;
    },
    worktreeMtime: (dir) => newestMtime(dir),
    doneMtime(dir, lane) {
      const bc = join(dir, ".bc");
      let newest = 0;
      try {
        for (const n of readdirSync(bc)) {
          if (n === `${lane}.done` || new RegExp(`^${lane.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.done\\.r\\d+$`).test(n)) {
            newest = Math.max(newest, statSync(join(bc, n)).mtimeMs);
          }
        }
      } catch { /* no .bc */ }
      return newest || null;
    },
    relaunch(lane) {
      if (!cfg.relaunchCmd?.length || !existsSync(cfg.relaunchCmd[0])) throw new Error("no relaunch command");
      execFileSync(cfg.relaunchCmd[0], [...cfg.relaunchCmd.slice(1), lane], { timeout: 30_000, stdio: "ignore" });
    },
  };
}
