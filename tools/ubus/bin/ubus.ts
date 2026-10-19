#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHttpServer } from "../src/http.js";
import { createUbus, buildWhois } from "../src/create.js";
import { loadConfig } from "../src/config.js";
import { verifyChain } from "../src/archive.js";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";

const args = process.argv.slice(2);
const command = args[0] || "serve";

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const configPath = flag("--config");
const root = flag("--root") || process.cwd();
const config = loadConfig(configPath, root);
if (flag("--port")) config.port = Number(flag("--port"));
if (flag("--host")) config.host = flag("--host") || config.host;

if (command === "serve") {
  const ubus = createUbus(config);
  const whois = buildWhois(config);
  const server = createHttpServer(ubus, config, { whois });
  ubus.startTimers();
  server.listen(config.port, config.host, () => {
    process.stdout.write(`ubus ${VERSION} listening on http://${config.host}:${config.port}/mcp\n`);
  });
  const stop = () => {
    server.close();
    ubus.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else if (command === "flush") {
  const ubus = createUbus(config);
  ubus.archive.seal();
  const result = ubus.archive.flush({ force: true });
  process.stdout.write(JSON.stringify(result) + "\n");
  ubus.close();
  process.exit(result.ok ? 0 : 1);
} else if (command === "verify") {
  const file = args[1] && !args[1].startsWith("--") ? args[1] : flag("--file");
  if (!file) {
    process.stderr.write("usage: ubus verify <file.jsonl>\n");
    process.exit(2);
  }
  const text = readFileSync(resolve(file), "utf8");
  const result = verifyChain(text);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
} else {
  process.stderr.write(`ubus ${VERSION}\nusage: ubus serve|flush|verify [--config file]\n`);
  process.exit(command === "help" || command === "--help" ? 0 : 2);
}

void pathToFileURL;
