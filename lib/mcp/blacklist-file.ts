/**
 * lib/mcp/blacklist-file.ts — exact-address blacklist loaded from a PRIVATE file outside the repo (R4). No name and no address is written in git: the file is JSON, an array of exact lowercase
 * addresses (or {"emails":[...]}), mode 0600, owned by the running user, and its path comes from SCRIBE_MCP_BLACKLIST_FILE (never argv). Nothing is matched by pattern or by name.
 * Each address becomes a BLACKLISTED mcp_identity (an upsert that overrides active/revoked), its keys are stamped revoked and its sessions killed (setIdentityStatus).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "@/lib/db";
import { normaliseEmail, setIdentityStatus } from "./identity";
import { MCP_TOKENS_DENY_ENV, parseDenyList } from "./auth";
import { revokePerson } from "./oauth/store";

export const BLACKLIST_FILE_ENV = "SCRIBE_MCP_BLACKLIST_FILE";

/** The addresses in the file, validated. Throws a closed code (never the content, the path or an address). */
export function readBlacklistFile(path: string | undefined = process.env[BLACKLIST_FILE_ENV]): string[] {
  return loadBlacklistFile(path).emails;
}

/** As readBlacklistFile, plus the sha256 of the exact bytes read (the marker row stores it; no address). */
export function loadBlacklistFile(path: string | undefined = process.env[BLACKLIST_FILE_ENV]): { emails: string[]; sha256: string } {
  if (!path) throw new Error("blacklist_file_env_unset");
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
  if (!list || list.length === 0 || list.length > 50) throw new Error("blacklist_file_bad_list");
  const out: string[] = [];
  for (const e of list) {
    const n = typeof e === "string" ? normaliseEmail(e) : null;
    if (!n || n !== e || !/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(n)) throw new Error("blacklist_file_bad_address"); // exact and already lowercase: no trimming, no guessing
    out.push(n);
  }
  return { emails: [...new Set(out)], sha256: createHash("sha256").update(raw).digest("hex") };
}

/**
 * Blacklists exactly the listed addresses: mcp_identity blacklisted (keys revoked, sessions killed) AND mcp_person revoked with its tokens and families (R5: works with SCRIBE_MCP_IDENTITY off),
 * then writes the marker row (file sha256, count, time; no address) that the identity-on guard looks for. Returns the count.
 */
export async function applyBlacklistFile(by = "blacklist-file", path?: string): Promise<number> {
  const { emails, sha256 } = loadBlacklistFile(path);
  for (const e of emails) {
    await setIdentityStatus(e, "blacklisted", by);
    await revokePerson(e, by);
  }
  await sql`INSERT INTO mcp_blacklist_applied (file_sha256, address_count) VALUES (${sha256}, ${emails.length})`;
  return emails.length;
}

/** True once any marker row exists. A database error propagates (the guard turns it into a refusal). */
export async function blacklistApplied(): Promise<boolean> {
  return ((await sql`SELECT 1 AS x FROM mcp_blacklist_applied LIMIT 1`) as unknown[]).length > 0;
}

const REVOKED_FROM = "2026-10-15T18:30:00Z"; // 16 Oct 2026 00:00 IST
const REVOKED_TO = "2026-10-16T18:30:00Z";
/**
 * The addresses revoked on 16 Oct 2026 (IST): mcp_person revoked that day, plus addresses whose mcp_key rows were revoked that day and who hold no live key now (a plain rotation leaves a live key, so it is
 * not a revocation). Raw rows as stored; scripts/blacklist-from-revocations.ts validates and writes them to the private file. Never logged.
 */
export async function revocationAddresses16Oct(): Promise<string[]> {
  const rows = (await sql`
    SELECT email FROM mcp_person WHERE status = 'revoked' AND revoked_at >= ${REVOKED_FROM}::timestamptz AND revoked_at < ${REVOKED_TO}::timestamptz
    UNION
    SELECT k.email FROM mcp_key k
     WHERE k.revoked_at >= ${REVOKED_FROM}::timestamptz AND k.revoked_at < ${REVOKED_TO}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM mcp_key l WHERE l.email = k.email AND l.revoked_at IS NULL)
  `) as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

/**
 * R6 N1 second source: the sha256 denylist the 16 Oct revocation used (env SCRIBE_MCP_TOKENS_DENY, name from MCP_TOKENS_DENY_ENV; the value is never printed). Each hash is joined to mcp_key.key_hash
 * (plain sha256 of the key) to find the address that held the key. Hashes with no mcp_key row yield nothing (counted by the caller as the gap). Raw rows; never logged.
 */
export async function denylistAddresses(raw: string | undefined = process.env[MCP_TOKENS_DENY_ENV]): Promise<string[]> {
  const hashes = [...parseDenyList(raw)];
  if (hashes.length === 0) return [];
  const rows = (await sql`SELECT DISTINCT email FROM mcp_key WHERE key_hash = ANY(${hashes}::text[])`) as Array<{ email: string }>;
  return rows.map((r) => r.email);
}
