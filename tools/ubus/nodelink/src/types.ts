export type AgentState = "working" | "idle" | "stalled" | "errored" | "finished" | "offline";
export type AgentKind = "claude-code" | "opencode" | "codex" | "herdr-pane";
export type Runtime = "max" | "bedrock" | "bc1" | "bc2" | "opencode-bedrock" | "unknown";
export type EventKind = "agent.seen" | "agent.state" | "agent.gone" | "lane.done" | "alert" | "node.heartbeat";

export interface AgentRef {
  id: string;
  kind: AgentKind;
  pane: string | null;
  lane: string | null;
  model: string | null;
  runtime: Runtime;
  pid: number | null;
}

export interface NodeEvent {
  v: 1;
  node: string;
  seq: number;
  /** Random id generated when the spool was created; the hub tracks seq per (node, epoch). */
  epoch: string;
  ts: string;
  kind: EventKind;
  agent: AgentRef | null;
  state: AgentState | null;
  reason: string | null;
  meta: Record<string, number | string | boolean>;
}

export interface ProcInfo {
  pid: number;
  comm: string;
  args: string[];
  cwd: string | null;
  /** Cumulative CPU time in ms. */
  cpuMs: number;
  startMs: number | null;
  /** True when CLAUDE_CODE_USE_BEDROCK is present in the environment. The value is never read. */
  bedrockEnv: boolean;
}

export interface PaneInfo {
  session: string;
  paneId: string;
  cwd: string | null;
  agentStatus: string;
}

export interface LaneRow {
  lane: string;
  pane: string;
  host: string;
  model: string | null;
  startMs: number | null;
  /** herdr session the pane lives in, when lanes.tsv knows it. */
  session?: string;
}

/** Everything the scanner reads from the machine. Real implementation in sources.ts, fakes in tests. */
export interface Sources {
  procs(): ProcInfo[];
  panes(): PaneInfo[];
  /** True when the last panes() call could not execute herdr (ENOENT). */
  herdrMissing?(): boolean;
  /** Last lines of the pane text. Stays on the node. */
  paneTail(pane: PaneInfo, lines: number): string;
  lanes(): LaneRow[];
  /** Newest mtime (ms) under the worktree, or null. */
  worktreeMtime(dir: string): number | null | "unknown";
  /** Newest mtime (ms) of .bc/<lane>.done or .done.r<N> under dir, or null. */
  doneMtime(dir: string, lane: string): number | null;
  relaunch?(lane: string): void;
}

export interface Clock {
  now(): number;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}
