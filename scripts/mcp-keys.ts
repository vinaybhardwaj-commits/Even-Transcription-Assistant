/**
 * scripts/mcp-keys.ts — the admin CLI for per-email MCP keys (Fable spec 18 Oct 2026). V runs it; it reaches the app database through APP_DATABASE_URL (or DATABASE_URL) in the ENVIRONMENT,
 * never argv: a secret on a command line shows in ps and shell history. A key is printed once on stdout and stored nowhere (the table keeps its sha256).
 *
 *   npx tsx scripts/mcp-keys.ts list
 *   npx tsx scripts/mcp-keys.ts issue <email> <read|admin>
 *   npx tsx scripts/mcp-keys.ts rotate <key_id>
 *   npx tsx scripts/mcp-keys.ts revoke <key_id>
 *   npx tsx scripts/mcp-keys.ts revoke-identity <email>      every key of the address stops working
 *   npx tsx scripts/mcp-keys.ts blacklist <email>            as revoke-identity, and the address can never be issued a key again from here
 *   npx tsx scripts/mcp-keys.ts activate <email>             a REVOKED identity only; a blacklist is lifted by V editing mcp_identity
 *   npx tsx scripts/mcp-keys.ts blacklist-file               blacklists the EXACT addresses in the private file named by SCRIBE_MCP_BLACKLIST_FILE (JSON array, mode 0600, outside the repo)
 *   npx tsx scripts/mcp-keys.ts seed <file.json>             links EXISTING tokens (by sha256) to owners: {"keys":[{"sha256":"<hex>","email":"..","scope":"read|admin"}],"blacklist":["email",..]}
 *
 * Prints ids, addresses and counts. Mails V (SCRIBE_MCP_OAUTH_APPROVER, through Resend) on issue and revoke when RESEND_* are set in the environment.
 */
import { readFileSync } from "node:fs";
import { activateIdentity, issueKey, linkExistingKey, listIdentities, listKeys, revokeKey, rotateKey, setIdentityStatus, type KeyScope } from "../lib/mcp/identity";
import { applyBlacklistFile } from "../lib/mcp/blacklist-file";
import { alertIdentityChanged, alertKeyIssued, alertKeyRevoked } from "../lib/mcp/notify";

const BY = "cli";

async function main(argv: string[]): Promise<number> {
  const [cmd, a, b] = argv;
  switch (cmd) {
    case "list": {
      for (const k of await listKeys()) console.log(`${k.key_id}\t${k.email}\t${k.scope}\t${k.identity_status}\t${k.revoked_at ? `revoked ${k.revoked_at}` : "live"}`);
      const ids = await listIdentities();
      console.log(`identities=${ids.length} blacklisted=${ids.filter((i) => i.status === "blacklisted").length}`);
      return 0;
    }
    case "issue": {
      const r = await issueKey(a ?? "", (b === "admin" ? "admin" : b === "read" ? "read" : "bad") as KeyScope, BY);
      await alertKeyIssued(r.email, r.key_id, r.scope, BY);
      console.log(`key_id=${r.key_id} email=${r.email} scope=${r.scope}\n${r.key}`);
      return 0;
    }
    case "rotate": {
      const r = await rotateKey(a ?? "", BY);
      await alertKeyIssued(r.email, r.key_id, r.scope, BY);
      await alertKeyRevoked(r.email, a ?? "", BY);
      console.log(`key_id=${r.key_id} email=${r.email} scope=${r.scope} rotated_from=${a}\n${r.key}`);
      return 0;
    }
    case "revoke": {
      const r = await revokeKey(a ?? "");
      if (r.revoked) await alertKeyRevoked(r.email, a ?? "", BY);
      console.log(r.revoked ? `revoked ${a}` : `nothing to revoke for ${a}`);
      return r.revoked ? 0 : 1;
    }
    case "revoke-identity":
    case "blacklist": {
      const status = cmd === "blacklist" ? "blacklisted" : "revoked";
      await setIdentityStatus(a ?? "", status, BY);
      await alertIdentityChanged((a ?? "").trim().toLowerCase(), status, BY);
      console.log(`${a} -> ${status}`);
      return 0;
    }
    case "blacklist-file": {
      const n = await applyBlacklistFile(BY);
      console.log(`blacklisted=${n}`);
      return 0;
    }
    case "activate":
      console.log((await activateIdentity(a ?? "")) ? `${a} -> active` : `${a}: not a revoked identity (a blacklist is lifted by editing mcp_identity)`);
      return 0;
    case "seed": {
      const spec = JSON.parse(readFileSync(a ?? "", "utf8")) as { keys?: Array<{ sha256: string; email: string; scope: KeyScope }>; blacklist?: string[] };
      let linked = 0;
      let skipped = 0;
      // blacklist FIRST, so a seeded key for a blacklisted address is skipped
      for (const e of spec.blacklist ?? []) await setIdentityStatus(e, "blacklisted", BY);
      for (const k of spec.keys ?? []) {
        const r = await linkExistingKey(String(k.sha256).toLowerCase(), k.email, k.scope === "admin" ? "admin" : "read", BY);
        if ("key_id" in r) linked += 1; else skipped += 1;
      }
      console.log(`linked=${linked} skipped=${skipped} blacklisted=${(spec.blacklist ?? []).length}`);
      return 0;
    }
    default:
      console.error("usage: mcp-keys.ts list | issue <email> <read|admin> | rotate <key_id> | revoke <key_id> | revoke-identity <email> | blacklist <email> | activate <email> | seed <file>");
      return 2;
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`mcp-keys: ${String((e as Error)?.message ?? e).slice(0, 120)}`); process.exit(1); });
