import { readFileSync } from "node:fs";

/** Read from package.json at load time (dist/src/version.js -> ../../package.json). No typed constant. */
function readVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && raw.version) return raw.version;
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

export const VERSION = readVersion();
