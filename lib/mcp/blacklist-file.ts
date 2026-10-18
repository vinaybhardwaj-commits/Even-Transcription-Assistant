/**
 * lib/mcp/blacklist-file.ts — exact-address blacklist loaded from a PRIVATE file outside the repo (R4). No name and no address is written in git: the file is JSON, an array of exact lowercase
 * addresses (or {"emails":[...]}), mode 0600, owned by the running user, and its path comes from SCRIBE_MCP_BLACKLIST_FILE (never argv). Nothing is matched by pattern or by name.
 * Each address becomes a BLACKLISTED mcp_identity (an upsert that overrides active/revoked), its keys are stamped revoked and its sessions killed (setIdentityStatus).
 */
import { readFileSync, statSync } from "node:fs";
import { normaliseEmail, setIdentityStatus } from "./identity";

export const BLACKLIST_FILE_ENV = "SCRIBE_MCP_BLACKLIST_FILE";

/** The addresses in the file, validated. Throws a closed code (never the content, the path or an address). */
export function readBlacklistFile(path: string | undefined = process.env[BLACKLIST_FILE_ENV]): string[] {
  if (!path) throw new Error("blacklist_file_env_unset");
  let st;
  try { st = statSync(path); } catch { throw new Error("blacklist_file_unreadable"); }
  if (!st.isFile()) throw new Error("blacklist_file_not_a_file");
  if ((st.mode & 0o077) !== 0) throw new Error("blacklist_file_mode_not_0600");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("blacklist_file_wrong_owner");
  let v: unknown;
  try { v = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("blacklist_file_not_json"); }
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { emails?: unknown }).emails) ? (v as { emails: unknown[] }).emails : null;
  if (!list || list.length === 0 || list.length > 50) throw new Error("blacklist_file_bad_list");
  const out: string[] = [];
  for (const e of list) {
    const n = typeof e === "string" ? normaliseEmail(e) : null;
    if (!n || n !== e || !/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(n)) throw new Error("blacklist_file_bad_address"); // exact and already lowercase: no trimming, no guessing
    out.push(n);
  }
  return [...new Set(out)];
}

/** Blacklists exactly the listed addresses. Returns the count. */
export async function applyBlacklistFile(by = "blacklist-file", path?: string): Promise<number> {
  const emails = readBlacklistFile(path);
  for (const e of emails) await setIdentityStatus(e, "blacklisted", by);
  return emails.length;
}
