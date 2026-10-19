/** Minimal MCP-over-HTTP call used by `ubus-node send|inbox` to reach the hub (P0 tools ubus_send / ubus_inbox). */
export async function callTool(url: string, tool: string, args: Record<string, unknown>, handle: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = async (body: object) => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    const text = await r.text();
    if (!r.ok) throw new Error(`hub status ${r.status}`);
    const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}"
      : text || "{}";
    return JSON.parse(data) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ubus-node", version: "1" } } });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { ...args, as: handle } } });
  if (res.error) throw new Error(res.error.message ?? "hub error");
  return res.result?.content?.[0]?.text ?? "";
}
