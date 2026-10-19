#!/usr/bin/env node
/**
 * ubus v3 hub service. Config: ~/.ubus/hub.json (or UBUS_HUB_CONFIG).
 * Requires UBUS_V3=1; refuses a wildcard listen address. Prints only host:port.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { HubServer, loadHubConfig } from "../src/v3/hub/index.js";

async function main(): Promise<void> {
  if (process.env.UBUS_V3 !== "1") throw new Error("refused: UBUS_V3=1 is required");
  const cfg = loadHubConfig(process.env.UBUS_HUB_CONFIG || join(homedir(), ".ubus", "hub.json"));
  const hub = new HubServer(cfg);
  const addr = await hub.listen();
  console.log(`ubus-hub listening on ${addr.host}:${addr.port}`);
  const stop = (): void => {
    hub.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e: unknown) => {
  console.error(`ubus-hub: ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
});
