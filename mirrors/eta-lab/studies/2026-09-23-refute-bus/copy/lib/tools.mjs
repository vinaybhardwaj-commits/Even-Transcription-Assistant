// Tool definitions (MCP inputSchema) and handlers for the eta-bus MCP server.
//
// Every handler has the signature (args, ctx) => Promise<resultObject>,
// where ctx = { identity: string, db: DatabaseSync, session?: string }.
// Handlers throw Error on refusal/validation failure; server.mjs turns
// that into an MCP tool error. This split lets unit tests call handlers
// directly against a temp DB without going through JSON-RPC framing.

import fs from 'node:fs';
import {
  insertMessage,
  insertReceipt,
  getUnreadCount,
  getLatestUnread,
  listInbox,
  markRead,
  ackMessages,
  getThread,
  lastNudgeTs,
  recordNudge,
  unreadCountsByRecipient,
} from './db.mjs';
import { looksLikeSecret } from './secrets.mjs';
import { logCall } from './audit.mjs';
import { herdrAgentList, runHerdrCtl, effectiveSession } from './herdrctl.mjs';
import { MAX_SUBJECT_LEN, MAX_BODY_BYTES, NUDGE_RATE_LIMIT_MS, HERDR_STATUS_JSON } from './constants.mjs';

// ---------- shared helpers ----------

function requireIdentified(ctx, toolName) {
  if (!ctx.identity || ctx.identity === 'unknown') {
    logCall('unknown', toolName, '-', 'refused-unidentified');
    throw new Error(
      'caller identity could not be resolved (set ETA_BUS_AS, or run inside a herdr-managed pane so HERDR_PANE_ID resolves to a live agent name)'
    );
  }
  return ctx.identity;
}

function requireFable(ctx, toolName, target) {
  const who = requireIdentified(ctx, toolName);
  if (who !== 'fable') {
    logCall(who, toolName, target, 'refused-not-fable');
    throw new Error(`${toolName} is orchestrator-only (caller must be 'fable', got '${who}')`);
  }
  return who;
}

function byteLen(s) {
  return Buffer.byteLength(s ?? '', 'utf8');
}

async function liveAgentNames(session) {
  const agents = await herdrAgentList(session);
  return agents.map((a) => a.name).filter(Boolean);
}

async function liveAgentByName(session, name) {
  const agents = await herdrAgentList(session);
  return agents.find((a) => a.name === name) || null;
}

// ---------- bus_post ----------

export async function busPost(args, ctx) {
  const sender = requireIdentified(ctx, 'bus_post');
  const { db } = ctx;

  if (!Array.isArray(args?.to) || args.to.length === 0) {
    throw new Error('bus_post: "to" must be a non-empty array of agent names (or ["all"])');
  }
  const subject = String(args.subject ?? '');
  const body = String(args.body ?? '');
  if (subject.length > MAX_SUBJECT_LEN) {
    throw new Error(`bus_post: subject exceeds ${MAX_SUBJECT_LEN} chars`);
  }
  if (byteLen(body) > MAX_BODY_BYTES) {
    throw new Error(`bus_post: body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  if (looksLikeSecret(body)) {
    logCall(sender, 'bus_post', (args.to || []).join(','), 'refused-secret-like-body');
    throw new Error(
      'bus_post: body looks like it contains a secret (API key, bearer token, PEM block, or long hex/base64 run) — refused'
    );
  }
  const priority = args.priority === 'urgent' ? 'urgent' : 'normal';
  const wake = args.wake !== false;
  const threadId = args.thread_id ?? null;
  const replyTo = args.reply_to ?? null;

  const session = effectiveSession(ctx.session);
  const wantsAll = args.to.some((n) => String(n).toLowerCase() === 'all');
  const named = args.to.filter((n) => String(n).toLowerCase() !== 'all');

  let recipients = [...named];
  if (wantsAll) {
    const live = await liveAgentNames(session);
    for (const n of live) {
      if (n !== sender && !recipients.includes(n)) recipients.push(n);
    }
  }
  recipients = [...new Set(recipients)];
  if (recipients.length === 0) {
    throw new Error('bus_post: no recipients resolved (nothing left after removing sender/"all" expansion)');
  }

  const ts = Date.now();
  const messageId = insertMessage(db, {
    ts,
    sender,
    recipients,
    subject,
    body,
    threadId,
    replyTo,
    priority,
  });
  for (const r of recipients) insertReceipt(db, messageId, r);

  const perRecipient = {};
  for (const recipient of recipients) {
    const agent = await liveAgentByName(session, recipient);

    if (!agent) {
      perRecipient[recipient] = 'unknown_agent';
      continue;
    }

    if (!wake) {
      perRecipient[recipient] = 'stored';
      continue;
    }

    const state = agent.agent_status;
    if (state === 'blocked') {
      perRecipient[recipient] = 'not_nudged_blocked';
      continue;
    }
    if (state !== 'idle' && state !== 'done') {
      // working / unknown: agent will read at its next turn end.
      perRecipient[recipient] = 'not_nudged_working';
      continue;
    }

    const last = lastNudgeTs(db, recipient);
    if (ts - last < NUDGE_RATE_LIMIT_MS) {
      perRecipient[recipient] = 'stored'; // rate-limited, still stored
      continue;
    }

    const unread = getUnreadCount(db, recipient);
    const latest = getLatestUnread(db, recipient);
    const latestSender = latest ? latest.sender : sender;
    const latestSubject = latest ? latest.subject : subject;
    const msg = `[bus] You have ${unread} unread message(s) (latest from ${latestSender}: ${latestSubject}). Call bus_inbox to read them.`;

    const result = await runHerdrCtl(['send', recipient, msg], { session });
    if (result.code === 0) {
      recordNudge(db, recipient, ts);
      perRecipient[recipient] = 'nudged';
    } else {
      perRecipient[recipient] = 'stored';
    }
  }

  logCall(sender, 'bus_post', recipients.join(','), `id=${messageId} ${JSON.stringify(perRecipient)}`);
  return { id: messageId, per_recipient: perRecipient };
}

// ---------- bus_inbox ----------

export async function busInbox(args, ctx) {
  const who = requireIdentified(ctx, 'bus_inbox');
  const { db } = ctx;
  const unreadOnly = args?.unread_only !== false;
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, args.limit)) : 20;

  const rows = listInbox(db, who, { unreadOnly, limit });
  const now = Date.now();
  markRead(
    db,
    who,
    rows.map((r) => r.id),
    now
  );
  logCall(who, 'bus_inbox', who, `returned=${rows.length}`);
  return {
    messages: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      sender: r.sender,
      subject: r.subject,
      body: r.body,
      thread_id: r.thread_id,
    })),
  };
}

// ---------- bus_ack ----------

export async function busAck(args, ctx) {
  const who = requireIdentified(ctx, 'bus_ack');
  const { db } = ctx;
  if (!Array.isArray(args?.ids) || args.ids.length === 0) {
    throw new Error('bus_ack: "ids" must be a non-empty array of message ids');
  }
  const now = Date.now();
  const { acked, notFound } = ackMessages(db, who, args.ids, now);
  logCall(who, 'bus_ack', who, `acked=${acked.length} not_found=${notFound.length}`);
  return { acked, not_found: notFound };
}

// ---------- bus_thread ----------

export async function busThread(args, ctx) {
  const who = requireIdentified(ctx, 'bus_thread');
  const { db } = ctx;
  if (!args?.thread_id) throw new Error('bus_thread: "thread_id" is required');
  const rows = getThread(db, args.thread_id);
  logCall(who, 'bus_thread', args.thread_id, `count=${rows.length}`);
  return {
    messages: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      sender: r.sender,
      recipients: JSON.parse(r.recipients_json),
      subject: r.subject,
      body: r.body,
      thread_id: r.thread_id,
      reply_to: r.reply_to,
      priority: r.priority,
    })),
  };
}

// ---------- bus_roster ----------

export async function busRoster(args, ctx) {
  const who = requireIdentified(ctx, 'bus_roster');
  const { db } = ctx;
  const session = effectiveSession(ctx.session);

  const result = await runHerdrCtl(['status'], { session });
  let agents = [];
  try {
    const raw = fs.readFileSync(HERDR_STATUS_JSON, 'utf8');
    agents = JSON.parse(raw);
  } catch {
    agents = [];
  }
  const unreadMap = unreadCountsByRecipient(db);

  logCall(who, 'bus_roster', session ?? 'default', `agents=${agents.length} status_exit=${result.code}`);
  return {
    agents: agents.map((a) => ({
      name: a.name,
      pane: a.pane,
      state: a.state,
      busy: !!a.busy,
      ctx: a.ctx ?? '',
      update: !!a.update,
      model: a.model ?? '?',
      task: a.task ?? '-',
      unread: unreadMap[a.name] || 0,
    })),
  };
}

// ---------- herdr read-only tools ----------

export async function herdrStatusTool(args, ctx) {
  const who = requireIdentified(ctx, 'herdr_status');
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['status'], { session });
  logCall(who, 'herdr_status', session ?? 'default', `exit=${result.code}`);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

const TRANSCRIPT_CAP_BYTES = 40 * 1024;

export async function herdrTranscriptTool(args, ctx) {
  const who = requireIdentified(ctx, 'herdr_transcript');
  if (!args?.name) throw new Error('herdr_transcript: "name" is required');
  const tail = Number.isFinite(args?.tail) ? args.tail : 40;
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['transcript', args.name, '--tail', String(tail)], { session });

  if (result.code !== 0) {
    logCall(who, 'herdr_transcript', args.name, `exit=${result.code}`);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, text: '' };
  }

  const filePath = (result.stdout.split('\n')[0] || '').trim();
  let text = '';
  try {
    const buf = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(buf, 'utf8') > TRANSCRIPT_CAP_BYTES) {
      text = Buffer.from(buf, 'utf8').subarray(0, TRANSCRIPT_CAP_BYTES).toString('utf8');
      text += `\n\n[... truncated at ${TRANSCRIPT_CAP_BYTES} bytes ...]`;
    } else {
      text = buf;
    }
  } catch (e) {
    text = `[could not read transcript file ${filePath}: ${e.message}]`;
  }
  logCall(who, 'herdr_transcript', args.name, `exit=0 file=${filePath}`);
  return { code: 0, stdout: result.stdout, stderr: result.stderr, text };
}

// ---------- herdr orchestrator-only control tools ----------

export async function herdrSendTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_send', args?.name);
  if (!args?.name || typeof args?.message !== 'string') {
    throw new Error('herdr_send: "name" and "message" are required');
  }
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['send', args.name, args.message], { session });
  logCall(who, 'herdr_send', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrTagTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_tag', args?.name);
  if (!args?.name || typeof args?.task !== 'string') {
    throw new Error('herdr_tag: "name" and "task" are required');
  }
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['tag', args.name, args.task], { session });
  logCall(who, 'herdr_tag', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrCompactTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_compact', args?.name);
  if (!args?.name) throw new Error('herdr_compact: "name" is required');
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['compact', args.name], { session });
  logCall(who, 'herdr_compact', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrClearTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_clear', args?.name);
  if (!args?.name) throw new Error('herdr_clear: "name" is required');
  if (args?.ledger_ok !== true) {
    throw new Error('herdr_clear: "ledger_ok" must be true (confirm a ledger entry was made first)');
  }
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['clear', args.name, '--ledger-ok'], { session });
  logCall(who, 'herdr_clear', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrModelTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_model', args?.name);
  if (!args?.name || !['sonnet', 'opus', 'haiku'].includes(args?.model)) {
    throw new Error('herdr_model: "name" is required and "model" must be sonnet|opus|haiku');
  }
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['model', args.name, args.model], { session });
  logCall(who, 'herdr_model', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrRestartTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_restart', args?.name);
  if (!args?.name) throw new Error('herdr_restart: "name" is required');
  const session = effectiveSession(args?.session ?? ctx.session);
  const result = await runHerdrCtl(['restart', args.name], { session });
  logCall(who, 'herdr_restart', args.name, `exit=${result.code}`);
  return result;
}

export async function herdrSpawnTool(args, ctx) {
  const who = requireFable(ctx, 'herdr_spawn', args?.name);
  if (!args?.name || !args?.cwd || !['sonnet', 'opus', 'haiku'].includes(args?.model)) {
    throw new Error('herdr_spawn: "name", "cwd" are required and "model" must be sonnet|opus|haiku');
  }
  const session = effectiveSession(args?.session ?? ctx.session);
  const subArgs = ['spawn', args.name, args.cwd, args.model];
  if (args.skip_permissions) subArgs.push('--skip-permissions');
  const result = await runHerdrCtl(subArgs, { session });
  logCall(who, 'herdr_spawn', args.name, `exit=${result.code}`);
  return result;
}

// ---------- tool registry (MCP tools/list + dispatch) ----------

const STRING = { type: 'string' };
const BOOL = { type: 'boolean' };
const NUM = { type: 'number' };

export const TOOL_DEFS = [
  {
    name: 'bus_post',
    description:
      'Post a message on the shared bus to one or more agents (or ["all"] for every live agent except the sender). Optionally wakes idle/done recipients via herdr. Never send secrets or patient transcript text.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: STRING, description: 'Recipient agent names, or ["all"].' },
        subject: { ...STRING, description: 'Subject line, <=120 chars.' },
        body: { ...STRING, description: 'Message body, <=16KB. No secrets or patient text.' },
        thread_id: STRING,
        reply_to: NUM,
        priority: { type: 'string', enum: ['normal', 'urgent'], default: 'normal' },
        wake: { ...BOOL, default: true },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: busPost,
  },
  {
    name: 'bus_inbox',
    description: "Read the caller's bus inbox. Marks returned messages as read.",
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { ...BOOL, default: true },
        limit: { ...NUM, default: 20 },
      },
    },
    handler: busInbox,
  },
  {
    name: 'bus_ack',
    description: 'Acknowledge one or more bus message ids as handled.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: NUM } },
      required: ['ids'],
    },
    handler: busAck,
  },
  {
    name: 'bus_thread',
    description: 'Fetch every message in a thread, oldest first.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: STRING },
      required: ['thread_id'],
    },
    handler: busThread,
  },
  {
    name: 'bus_roster',
    description: 'List live herdr agents (state, busy, model, task) plus each one\'s unread bus count.',
    inputSchema: { type: 'object', properties: {} },
    handler: busRoster,
  },
  {
    name: 'herdr_status',
    description: 'Read-only herdr-ctl.sh status: one row per live agent.',
    inputSchema: {
      type: 'object',
      properties: { session: { ...STRING, description: 'Optional named herdr session (defaults to the live session).' } },
    },
    handler: herdrStatusTool,
  },
  {
    name: 'herdr_transcript',
    description: "Read-only: an agent's recent transcript as extracted markdown text (capped at 40KB).",
    inputSchema: {
      type: 'object',
      properties: {
        name: STRING,
        tail: { ...NUM, default: 40 },
        session: STRING,
      },
      required: ['name'],
    },
    handler: herdrTranscriptTool,
  },
  {
    name: 'herdr_send',
    description: 'ORCHESTRATOR ONLY. Send a raw prompt to an agent via herdr-ctl.sh send.',
    inputSchema: {
      type: 'object',
      properties: { name: STRING, message: STRING, session: STRING },
      required: ['name', 'message'],
    },
    handler: herdrSendTool,
  },
  {
    name: 'herdr_tag',
    description: "ORCHESTRATOR ONLY. Set an agent's display task tag via herdr-ctl.sh tag.",
    inputSchema: {
      type: 'object',
      properties: { name: STRING, task: STRING, session: STRING },
      required: ['name', 'task'],
    },
    handler: herdrTagTool,
  },
  {
    name: 'herdr_compact',
    description: 'ORCHESTRATOR ONLY. /compact an idle/done agent via herdr-ctl.sh compact.',
    inputSchema: {
      type: 'object',
      properties: { name: STRING, session: STRING },
      required: ['name'],
    },
    handler: herdrCompactTool,
  },
  {
    name: 'herdr_clear',
    description: 'ORCHESTRATOR ONLY. /clear an idle/done agent via herdr-ctl.sh clear. Requires ledger_ok:true.',
    inputSchema: {
      type: 'object',
      properties: { name: STRING, ledger_ok: BOOL, session: STRING },
      required: ['name', 'ledger_ok'],
    },
    handler: herdrClearTool,
  },
  {
    name: 'herdr_model',
    description: 'ORCHESTRATOR ONLY. Switch an idle/done agent\'s model via herdr-ctl.sh model.',
    inputSchema: {
      type: 'object',
      properties: { name: STRING, model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'] }, session: STRING },
      required: ['name', 'model'],
    },
    handler: herdrModelTool,
  },
  {
    name: 'herdr_restart',
    description: 'ORCHESTRATOR ONLY. Restart an idle/done agent (picks up a Claude Code update) via herdr-ctl.sh restart.',
    inputSchema: {
      type: 'object',
      properties: { name: STRING, session: STRING },
      required: ['name'],
    },
    handler: herdrRestartTool,
  },
  {
    name: 'herdr_spawn',
    description: 'ORCHESTRATOR ONLY. Spawn a new agent in a fresh workspace via herdr-ctl.sh spawn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: STRING,
        cwd: STRING,
        model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'] },
        skip_permissions: BOOL,
        session: STRING,
      },
      required: ['name', 'cwd', 'model'],
    },
    handler: herdrSpawnTool,
  },
];

export function listToolDefs() {
  return TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(name, args, ctx) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`unknown tool: ${name}`);
  return def.handler(args ?? {}, ctx);
}
