import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { shortMachine } from "./address.js";
import { BRIDGE_IDENTITY, LIAISON_IDENTITY, NUDGE_TEXT } from "./constants.js";
import { all, num, openDb, run, str, type Sql } from "./sqlite.js";

export interface EtaPostInput {
  as: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  replyTo?: string;
  wake: false;
}

export interface EtaPost {
  id: string;
  ts: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  threadId: string;
  replyTo: string;
  wake: number;
  identity: string;
}

export interface EtaAdapter {
  post(input: EtaPostInput): EtaPost;
  /** Read-only tail. Must not mark anything read and must not write the ETA database. */
  tail(sinceId: string): EtaPost[];
}

export interface HerdrAgent {
  name: string;
  machine: string;
  runtime: "claude-code" | "opencode";
  state: "idle" | "done" | "busy" | "running";
  busy: boolean;
  owner: string;
  herdrSession: string;
}

export interface HerdrAdapter {
  listAgents(): HerdrAgent[];
  /** Fixed text only. The message body is not a parameter. */
  nudge(name: string, machine: string): void;
}

export interface OpenBotAdapter {
  ensureThread(handle: string): string;
  post(handle: string, content: string): void;
}

export interface HandoffInput {
  project: string;
  title: string;
  body: string;
  fromAgent: string;
  tags: string[];
}

export interface HandoffAdapter {
  post(input: HandoffInput): { id: string };
}

export interface Whois {
  lookup(ip: string): { machine: string } | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error("invalid sql identifier");
  return name;
}

export class SqliteEtaAdapter implements EtaAdapter {
  private writeDb: Sql | null;
  readonly path: string;
  readonly table: string;

  constructor(path: string, opts?: { readOnly?: boolean; table?: string }) {
    this.path = path;
    this.table = assertIdent(opts?.table || "posts");
    if (opts?.readOnly) {
      this.writeDb = null;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      this.writeDb = openDb(path);
      this.writeDb.exec(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          thread_id TEXT,
          reply_to TEXT,
          wake INTEGER NOT NULL DEFAULT 0,
          identity TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS receipts (
          identity TEXT NOT NULL,
          post_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (identity, post_id)
        );
      `);
    }
  }

  post(input: EtaPostInput): EtaPost {
    if (!this.writeDb) throw new Error("eta adapter is read-only");
    if (input.wake !== false) throw new Error("bridge posts are wake:false");
    const ts = new Date().toISOString();
    let subject = input.subject;
    if (input.as === LIAISON_IDENTITY && !subject.startsWith("[EXT]")) {
      subject = `[EXT] ${subject}`;
    }
    const threadId = input.threadId || "";
    const res = run(
      this.writeDb,
      `INSERT INTO ${this.table} (ts, sender, recipient, subject, body, thread_id, reply_to, wake, identity)
       VALUES (?,?,?,?,?,?,?,0,?)`,
      ts,
      input.as,
      input.to,
      subject,
      input.body,
      threadId,
      input.replyTo || "",
      input.as,
    );
    const id = String(res.lastId);
    const storedThread = threadId || `eta:${id}`;
    if (!threadId) {
      run(this.writeDb, `UPDATE ${this.table} SET thread_id = ? WHERE id = ?`, storedThread, res.lastId);
    }
    return {
      id,
      ts,
      sender: input.as,
      recipient: input.to,
      subject,
      body: input.body,
      threadId: storedThread,
      replyTo: input.replyTo || "",
      wake: 0,
      identity: input.as,
    };
  }

  tail(sinceId: string): EtaPost[] {
    const since = Number(sinceId);
    const db = openDb(this.path, true);
    try {
      const rows = all(db, `SELECT * FROM ${this.table} WHERE id > ? ORDER BY id ASC`, Number.isFinite(since) ? since : 0);
      return rows.map(rowToPost);
    } finally {
      db.close();
    }
  }

  /** Test-only. The bus never calls this. */
  markRead(identity: string, postId: string, status = "read"): void {
    if (!this.writeDb) throw new Error("eta adapter is read-only");
    run(
      this.writeDb,
      "INSERT INTO receipts (identity, post_id, status) VALUES (?,?,?) ON CONFLICT(identity, post_id) DO UPDATE SET status = excluded.status",
      identity,
      Number(postId),
      status,
    );
  }

  listPosts(): EtaPost[] {
    if (!this.writeDb) return this.tail("0");
    return all(this.writeDb, `SELECT * FROM ${this.table} ORDER BY id`).map(rowToPost);
  }

  listReceipts(): Array<{ identity: string; postId: string; status: string }> {
    if (!this.writeDb) return [];
    return all(this.writeDb, "SELECT * FROM receipts ORDER BY post_id").map((row) => ({
      identity: str(row, "identity"),
      postId: String(num(row, "post_id")),
      status: str(row, "status"),
    }));
  }

  /** Insert a post as an ETA participant (not through the bridge). Used by tests and by nothing else. */
  inject(row: { sender: string; recipient: string; subject: string; body: string; threadId?: string; replyTo?: string }): EtaPost {
    if (!this.writeDb) throw new Error("eta adapter is read-only");
    const ts = new Date().toISOString();
    const res = run(
      this.writeDb,
      `INSERT INTO ${this.table} (ts, sender, recipient, subject, body, thread_id, reply_to, wake, identity)
       VALUES (?,?,?,?,?,?,?,0,?)`,
      ts,
      row.sender,
      row.recipient,
      row.subject,
      row.body,
      row.threadId || "",
      row.replyTo || "",
      row.sender,
    );
    const id = String(res.lastId);
    const threadId = row.threadId || `eta:${id}`;
    if (!row.threadId) run(this.writeDb, `UPDATE ${this.table} SET thread_id = ? WHERE id = ?`, threadId, res.lastId);
    return {
      id,
      ts,
      sender: row.sender,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      threadId,
      replyTo: row.replyTo || "",
      wake: 0,
      identity: row.sender,
    };
  }

  close(): void {
    this.writeDb?.close();
  }
}

/**
 * Live bus.db has no recipient column. Recipients are a JSON array in recipients_json.
 * Prefer ubus-bridge or the liaison identity when named, otherwise the first name.
 * A non-empty recipient column still wins (fake rows and older dumps).
 * This read is gating-lead's Mini fix so inbound ETA posts reach ubus.
 */
function rowRecipient(row: Record<string, unknown>): string {
  const direct = str(row, "recipient");
  if (direct) return direct;
  const raw = row["recipients_json"];
  if (typeof raw !== "string" || !raw) return "";
  let names: unknown;
  try {
    names = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!Array.isArray(names)) return "";
  const list = names.filter((n): n is string => typeof n === "string");
  return list.find((n) => n === BRIDGE_IDENTITY || n === LIAISON_IDENTITY) ?? list[0] ?? "";
}

function rowToPost(row: Record<string, unknown>): EtaPost {
  return {
    id: String(num(row, "id")),
    ts: str(row, "ts"),
    sender: str(row, "sender"),
    recipient: rowRecipient(row),
    subject: str(row, "subject"),
    body: str(row, "body"),
    threadId: str(row, "thread_id"),
    replyTo: str(row, "reply_to"),
    wake: num(row, "wake"),
    identity: str(row, "identity"),
  };
}

/**
 * Production shape: post by spawning the configured command (eta-bus run.sh wrapper),
 * tail by opening bus.db read-only. The command protocol is one JSON object on stdin
 * and one JSON object on stdout: {id, thread_id}. No secrets on argv.
 */
export class CommandEtaAdapter implements EtaAdapter {
  constructor(
    private postCommand: string[],
    private tailDbPath: string,
    private table = "posts",
  ) {
    assertIdent(this.table);
  }

  post(input: EtaPostInput): EtaPost {
    if (!this.postCommand.length) throw new Error("eta post_command is not configured");
    const env: NodeJS.ProcessEnv = { ...process.env, ETA_BUS_AS: input.as };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_SESSION;
    delete env.HERDR_AGENT_NAME;
    const res = spawnSync(this.postCommand[0]!, this.postCommand.slice(1), {
      input: JSON.stringify({ ...input, wake: false }),
      encoding: "utf8",
      timeout: 20_000,
      env,
    });
    if (res.status !== 0) {
      throw new Error(`eta post failed (${res.status ?? "signal"})`);
    }
    const parsed = JSON.parse(res.stdout) as { id: string | number; thread_id?: string };
    const id = String(parsed.id);
    return {
      id,
      ts: new Date().toISOString(),
      sender: input.as,
      recipient: input.to,
      subject: input.subject,
      body: input.body,
      threadId: parsed.thread_id || `eta:${id}`,
      replyTo: input.replyTo || "",
      wake: 0,
      identity: input.as,
    };
  }

  tail(sinceId: string): EtaPost[] {
    const db = openDb(this.tailDbPath, true);
    try {
      const since = Number(sinceId);
      const rows = all(
        db,
        `SELECT * FROM ${assertIdent(this.table)} WHERE id > ? ORDER BY id ASC`,
        Number.isFinite(since) ? since : 0,
      );
      return rows.map(rowToPost);
    } finally {
      db.close();
    }
  }
}

export class FakeHerdr implements HerdrAdapter {
  agents: HerdrAgent[] = [];
  nudges: Array<{ name: string; machine: string; text: string }> = [];

  listAgents(): HerdrAgent[] {
    return this.agents.map((a) => ({ ...a }));
  }

  nudge(name: string, machine: string): void {
    this.nudges.push({ name, machine, text: NUDGE_TEXT });
  }
}

export class CommandHerdr implements HerdrAdapter {
  constructor(private command: string[]) {}

  listAgents(): HerdrAgent[] {
    if (!this.command.length) return [];
    const res = spawnSync(this.command[0]!, [...this.command.slice(1), "status"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (res.status !== 0 || !res.stdout.trim()) return [];
    const parsed = JSON.parse(res.stdout) as HerdrAgent[];
    return Array.isArray(parsed) ? parsed : [];
  }

  nudge(name: string, machine: string): void {
    if (!this.command.length) return;
    spawnSync(this.command[0]!, [...this.command.slice(1), "nudge", machine, name, NUDGE_TEXT], {
      encoding: "utf8",
      timeout: 15_000,
    });
  }
}

export class FakeOpenBot implements OpenBotAdapter {
  threads = new Map<string, string>();
  posts: Array<{ handle: string; thread: string; bytes: number; sha256: string }> = [];

  ensureThread(handle: string): string {
    const id = this.threads.get(handle) ?? `ubus:${handle}`;
    this.threads.set(handle, id);
    return id;
  }

  post(handle: string, content: string): void {
    const thread = this.ensureThread(handle);
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.posts.push({ handle, thread, bytes: Buffer.byteLength(content), sha256 });
  }
}

export class HttpOpenBot implements OpenBotAdapter {
  constructor(private baseUrl: string) {}
  ensureThread(handle: string): string {
    return `ubus:${handle}`;
  }
  post(handle: string, content: string): void {
    const url = this.baseUrl.replace(/\/$/, "") + "/message";
    const res = spawnSync("curl", ["-sS", "-m", "10", "-X", "POST", url, "-H", "content-type: application/json", "--data-binary", "@-"], {
      input: JSON.stringify({ handle, content, thread: this.ensureThread(handle) }),
      encoding: "utf8",
      timeout: 15_000,
    });
    if (res.status !== 0) throw new Error("openbot post failed");
  }
}

export class FakeHandoff implements HandoffAdapter {
  records: Array<HandoffInput & { id: string }> = [];
  post(input: HandoffInput): { id: string } {
    const id = `hof-${this.records.length + 1}`;
    this.records.push({ ...input, id });
    return { id };
  }
}

export class HttpHandoff implements HandoffAdapter {
  constructor(private url: string) {}
  post(input: HandoffInput): { id: string } {
    const res = spawnSync(
      "curl",
      ["-sS", "-m", "10", "-X", "POST", this.url, "-H", "content-type: application/json", "--data-binary", "@-"],
      { input: JSON.stringify(input), encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0) throw new Error("handoff failed");
    try {
      const parsed = JSON.parse(res.stdout) as { id?: string };
      return { id: parsed.id || "handoff" };
    } catch {
      return { id: "handoff" };
    }
  }
}

export class MapWhois implements Whois {
  constructor(private map: Map<string, string>) {}
  lookup(ip: string): { machine: string } | null {
    const machine = this.map.get(ip);
    return machine ? { machine } : null;
  }
  set(ip: string, machine: string): void {
    this.map.set(ip, machine);
  }
}

export class CommandWhois implements Whois {
  constructor(private command: string[] = ["tailscale", "whois", "--json"]) {}
  lookup(ip: string): { machine: string } | null {
    const res = spawnSync(this.command[0]!, [...this.command.slice(1), ip], { encoding: "utf8", timeout: 3000 });
    if (res.status !== 0 || !res.stdout.trim()) return null;
    try {
      const parsed = JSON.parse(res.stdout) as { HostName?: string; DNSName?: string; Node?: { HostName?: string; DNSName?: string } };
      const host = parsed.Node?.HostName || parsed.HostName || parsed.Node?.DNSName || parsed.DNSName || "";
      if (!host) return null;
      return { machine: shortMachine(host) };
    } catch {
      return null;
    }
  }
}
