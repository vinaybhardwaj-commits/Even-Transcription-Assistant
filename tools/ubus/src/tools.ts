export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };

/** Optional on every tool. Stateless MCP clients repeat these; ubus resolves them against the directory. */
const identity = {
  handle: str,
  from: { anyOf: [str, { type: "object", properties: { handle: str, machine: str, runtime: str, session: str } }] },
  machine: str,
  runtime: str,
  session: str,
};

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties: { ...identity, ...properties },
  required,
  additionalProperties: true,
});

export const TOOLS: ToolDef[] = [
  {
    name: "ubus_register",
    description:
      "Register this session on the bus. Identity is a label (D1). Needs only {handle, machine}; session is optional and defaults to h:<handle>, so registering again by name is idempotent. An explicit session wins. runtime defaults to other. Handles that look like herdr pane ids (w2:p1) are rejected: set HERDR_AGENT_NAME.",
    inputSchema: obj(
      {
        handle: str,
        machine: str,
        runtime: { type: "string", enum: ["claude-code", "opencode", "cursor-cli", "cursor-cloud", "openbot", "grok", "cowork", "other"] },
        session: str,
        owner: str,
        orchestrator: str,
        capabilities: { type: "object" },
        ttl_s: num,
      },
      ["handle", "machine"],
    ),
  },
  { name: "ubus_heartbeat", description: "Refresh presence for the registered session.", inputSchema: obj({}) },
  { name: "ubus_unregister", description: "Mark this registration gone. Mail is kept.", inputSchema: obj({}) },
  { name: "ubus_whoami", description: "Return the calling session's handle, machine, and unread count.", inputSchema: obj({}) },
  {
    name: "ubus_directory",
    description: "List agents with client_version. Presence is live, stale, turn-based, poll, gone, or live (discovered). Gone rows are hidden unless presence is \"gone\" or \"all\".",
    inputSchema: obj({ runtime: str, machine: str, owner: str, presence: str, group: str, q: str }),
  },
  { name: "ubus_resolve", description: "Resolve a handle, agent:// address, or group to addresses.", inputSchema: obj({ name: str }, ["name"]) },
  { name: "ubus_groups", description: "List group definitions.", inputSchema: obj({}) },
  {
    name: "ubus_send",
    description: "Send a message to handles, agent:// addresses, or groups. Bodies must be ids, counts, and paths.",
    inputSchema: obj(
      {
        to: { type: "array", items: str },
        subject: str,
        body: str,
        thread_id: str,
        reply_to: str,
        priority: { type: "string", enum: ["low", "normal", "high"] },
        wake: bool,
        artifacts: { type: "array" },
        idempotency_key: str,
        mirror_eta: bool,
      },
      ["to", "subject", "body"],
    ),
  },
  {
    name: "ubus_reply",
    description: "Reply in the original thread. Pass corr_id to complete a request.",
    inputSchema: obj({ reply_to: str, body: str, subject: str, corr_id: str }, ["reply_to", "body"]),
  },
  {
    name: "ubus_inbox",
    description: "Read your inbox. Marks read unless peek is true.",
    inputSchema: obj({ limit: num, unread_only: bool, peek: bool, thread_id: str }),
  },
  { name: "ubus_wait", description: "Long-poll up to 25s until unread mail exists. Grok bots must not call this.", inputSchema: obj({ timeout_s: num }) },
  { name: "ubus_thread", description: "Read a thread you participate in.", inputSchema: obj({ thread_id: str }, ["thread_id"]) },
  { name: "ubus_ack", description: "Mark messages acted on. Reading is not acting.", inputSchema: obj({ ids: { type: "array", items: str }, note: str }, ["ids"]) },
  {
    name: "ubus_request",
    description: "Ask for a reply. Returns corr_id. Grok recipients default to a 24h timeout.",
    inputSchema: obj({ to: str, subject: str, body: str, timeout_s: num, on_timeout: str }, ["to", "subject", "body"]),
  },
  { name: "ubus_await", description: "Wait for a request to be answered, expired, or still pending.", inputSchema: obj({ corr_id: str, timeout_s: num }, ["corr_id"]) },
  { name: "ubus_requests", description: "List open requests to you or from you.", inputSchema: obj({ direction: str, state: str }) },
  {
    name: "ubus_escalate",
    description: "Escalate to your orchestrator, then the owner, then fable. Fable's escalations become a Mini Ops handoff.",
    inputSchema: obj({ about: str, reason: str, severity: { type: "string", enum: ["info", "blocked", "urgent"] } }, ["about", "reason"]),
  },
  {
    name: "ubus_broadcast",
    description: "Fan out to a group (max 25 members, 3 per hour). There is no all-group.",
    inputSchema: obj({ group: str, subject: str, body: str, wake: bool }, ["group", "subject", "body"]),
  },
  {
    name: "ubus_handoff",
    description: "File a Mini Ops handoff. from_agent is forced to your handle.",
    inputSchema: obj({ project: str, title: str, body: str, tags: { type: "array", items: str } }, ["project", "title", "body"]),
  },
  {
    name: "ubus_grant",
    description: "Owner grant letting another agent steer this one. Time-boxed to at most 8 hours.",
    inputSchema: obj({ grantee: str, target: str, verbs: { type: "array", items: str }, expires_in: num }, ["grantee", "target", "verbs"]),
  },
  {
    name: "ubus_approval_request",
    description: "Request a single-use approval for interrupt, spawn, restart, kill, or clear. Bound to the exact args hash.",
    inputSchema: obj({ action: str, args: { type: "object" } }, ["action", "args"]),
  },
  {
    name: "ubus_approve",
    description: "Approve a pending request. Fable may approve engineering-only actions. The approval is single-use.",
    inputSchema: obj({ approval_id: str }, ["approval_id"]),
  },
  {
    name: "ubus_agent_send",
    description: "Direct input into a session. Requires a grant unless you own it. Grok input to a herdr pane is routed to the owning lead and is never typed into the pane.",
    inputSchema: obj({ address: str, text: str }, ["address", "text"]),
  },
  { name: "ubus_ask", description: "Ask an agent a question (open to all). Grok asks to a herdr pane go to its lead.", inputSchema: obj({ address: str, question: str, timeout_s: num }, ["address", "question"]) },
  { name: "ubus_agent_tag", description: "Set a task tag. Requires an owner grant.", inputSchema: obj({ address: str, task: str }, ["address"]) },
  { name: "ubus_agent_compact", description: "Compact a session. Requires an owner grant. Stubbed in the MVP.", inputSchema: obj({ address: str }, ["address"]) },
  { name: "ubus_agent_set_model", description: "Set a session model. Requires an owner grant. Stubbed in the MVP.", inputSchema: obj({ address: str, model: str }, ["address"]) },
  { name: "ubus_agent_interrupt", description: "Interrupt a session. Single-use approval required. Stubbed in the MVP.", inputSchema: obj({ address: str, approval_id: str }, ["address"]) },
  { name: "ubus_agent_spawn", description: "Spawn a session. Single-use approval required. Stubbed in the MVP.", inputSchema: obj({ address: str, approval_id: str }, ["address"]) },
  { name: "ubus_agent_restart", description: "Restart a session. Single-use approval required. Stubbed in the MVP.", inputSchema: obj({ address: str, approval_id: str }, ["address"]) },
  { name: "ubus_agent_kill", description: "Kill a session. Single-use approval required. Stubbed in the MVP. Kiosks are denied.", inputSchema: obj({ address: str, approval_id: str }, ["address"]) },
  { name: "ubus_agent_clear", description: "Clear a session. Single-use approval required. Stubbed in the MVP.", inputSchema: obj({ address: str, approval_id: str, ledger_ref: str }, ["address"]) },
  { name: "ubus_agent_sessions", description: "List sessions (read). Includes herdr discoveries.", inputSchema: obj({ machine: str, runtime: str }) },
  { name: "ubus_agent_status", description: "Status of one agent (read).", inputSchema: obj({ address: str }, ["address"]) },
  { name: "ubus_agent_read", description: "Read redacted session output (open, including Grok). MVP returns metadata only, never transcript text.", inputSchema: obj({ address: str, tail_turns: num, path: str }, ["address"]) },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
