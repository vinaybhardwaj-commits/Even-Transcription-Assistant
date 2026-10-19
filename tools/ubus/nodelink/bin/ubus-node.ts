#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, readNodeKey } from "../src/config.js";
import { callTool } from "../src/mcp-client.js";
import { NodeLink } from "../src/nodelink.js";
import { realSources } from "../src/sources.js";
import { Spool } from "../src/spool.js";
import { HttpsTransport } from "../src/transport.js";
import type { Logger } from "../src/types.js";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};
const cfg = loadConfig(process.env.UBUS_NODELINK_CONFIG);
const clock = { now: () => Date.now() };

function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "(no agents)";
  const cols = ["id", "kind", "state", "reason", "runtime", "lane", "pane", "pid"];
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "-").length)));
  const line = (r: Record<string, unknown>) => cols.map((c, i) => String(r[c] ?? "-").padEnd(w[i])).join("  ");
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  if (cmd === "run") {
    const key = readNodeKey(cfg.keyFile);
    const log: Logger = {
      info: (m) => process.stderr.write(`${new Date().toISOString()} info ${m.split(key).join("[key]")}\n`),
      warn: (m) => process.stderr.write(`${new Date().toISOString()} warn ${m.split(key).join("[key]")}\n`),
      error: (m) => process.stderr.write(`${new Date().toISOString()} error ${m.split(key).join("[key]")}\n`),
    };
    const spool = new Spool(cfg.spoolDb);
    const link = new NodeLink(cfg, realSources(cfg), spool, new HttpsTransport(cfg.hubUrl, cfg.node, key, clock.now), clock, log);
    const stop = link.start();
    log.info(`nodelink up node=${cfg.node}`);
    const down = () => { stop(); spool.close(); process.exit(0); };
    process.on("SIGINT", down);
    process.on("SIGTERM", down);
  } else if (cmd === "status") {
    if (rest.includes("--scan") || !existsSync(cfg.stateFile)) {
      // one-shot local scan; nothing is queued for the hub
      const realSrc = realSources(cfg);
      const spool = new Spool(":memory:");
      const link = new NodeLink(cfg, realSrc, spool, new HttpsTransport(cfg.hubUrl, cfg.node, "-", clock.now), clock, { info() {}, warn() {} });
      link.scanOnce();
      if (realSrc.herdrMissing?.()) process.stdout.write("herdr_missing: herdr executable not found, no panes reported\n");
      process.stdout.write(table(link.table() as never) + "\n");
    } else {
      const s = JSON.parse(readFileSync(cfg.stateFile, "utf8")) as { node: string; ts: string; herdr_missing?: boolean; agents: Array<Record<string, unknown>> };
      process.stdout.write(`node ${s.node}  as of ${s.ts}${s.herdr_missing ? "\nherdr_missing: herdr executable not found, no panes reported" : ""}\n${table(s.agents)}\n`);
    }
  } else if (cmd === "spool") {
    if (!existsSync(cfg.spoolDb)) { process.stdout.write("no spool\n"); return; }
    const sp = new Spool(cfg.spoolDb, true);
    const s = sp.stats();
    process.stdout.write(`depth=${s.depth} last_seq=${s.lastSeq} acked_seq=${s.ackedSeq} oldest=${s.oldestTs ?? "-"}\n`);
  } else if (cmd === "send") {
    const [to, ...body] = rest.filter((a) => a !== "--as" && a !== flag("--as"));
    process.stdout.write((await callTool(`${cfg.hubUrl}/mcp`, "ubus_send", { to, body: body.join(" ") }, flag("--as") ?? process.env.UBUS_HANDLE ?? `cli@${cfg.node}`)) + "\n");
  } else if (cmd === "inbox") {
    process.stdout.write((await callTool(`${cfg.hubUrl}/mcp`, "ubus_inbox", {}, flag("--as") ?? process.env.UBUS_HANDLE ?? `cli@${cfg.node}`)) + "\n");
  } else {
    process.stdout.write("usage: ubus-node run | status [--scan] | spool | send <to> <text> [--as h] | inbox [--as h]\n");
    process.exit(cmd === "help" ? 0 : 2);
  }
}
main().catch((e: Error) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
