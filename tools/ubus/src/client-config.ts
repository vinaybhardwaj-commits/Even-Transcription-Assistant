import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./config.js";

export interface ClientSettings {
  /** MCP endpoint the shim and hook call. */
  url: string;
  cfTokenFile?: string;
}

/**
 * Client settings for ubus-mcp and ubus-hook.
 * UBUS_URL wins. Otherwise ~/.config/ubus/config.json (or UBUS_CLIENT_CONFIG).
 * On the Mini, `url` should be the loopback server. Other machines set `url`
 * to the tailnet URL. UBUS_DOOR=cloudflare selects `cf_url`.
 */
export function loadClientSettings(env: NodeJS.ProcessEnv = process.env): ClientSettings {
  const file = env.UBUS_CLIENT_CONFIG || join(homedir(), ".config", "ubus", "config.json");
  let url = "http://127.0.0.1:8790/mcp";
  let cfTokenFile = env.UBUS_CF_TOKEN_FILE;
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (env.UBUS_DOOR === "cloudflare" && typeof raw.cf_url === "string") url = raw.cf_url;
      else if (env.UBUS_DOOR === "tailnet" && typeof raw.tailnet_url === "string") url = raw.tailnet_url;
      else if (typeof raw.url === "string") url = raw.url;
      else if (typeof raw.tailnet_url === "string") url = raw.tailnet_url;
      if (!cfTokenFile && typeof raw.cf_token_file === "string") cfTokenFile = expandHome(raw.cf_token_file);
    } catch {
      /* keep the loopback default */
    }
  }
  if (env.UBUS_URL) url = env.UBUS_URL;
  return { url, cfTokenFile };
}

/**
 * Hook URL for an MCP endpoint.
 * /ubus/mcp -> /ubus/v1/hook, /mcp -> /v1/hook,
 * /mcp/<secret> -> /v1/hook/<secret>, /ubus/mcp/<secret> -> /ubus/v1/hook/<secret>.
 * The server accepts those hook paths. A secret there is the same path secret as /mcp/<secret>.
 */
export function hookEndpoint(mcpUrl: string): string {
  let u: URL;
  try {
    u = new URL(mcpUrl);
  } catch {
    return "http://127.0.0.1:8790/v1/hook";
  }
  const trimmed = u.pathname.replace(/\/+$/, "") || "/";
  const withSecret = trimmed.match(/^(.*)\/mcp\/([^/]+)$/);
  if (withSecret) u.pathname = `${withSecret[1]}/v1/hook/${withSecret[2]}`;
  else {
    const plain = trimmed.match(/^(.*)\/mcp$/);
    u.pathname = plain ? `${plain[1]}/v1/hook` : "/v1/hook";
  }
  u.search = "";
  u.hash = "";
  return u.toString();
}
