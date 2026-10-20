/**
 * lib/mcp/blacklist-file.ts — exact-address blacklist loaded from a PRIVATE file outside the repo (R4). No name and no address is written in git: the file is JSON, an array of exact lowercase
 * addresses (or {"emails":[...]}), mode 0600, owned by the running user, and its path comes from SCRIBE_MCP_BLACKLIST_FILE (never argv). Nothing is matched by pattern or by name.
 * Each address becomes a BLACKLISTED mcp_identity (an upsert that overrides active/revoked), its keys are stamped revoked and its sessions killed (setIdentityStatus).
 * V ruling 19 Oct 2026: the blacklist is EMPTY. This is a manual capability only; an unset env or an empty list is "nothing to do", and nothing gates turning identity on.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { normaliseEmail, setIdentityStatus } from "./identity";
import { revokePerson } from "./oauth/store";

export const BLACKLIST_FILE_ENV = "SCRIBE_MCP_BLACKLIST_FILE";

/** The addresses in the file, validated. Throws a closed code (never the content, the path or an address). Unset path or an empty list: no addresses. */
export function readBlacklistFile(path: string | undefined = process.env[BLACKLIST_FILE_ENV]): string[] {
  return loadBlacklistFile(path).emails;
}

/** As readBlacklistFile, plus the sha256 of the exact bytes read. */
export function loadBlacklistFile(path: string | undefined = process.env[BLACKLIST_FILE_ENV]): { emails: string[]; sha256: string } {
  if (!path) return { emails: [], sha256: "" }; // unset env: nothing to do
  let st;
  try { st = statSync(path); } catch { throw new Error("blacklist_file_unreadable"); }
  if (!st.isFile()) throw new Error("blacklist_file_not_a_file");
  if ((st.mode & 0o077) !== 0) throw new Error("blacklist_file_mode_not_0600");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("blacklist_file_wrong_owner");
  let v: unknown;
  let raw: Buffer;
  try { raw = readFileSync(path); } catch { throw new Error("blacklist_file_unreadable"); }
  try { v = JSON.parse(raw.toString("utf8")); } catch { throw new Error("blacklist_file_not_json"); }
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { emails?: unknown }).emails) ? (v as { emails: unknown[] }).emails : null;
  if (!list || list.length > 50) throw new Error("blacklist_file_bad_list"); // an empty list is fine: nothing to do
  const out: string[] = [];
  for (const e of list) {
    const n = typeof e === "string" ? normaliseEmail(e) : null;
    if (!n || n !== e || !/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(n)) throw new Error("blacklist_file_bad_address"); // exact and already lowercase: no trimming, no guessing
    out.push(n);
  }
  return { emails: [...new Set(out)], sha256: createHash("sha256").update(raw).digest("hex") };
}

/**
 * Blacklists exactly the listed addresses: mcp_identity blacklisted (keys revoked, sessions killed) AND mcp_person revoked with its tokens and families (works with SCRIBE_MCP_IDENTITY off).
 * Returns the count; 0 when there is nothing to do.
 */
export async function applyBlacklistFile(by = "blacklist-file", path?: string): Promise<number> {
  const { emails } = loadBlacklistFile(path);
  for (const e of emails) {
    await setIdentityStatus(e, "blacklisted", by);
    await revokePerson(e, by);
  }
  return emails.length;
}
