/**
 * The read-only JSON views the board renders (CONTRACT "JSON views"):
 * GET /api/v3/agents, GET /api/v3/lanes, GET /api/v3/messages.
 * The board only reads them, so this file is the board's copy of the shapes
 * it consumes. The hub lane builds the real endpoints in parallel.
 */

export type AgentState = "working" | "idle" | "stalled" | "errored" | "finished" | "offline";

export interface AgentView {
  id: string;
  node: string;
  kind: string;
  lane: string | null;
  pane: string | null;
  model: string | null;
  state: AgentState;
  /** ISO timestamp of the last heartbeat, or null when never seen. */
  last_heartbeat: string | null;
  /** Subject of the agent's last message (id/subject only, never a body). */
  last_message?: string | null;
}

export type LaneState =
  | "proposed"
  | "claimed"
  | "building"
  | "built"
  | "refuting"
  | "pass"
  | "fail"
  | "merged"
  | "abandoned";

export interface LaneView {
  lane_id: string;
  title: string;
  brief_ref: string;
  owner: string;
  builder: string | null;
  refuter: string | null;
  branch: string | null;
  state: LaneState;
  verdict_ref: string | null;
}

export type MessageState = "stored" | "delivered" | "read" | "acked" | "done" | "rejected";

export interface RecipientMsgState {
  state: MessageState;
  reason: string;
}

export interface MessageView {
  id: string;
  ts: string;
  from: string;
  to: string[];
  kind: string;
  priority: string;
  subject: string;
  body: string;
  body_ref: string;
  lane: string | null;
  /** SLA in seconds; a message with an SLA is treated as an order. */
  sla_s?: number;
  /** Per-recipient state, keyed by recipient handle. */
  states: Record<string, RecipientMsgState>;
}

export interface BoardViews {
  agents: AgentView[];
  lanes: LaneView[];
  messages: MessageView[];
}

/** What the board reads from. Tests fake this; the hub HTTP source implements it. */
export interface BoardSource {
  views(): Promise<BoardViews>;
}
