// eta-lab-inventory: READ-ONLY listing of the eta-lab-results vault, for the daily three-copy check.
// GET /v1/inventory?prefix=runs/&cursor=... -> [{key,size,sha256}]. No write, delete or body-returning route.
// Kept separate from eta-lab-ingest so the writing Worker has no list route ("no list-with-write").
const enc = new TextEncoder();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function tokenOk(given, secret) {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(secret))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (typeof env.INVENTORY_TOKEN !== "string" || env.INVENTORY_TOKEN.length < 32) return json(503, { error: "not configured" });
      const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
      if (!m || !(await tokenOk(m[1], env.INVENTORY_TOKEN))) return json(401, { error: "unauthorized" });
      if (url.pathname !== "/v1/inventory") return json(404, { error: "not found" });
      if (request.method !== "GET") return json(405, { error: "GET only" });
      const prefix = url.searchParams.get("prefix") || "";
      if (!["runs/", "manifests/", "index/", "annotations/"].some((p) => prefix.startsWith(p)) || /[^A-Za-z0-9._\/-]/.test(prefix)) return json(400, { error: "prefix must start with runs/, manifests/, index/ or annotations/" });
      const page = await env.RESULTS.list({ prefix, limit: 1000, cursor: url.searchParams.get("cursor") || undefined, include: ["customMetadata"] });
      return json(200, {
        objects: page.objects.map((o) => ({ key: o.key, size: o.size, sha256: o.customMetadata?.sha256 ?? null })),
        truncated: page.truncated, cursor: page.truncated ? page.cursor : null,
      });
    } catch (e) {
      return json(500, { error: "internal", detail: `${e?.name}: ${String(e?.message).slice(0, 200)}` });
    }
  },
};
