// A mock of the Scribe MCP tools, serving the synthetic payloads in fixtures/synthetic/tools. Used by node tests and injected into the browser check.
// Self-contained on purpose (no imports): browser-check.mjs strips "export " and evaluates it in the page.
export function makeMockMcp(P, opts = {}) {
  const calls = [];
  const fail = (code, message, extra) => Object.assign(new Error(message), { code, message }, extra || {});
  const wrap = data => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, cache: { storedAt: opts.storedAt || 1760000000000, revalidating: false } });
  const handlers = {
    scribe_reb_index(a) {
      let rows = P.reb.rows;
      if (a.ist_date) rows = rows.filter(r => r && r.ist_date === a.ist_date);
      if (a.window_id) rows = rows.filter(r => r && r.window_id === a.window_id);
      const lim = Math.min(a.limit || 200, opts.pageSize || 1000), cur = a.cursor || 0;
      const page = rows.slice(cur, cur + lim), next = cur + lim < rows.length ? cur + lim : null;
      return { ok: true, count: page.length, rows: page, next_cursor: next };
    },
    scribe_freescript(a) {
      if (a.action && a.action !== "read") throw fail("tool_error", "mock refuses action " + a.action);
      let rows = P.fs.rows;
      if (a.consult_uid) rows = rows.filter(r => r.consult_uid === a.consult_uid);
      if (a.ist_date) rows = rows.filter(r => r && r.ist_date === a.ist_date);
      rows = rows.slice(0, Math.min(a.limit || 20, 50));
      return { ok: true, selector: "mock", n: rows.length, withheld_blind: 0, rows };
    },
    scribe_rubric(a) {
      if (a.action !== "results") throw fail("tool_error", "mock refuses action " + a.action);
      let rows = P.rub.results;
      if (a.from) rows = rows.filter(r => r && r.ist_date >= a.from);
      if (a.to) rows = rows.filter(r => r && r.ist_date <= a.to);
      if (a.rubric_id) rows = rows.filter(r => r.rubric_id === a.rubric_id);
      rows = rows.slice(0, Math.min(a.limit || 50, 200));
      return { ok: true, count: rows.length, results: rows };
    },
    scribe_jev_decisions(a) {
      let rows = P.jev.decisions.filter(d => d.subject_type === a.subject_type && d.subject_id === a.subject_id);
      return { ok: true, decisions: rows.slice(0, a.limit || 100) };
    },
    scribe_list_encounters() { return { ok: true, count: 0, rows: [] }; },
    scribe_encounter() { return { ok: true }; },
    scribe_stt_runs() { return { ok: true, runs: [] }; },
  };
  return {
    calls,
    async callTool(server, tool, args, options) {
      calls.push({ server, tool, args: JSON.parse(JSON.stringify(args || {})), options });
      if (server !== "Scribe MCP") throw fail("server_not_found", "no such server");
      if (opts.failWith) throw fail(opts.failWith, "mock failure", { retryable: false });
      if (!handlers[tool]) throw fail("not_in_manifest", "tool not in manifest");
      return wrap(handlers[tool](args || {}));
    },
  };
}
