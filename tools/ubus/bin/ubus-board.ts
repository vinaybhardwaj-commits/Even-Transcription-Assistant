#!/usr/bin/env node
/**
 * ubus v3 read-only board, a separate process that reads the hub's JSON views over HTTP.
 * Env: UBUS_HUB_URL (default http://127.0.0.1:7377), UBUS_BOARD_PORT (default 7378),
 * UBUS_BOARD_NODE (node key used to sign reads, default mini), UBUS_HUB_CONFIG for keyDir.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { listenBoard, HttpBoardSource } from "../src/v3/board/server.js";
import { loadHubConfig, readNodeKey, signRequest } from "../src/v3/hub/index.js";

async function main(): Promise<void> {
  if (process.env.UBUS_V3 !== "1") throw new Error("refused: UBUS_V3=1 is required");
  const cfg = loadHubConfig(process.env.UBUS_HUB_CONFIG || join(homedir(), ".ubus", "hub.json"));
  const node = process.env.UBUS_BOARD_NODE || "mini";
  const key = readNodeKey(cfg.keyDir, node);
  if (!key) throw new Error(`refused: no usable key for node ${node}`);
  const source = new HttpBoardSource(process.env.UBUS_HUB_URL || "http://127.0.0.1:7377", {
    headers: (method, path, body) => {
      const ts = new Date().toISOString();
      const nonce = randomBytes(16).toString("hex");
      return { authorization: `Node ${node}:${signRequest(key, method, path, ts, nonce, body)}`, "x-ubus-ts": ts, "x-ubus-nonce": nonce };
    },
  });
  const server = await listenBoard({ source, host: "127.0.0.1", port: Number(process.env.UBUS_BOARD_PORT || 7378) });
  const a = server.address();
  console.log(`ubus-board listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : "?"}`);
}

main().catch((e: unknown) => {
  console.error(`ubus-board: ${e instanceof Error ? e.message : "failed"}`);
  process.exit(1);
});
