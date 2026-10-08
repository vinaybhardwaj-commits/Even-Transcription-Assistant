/**
 * scripts/mcp-surface-report.ts — S0.9 (8 Oct 2026): what does tools/list cost a client?
 *
 * Calls the REAL handler (lib/mcp/handler) for `tools/list`, so the output is exactly what the door
 * serves, writes it in the shape of the existing captures, and prints the weight of the surface.
 *
 *   fixtures/mcp/live-tools-list-<7-char git sha>.json   { jsonrpc, id, result: { tools } }
 *
 * Usage:  npx tsx scripts/mcp-surface-report.ts
 * No database is touched (tools/list never queries); a placeholder APP_DATABASE_URL is set only if
 * none is, so lib/db can be imported. Old fixtures are never deleted or rewritten.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.APP_DATABASE_URL ||= "postgresql://report:report@localhost/report";
process.env.SCRIBE_MCP_TOKEN ||= "report-only";

async function main() {
  const { NextRequest } = await import("next/server");
  const { handleMcpRpc } = await import("../lib/mcp/handler");

  const sha = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  const req = new NextRequest("https://report.invalid/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const res = await handleMcpRpc(req, { token_id: "report", scopes: new Set(["read", "invoke", "write"]) });
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown }> } };
  const tools = body.result?.tools;
  if (!tools) throw new Error("tools/list returned no tools");

  const dir = join(process.cwd(), "fixtures", "mcp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `live-tools-list-${sha}.json`);
  const text = JSON.stringify(body);
  writeFileSync(file, text);

  const chars = text.length;
  const descChars = tools.reduce((n, t) => n + t.description.length, 0);
  const schemaChars = tools.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0);
  console.log(`wrote fixtures/mcp/live-tools-list-${sha}.json`);
  console.log(`tools: ${tools.length}`);
  console.log(`total chars: ${chars}  (descriptions ${descChars}, input schemas ${schemaChars})`);
  console.log(`estimated tokens (chars/4): ${Math.round(chars / 4)}`);
  console.log("10 largest descriptions:");
  for (const t of [...tools].sort((a, b) => b.description.length - a.description.length).slice(0, 10)) {
    console.log(`  ${String(t.description.length).padStart(6)} chars  ${t.name}`);
  }
}

main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e));
  process.exit(1);
});
