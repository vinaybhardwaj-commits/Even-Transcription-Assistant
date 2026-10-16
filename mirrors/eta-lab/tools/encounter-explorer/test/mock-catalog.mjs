// A mock of scribe_catalog (search | get | clip_audio_chunk) in the shapes REPORT-CATALOG-1..6 and ORDER-CATALOG-7 describe,
// built from the synthetic mockup dataset. Synthetic only.
// Self-contained on purpose (no imports): browser-check.mjs strips "export " and evaluates it in the page.
export function makeMockCatalog(consults, opts = {}) {
  const calls = [];
  const fail = (code, message, extra) => Object.assign(new Error(message), { code, message }, extra || {});
  const wrap = data => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, cache: { storedAt: opts.storedAt || 1760000000000, revalidating: false } });
  const MIN = "2026-09-09", UID = /^[A-Za-z0-9_-]{6,64}$/, TODAY = opts.today || "2026-10-14";
  const day = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const clean = c => { const L = {}; for (const [k, v] of Object.entries(c.layers || {})) L[k] = v ? { status: v.status, ...(v.engine ? { engine: v.engine } : {}) } : null; return L; };
  const pulse = c => (c.prescription_uid && c.individual_uid ? "https://pulse.even.in/prescription?prescription_uid=" + encodeURIComponent(c.prescription_uid) + "&individual_uid=" + encodeURIComponent(c.individual_uid) : null);
  const hasRx = c => !!c.prescription_uid;
  const identityOf = c => ({ doctor_name: c.doctor_name, patient_name: c.patient_name, individual_uid: c.individual_uid, prescription_uid: c.prescription_uid, presc_state: c.prescription ? c.prescription.presc_state : null, pulse_url: pulse(c) });
  const adminNeeded = a => { if (opts.requireAdmin && (a.include_identity || a.prescription_uid || a.individual_uid)) throw fail("tool_error", "scope_or_tool_unavailable: needed admin", { result: { error: { code: "scope_or_tool_unavailable", needed: "admin" } } }); };
  const isAdmin = () => !(opts.noC4 || opts.requireAdmin);   // read when a call is made, so a test may switch it after the mock is built. C4 columns are admin only: a non-admin caller gets no catalog_c4 key at all
  const c4Row = c => (isAdmin() ? { ...(c.c4_error ? { c4_error: true } : {}), ...(c.catalog_c4 !== undefined ? { catalog_c4: c.catalog_c4 } : {}) } : {});
  const rowOf = (c, withIdentity) => ({
    consult_uid: c.consult_uid, ist_date: c.ist_date, doctor_uid: c.doctor_uid, room_id: c.room_id, t_open: c.t_open, t_close: c.t_close, source: c.source, clip: c.clip,
    layers: clean(c), layers_present: Object.entries(c.layers || {}).filter(([, v]) => v).map(([k]) => (k === "diar_sarvam" ? "diar_sarvam" : k === "stt" ? "stt" : k)), freescript: c.freescript && { artifact_id: Number(String(c.consult_uid).replace(/\D/g, "")) || 1, state: c.freescript.state },
    stages: c.stages, first_gap: c.first_gap, allowance: c.allowance, catalog_version: c.catalog_version, generated_at: c.generated_at,
    ...(opts.noJoin ? { has_prescription: null } : { has_prescription: hasRx(c) }), ...(withIdentity && !opts.noJoin ? { identity: identityOf(c) } : {}), ...c4Row(c),
  });
  const layer = (status, source, data, error, extra) => ({ status, source: [].concat(source), data: status === "ok" ? data : null, ...(error ? { error } : {}), ...(extra || {}) });
  const over = (uid, key, l) => (opts.layers && opts.layers[uid] && opts.layers[uid][key]) || l;
  const memo = new Map();   // the bytes of a clip are generated once, however many chunk calls read them
  const bytesOf = c => { if (!memo.has(c.consult_uid)) memo.set(c.consult_uid, opts.clipBytes ? opts.clipBytes(c) : Uint8Array.from({ length: 2500 + (c.lengthSec || 0) }, (_, i) => (i * 7 + 3) & 255)); return memo.get(c.consult_uid); };
  const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
  const handlers = {
    search(a) {
      adminNeeded(a);
      if (opts.errors && opts.errors.search) return { ok: false, error: opts.errors.search, message: "synthetic " + opts.errors.search };
      if (opts.rxUnsupported && ("has_prescription" in a || "has_rx" in a)) return { ok: false, error: "bad_args", message: "has_rx arrives with catalog C2" };
      let from = a.from, to = a.to, clamped = false, defaultWindow = false;
      if (!from && !to) { to = TODAY; from = day(TODAY, -29); defaultWindow = true; }
      from = from || MIN; to = to || TODAY;
      if (from < MIN) { from = MIN; clamped = true; }
      const span = (Date.parse(to.slice(0, 10) + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
      if (span > 92) return { ok: false, error: "bad_args", message: "span over 92 days" };
      if (a.has_prescription !== undefined && span + 1 > 31) return { ok: false, error: "bad_args", message: "has_prescription spans at most 31 days" };
      const blind = new Set(opts.blind || []);
      let rows = consults.filter(c => c.ist_date >= from && c.ist_date <= to && (!a.doctor_uid || c.doctor_uid === a.doctor_uid) && (!a.room || c.room_id === a.room) && (!a.source || c.source === a.source) && (!a.individual_uid || c.individual_uid === a.individual_uid));
      const nBlind = rows.filter(c => blind.has(c.room_id + "|" + c.ist_date)).length;
      rows = rows.filter(c => !blind.has(c.room_id + "|" + c.ist_date)).sort((x, y) => y.t_open - x.t_open);
      if (a.has_prescription !== undefined) rows = opts.noJoin ? [] : rows.filter(c => hasRx(c) === (a.has_prescription === true || a.has_prescription === "true"));
      const lim = Math.min(a.limit || 50, opts.pageSize || 200), off = a.cursor ? Number(a.cursor) : 0;
      const page = rows.slice(off, off + lim);
      let next = off + lim < rows.length ? String(off + lim) : null;
      if (opts.loopCursor && next !== null) next = String(off);
      return { ok: true, rows: page.map(c => rowOf(c, !!a.include_identity)), next_cursor: next, total_matched: rows.length, catalog_generated_at: "2026-10-14T05:00:00.000Z", n_bad_lines: opts.badLines || 0,
        ...(clamped ? { clamped: true } : {}), ...(defaultWindow ? { default_window: true } : {}), n_blind_excluded: nBlind, identity_rows: opts.noJoin ? 0 : (a.include_identity || a.has_prescription !== undefined ? rows.length : null) };
    },
    async get(a) {
      adminNeeded(a);
      if (!UID.test(String(a.consult_uid || ""))) return { ok: false, error: "bad_args", message: "bad consult_uid" };
      const c = consults.find(x => x.consult_uid === a.consult_uid);
      if (!c) return { ok: false, error: "not_found", message: "not in the catalog" };
      if ((opts.blind || []).includes(c.room_id + "|" + c.ist_date)) return { ok: false, error: "blind_room_day", message: "blind room-day" };
      const T = !!a.include_text, I = !!a.include_identity, uid = c.consult_uid;
      const durMs = (c.lengthSec || 0) * 1000;
      const transcript = c.transcript ? layer("ok", ["reb/" + uid + "/stt cfg8", "reb/" + uid + "/translate cfg8", "reb/" + uid + "/manifest.json"], {
        segments: c.transcript.map((l, i) => ({ i, t0_ms: Math.round(l.t0 * 1000), t1_ms: Math.round(l.t1 * 1000), speaker: l.speaker, role: l.role, lang: l.lang, ...(T ? { text_native: l.text, text_en: l.textEn } : {}) })),
        clock: "ms_from_clip_start", duration_ms: durMs, n_segments: c.transcript.length, manifest_t0_ms: c.t_open - 3000, consult_span_ms: { t0: opts.spanT0 === undefined ? 8000 : opts.spanT0, t1: Math.max(0, durMs - 3000) }, n_clamped: 0,
        ...(opts.degraded && opts.degraded[uid] ? { degraded: opts.degraded[uid] } : {}) }) : layer("absent", ["reb/" + uid + "/stt cfg8"]);
      const parts = c.layers && c.layers.parts ? layer("ok", ["reb/" + uid + "/parts.clef-jev"], [{ part: "p1", t0_ms: 0, t1_ms: 20000, score: 0.7, confidence: 0.8, source: "clef-jev" }], null, { n_clamped: 0 }) : layer("absent", ["reb/" + uid + "/parts.clef-jev"]);
      const freescript = c.note ? layer("ok", ["freescript_latest"], { artifact_id: Number(String(uid).replace(/\D/g, "")) || 1, state: c.freescript && c.freescript.state, validator_status: { ok: !!c.note.validator.ok, errors: c.note.validator.errors }, ...(T ? { artifact: { note_text: c.note.noteText, completion_required: c.note.completionRequired, generator: { model: c.note.model, version: c.note.version } } } : {}) }) : layer("absent", ["freescript_latest"]);
      const rub = [].concat(c.pdqi ? [{ rubric_id: c.pdqi.id, version: c.pdqi.version, run_id: "1", status: c.pdqi.status, score: c.pdqi.score, verdict: null, created_at: "2026-10-14T04:00:00.000Z" }] : [], (c.rubrics || []).map((r, i) => ({ rubric_id: r.id, version: r.version, run_id: String(2 + i), status: r.status, score: r.score, verdict: r.findings[0] ? "needs_review" : null, created_at: "2026-10-14T04:30:00.000Z" })));
      const rubric = rub.length ? layer("ok", ["rubric_result (unit_kind=consult, unit_key=consult_uid)"], rub) : layer("absent", ["rubric_result (unit_kind=consult, unit_key=consult_uid)"]);
      const jev = c.jev ? layer("ok", ["jev_decision (subject_type=consult)"], c.jev.map((d, i) => ({ question_id: d.question, question_set_id: "qs_syn", prompt_version: "v1", mode: "live", answer: d.answer, probabilities: { yes: d.probability, no: Math.round((1 - d.probability) * 100) / 100 }, calibrated_p: i % 2 === 0 ? Math.min(0.99, d.probability + 0.01) : null, mock: opts.mockJev ? true : false, created_at: "2026-10-14T05:00:00.000Z" }))) : c.stages.jev.state === "failed" ? layer("error", ["jev_decision (subject_type=consult)"], null, "db_error:08006")
        // catalog-12 (A1): no jev_decision rows but C4 has jev -> origin catalog_c4, the list at data.sets.sets (opts.flatSets: data.sets is the array)
        : isAdmin() && c.catalog_c4 && c.catalog_c4.jev && Array.isArray(c.catalog_c4.jev.sets) ? layer("ok", ["encounter_catalog.jev (C4)"], { origin: "catalog_c4", sets: opts.flatSets ? c.catalog_c4.jev.sets : { sets: c.catalog_c4.jev.sets } })
        : layer("absent", ["jev_decision (subject_type=consult)"]);
      const hasIdentity = !!(c.doctor_name || c.patient_name);
      const identity = hasIdentity ? layer("ok", ["encounter_catalog"], I ? identityOf(c) : { present: true }) : layer("absent", ["encounter_catalog"]);
      if (identity.status === "absent" && !I) identity.data = { present: false };
      const rx = hasRx(c) ? layer("ok", ["encounter_catalog"], { prescription_uid: I ? c.prescription_uid : null, presc_state: c.prescription ? c.prescription.presc_state : null, has_prescription: true, pulse_url: I ? pulse(c) : null }) : layer("absent", ["encounter_catalog"]);
      const layers = {
        transcript: over(uid, "transcript", transcript), parts: over(uid, "parts", parts), freescript: over(uid, "freescript", freescript), rubric: over(uid, "rubric", rubric), jev: over(uid, "jev", jev),
        identity: over(uid, "identity", identity), cdmss: layer("not_available", ["consult-audit S5 (pending)"]), rx: over(uid, "rx", rx),
        // C4 (admin only): absent key for a non-admin caller; status error for a failed read
        ...(isAdmin() && c.c4_error ? { catalog_c4: layer("error", ["encounter_catalog.c4"], null, "c4_read_failed") } : isAdmin() && c.catalog_c4 !== undefined ? { catalog_c4: layer(c.catalog_c4 === null ? "absent" : "ok", ["encounter_catalog.c4"], c.catalog_c4) } : {}),
      };
      if (opts.layerExtra && opts.layerExtra[uid]) Object.assign(layers, opts.layerExtra[uid]);
      const row = rowOf(c, I);
      if (row.clip) row.clip = { ...row.clip, audio_sha256: opts.rowHash !== undefined ? opts.rowHash : await sha256hex(bytesOf(c)) };   // get carries the real hash of the stored bytes
      return { ok: true, row, layers };
    },
    async clip_audio_chunk(a) {
      if (opts.noChunk) return { ok: false, error: "unknown_action", message: "unknown action" };
      if (!UID.test(String(a.consult_uid || ""))) return { ok: false, error: "bad_args", message: "bad consult_uid" };
      const c = consults.find(x => x.consult_uid === a.consult_uid);
      if (!c) return { ok: false, error: "not_found", message: "not in the catalog" };
      if ((opts.blind || []).includes(c.room_id + "|" + c.ist_date)) return { ok: false, error: "blind_room_day", message: "blind room-day" };
      if (!c.clip || !c.clip.r2_key) return { ok: false, error: "no_clip", sealed: (c.stages.sealed && c.stages.sealed.reason) || null };   // catalog-13b: a null clip key
      if (opts.errors && opts.errors.clip) return { ok: false, error: opts.errors.clip, message: "synthetic " + opts.errors.clip };
      const offset = a.offset === undefined ? 0 : a.offset, length = a.length === undefined ? 1048576 : a.length;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 1048576) return { ok: false, error: "bad_args", message: "bad offset/length" };
      const all = bytesOf(c), total = opts.totalBytes || all.length;
      if (offset >= total) return { ok: false, error: "bad_range", total_bytes: total };
      const n = Math.min(length, opts.maxChunk || length, total - offset);
      if (opts.slowMs) { /* the page awaits callTool; the delay is applied there */ }
      const slice = all.subarray(offset, offset + n);
      return { ok: true, consult_uid: c.consult_uid, offset, length: n, total_bytes: total, content_type: opts.contentType || "audio/flac", base64: b64(opts.corrupt ? slice.subarray(0, Math.max(0, n - 1)) : slice), done: offset + n >= total, signature_sha256: "f".repeat(64), ...(opts.chunkHash === null ? {} : { audio_sha256: opts.chunkHash !== undefined ? opts.chunkHash : await sha256hex(all.subarray(0, total)) }) };
    },
  };
  const api = {
    calls,
    async callTool(server, tool, args, options) {
      calls.push({ server, tool, args: JSON.parse(JSON.stringify(args || {})), options });
      if (options && options.signal && options.signal.aborted) throw fail("cancelled", "aborted");
      if (server !== "Scribe MCP") throw fail("server_not_found", "no such server");
      if (tool !== "scribe_catalog") throw fail("not_in_manifest", "tool not in manifest");
      if (opts.failWith) throw fail(opts.failWith, "mock failure", { retryable: false });
      if (opts.slowMs) await new Promise((res, rej) => { const t = setTimeout(res, opts.slowMs); if (options && options.signal) options.signal.addEventListener("abort", () => { clearTimeout(t); rej(fail("cancelled", "aborted")); }); });
      if (opts.failFirst && (opts.failFirst[(args || {}).action] || 0) > 0) { opts.failFirst[args.action]--; return wrap({ ok: false, error: "catalog_unavailable", message: "the catalog is rebuilding" }); }   // the hourly rebuild: the first N calls of an action fail
      const h = handlers[(args || {}).action];
      if (!h) return wrap({ ok: false, error: "unknown_action", message: "unknown action" });
      let out;
      try { out = await h(args || {}); } catch (e) { if (e && e.code === "bad_args") out = { ok: false, error: "bad_args", message: e.message }; else throw e; }
      if (opts.rejectEnvelopes && out && out.ok === false) throw fail("tool_error", out.message || out.error, { result: wrap(out) });   // the runtime rejects tool failures with the envelope on e.result
      return wrap(out);
    },
  };
  if (!opts.noDescribe) api.describeTool = async (server, tool) => ({ name: tool, description: "", inputSchema: { type: "object", properties: { action: { enum: ["search", "get", "clip_audio_url"].concat(opts.noChunk ? [] : ["clip_audio_chunk"]) } } } });
  return api;
}

async function sha256hex(u8) { return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", u8))].map(b => b.toString(16).padStart(2, "0")).join(""); }
