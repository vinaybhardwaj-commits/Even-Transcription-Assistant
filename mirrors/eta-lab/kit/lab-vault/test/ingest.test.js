import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../worker/index.js";
import { parseKey } from "../worker/validate.js";

const TOKEN = "t".repeat(40);
const RUN = "hist-bulk-20260924T1912-ab12cd3";
const KEY = `runs/${RUN}/room_x/2026-09-24/win1.json`;

// Fake R2 with the same put(onlyIf etagDoesNotMatch "*") / head / get semantics as the binding.
function fakeBucket() {
  const objs = new Map();
  return {
    objs, puts: 0, deletes: 0,
    async put(key, bytes, opts) {
      if (this.throwOnExisting && objs.has(key)) throw new Error("10054: object is locked");
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && objs.has(key)) return null;
      this.puts++;
      objs.set(key, { bytes: new Uint8Array(bytes), customMetadata: opts.customMetadata, checksums: { sha256: new Uint8Array(Buffer.from(opts.sha256, "hex")).buffer } });
      return { key };
    },
    async head(key) { return objs.get(key) ?? null; },
    async list({ prefix }) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async get(key) { const o = objs.get(key); return o && { arrayBuffer: async () => o.bytes.buffer.slice(0) }; },
    async delete() { this.deletes++; },
  };
}
const env = () => ({ INGEST_TOKEN: TOKEN, RESULTS: fakeBucket() });
const prov = (over = {}) => ({
  schema: "eta-lab-result/1",
  provenance: {
    run_id: RUN, producer: "hist-bulk", created_at: "2026-09-24T19:12:03+05:30", provenance_complete: true, not_run: ["diarizer"],
    stack: { whisper: { model: "large-v3", flags: { vad: false } }, indic_conformer: { model_id: "m", git_head: "g" }, sravaani: { version: "1" }, router: { commit: "c", config_sha256: "s" } },
    guards: { shim_anti_loop: "1", english_hallucination_guard: "1", transcript_guard: "1", loop_guard_number_rule: "1" },
    diarizer: null, stack_versions_sha256: "a".repeat(64), source_audio_keys: ["audio/x.wav"], ...over,
  },
  segments: [],
});
const put = (e, key, body, headers = {}, method = "PUT") =>
  worker.fetch(new Request(`https://x.test/v1/obj/${key}`, { method, body: typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer ? body : JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}`, ...headers } }), e);

test("create then identical then conflict", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  assert.equal((await put(e, KEY, body)).status, 201);
  assert.equal((await put(e, KEY, body)).status, 200);
  assert.equal(e.RESULTS.puts, 1);
  const r = await put(e, KEY, JSON.stringify({ ...prov(), segments: [1] }));
  assert.equal(r.status, 409);
  assert.equal(e.RESULTS.objs.get(KEY).bytes.length, body.length);
  assert.equal(e.RESULTS.deletes, 0);
});

test("sha256 is computed server-side, a client header is ignored", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  const r = await put(e, KEY, body, { "x-content-sha256": "0".repeat(64) });
  assert.equal((await r.json()).sha256, createHash("sha256").update(body).digest("hex"));
});

test("auth: none, wrong, unconfigured", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  const noAuth = await worker.fetch(new Request(`https://x.test/v1/obj/${KEY}`, { method: "PUT", body }), e);
  assert.equal(noAuth.status, 401);
  assert.equal((await put(e, KEY, body, { authorization: "Bearer nope" })).status, 401);
  assert.equal((await put({ RESULTS: e.RESULTS }, KEY, body)).status, 503);
  assert.equal((await put({ RESULTS: e.RESULTS, INGEST_TOKEN: "short" }, KEY, body)).status, 503);
  assert.equal(e.RESULTS.puts, 0);
  assert.ok(!(await noAuth.text()).includes(TOKEN));
});

test("no destructive or other routes", async () => {
  const e = env();
  for (const method of ["DELETE", "POST", "PATCH", "GET", "HEAD"]) {
    const r = await worker.fetch(new Request(`https://x.test/v1/obj/${KEY}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }), e);
    assert.equal(r.status, 405, method);
  }
  assert.equal((await put(e, `${KEY}?overwrite=1`, JSON.stringify(prov()))).status, 400);
  assert.equal((await put(e, KEY, "x", { "content-type": "multipart/form-data; boundary=a" })).status, 415);
  assert.equal(e.RESULTS.puts + e.RESULTS.deletes, 0);
});

test("keys: prefixes and traversal", () => {
  const ok = [KEY, `runs/${RUN}/room_x/2026-09-24/win1.attempt2.json`, `manifests/${RUN}.json`, `manifests/${RUN}.start.json`, "index/windows-20260924.jsonl", "index/windows-20260924.parquet", "index/search-20260924.jsonl", "index/chunks-20260924.jsonl", "index/view-202609250647.jsonl", "runs/hist-miner-backfill-20260924/r/2026-08-04/w.json", "runs/stt-parity-backfill-20260924/r/2026-08-04/w.json"];
  for (const k of ok) assert.ok(parseKey(k), k);
  const bad = ["../runs/x", "runs/../x", `runs/${RUN}/../room/2026-09-24/w.json`, "/runs/x", `runs//${RUN}`, "runs\\x", "%2e%2e/x", `runs/${RUN}/room_x/2026-09-24/%2e%2e.json`,
    "other/x.json", "audio/x.json", `runs/${RUN}/room_x/2026-09-24/w.txt`, "index/windows.jsonl", "index/search-20260924.parquet", "index/search.jsonl", "index/chunks-20260924.parquet", "index/chunks.jsonl", "index/view-20260925.jsonl", "index/view-202609250647.parquet", "index/view-2026092506470.jsonl", "index/../runs", `runs/nobody-20260924T1912-ab12cd3/r/2026-09-24/w.json`, `runs/${RUN}/r/24-09-2026/w.json`, "", `runs/${RUN}/r/2026-09-24/w..json`];
  for (const k of bad) assert.equal(parseKey(k), null, k);
});

test("size cap incl. chunked body without content-length", async () => {
  const e = env();
  const big = "index/windows-20260924.jsonl";
  const over = new Uint8Array(50 * 1024 * 1024 + 1);
  assert.equal((await put(e, big, over.buffer.slice(0), { "content-length": String(over.length) })).status, 413);
  const stream = new ReadableStream({ start(c) { const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 51; i++) c.enqueue(chunk); c.close(); } });
  const r = await worker.fetch(new Request(`https://x.test/v1/obj/${big}`, { method: "PUT", body: stream, duplex: "half", headers: { authorization: `Bearer ${TOKEN}` } }), e);
  assert.equal(r.status, 413);
  const exact = new Uint8Array(50 * 1024 * 1024).fill(97);
  assert.equal((await put(e, big, exact)).status, 201);
  assert.equal((await put(e, "index/windows-20260925.jsonl", new Uint8Array(0))).status, 400);
});

test("provenance: new run rejected when incomplete, backfill flagged", async () => {
  const e = env();
  const cases = {
    "no schema": (d) => delete d.schema,
    "run_id mismatch": (d) => (d.provenance.run_id = "hist-bulk-20260924T1913-ab12cd3"),
    "producer mismatch": (d) => (d.provenance.producer = "vj"),
    "null whisper model": (d) => (d.provenance.stack.whisper.model = null),
    "missing router config": (d) => delete d.provenance.stack.router.config_sha256,
    "missing guard": (d) => delete d.provenance.guards.transcript_guard,
    "no source keys": (d) => (d.provenance.source_audio_keys = []),
    "diarizer null unexplained": (d) => (d.provenance.not_run = []),
    "not complete, no reason": (d) => (d.provenance.provenance_complete = false),
    "not complete, blank reason": (d) => { d.provenance.provenance_complete = false; d.provenance.incomplete_reason = "  "; },
    "bad created_at": (d) => (d.provenance.created_at = "yesterday"),
    "bad stack hash": (d) => (d.provenance.stack_versions_sha256 = "abc"),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const d = prov(); mutate(d);
    const r = await put(e, KEY, d);
    assert.equal(r.status, 422, name);
  }
  assert.equal((await put(e, KEY, "not json")).status, 422);
  assert.equal(e.RESULTS.puts, 0);

  const BF = "hist-bulk-backfill-20260924";
  const bfKey = `runs/${BF}/room_x/2026-08-04/w1.json`;
  const bf = { schema: "eta-lab-result/1", provenance: { run_id: BF, producer: "hist-bulk", provenance_complete: false } };
  assert.equal((await put(e, bfKey, bf)).status, 201);
  bf.provenance.provenance_complete = true; // claims complete but is not
  assert.equal((await put(e, `runs/${BF}/room_x/2026-08-04/w2.json`, bf)).status, 422);
  assert.equal((await put(e, `runs/${BF}/room_x/2026-08-04/w3.json`, { schema: "eta-lab-result/1", provenance: { run_id: BF, producer: "hist-bulk" } })).status, 422); // flag must be present
});

test("manifest needs no source_audio_keys; .start allowed", async () => {
  const e = env();
  const d = prov({ source_audio_keys: undefined });
  delete d.provenance.source_audio_keys;
  assert.equal((await put(e, `manifests/${RUN}.start.json`, d)).status, 201);
  assert.equal((await put(e, `manifests/${RUN}.json`, d)).status, 201);
});

test("a locked prefix that throws on an existing key still gives 200/409, and a real failure is a 500 without a write", async () => {
  const e = env();
  e.RESULTS.throwOnExisting = true;
  const body = JSON.stringify(prov());
  assert.equal((await put(e, KEY, body)).status, 201);
  assert.equal((await put(e, KEY, body)).status, 200);
  assert.equal((await put(e, KEY, JSON.stringify({ ...prov(), segments: [1] }))).status, 409);
  const broken = { INGEST_TOKEN: TOKEN, RESULTS: { async put() { throw new Error("boom"); }, async head() { return null; } } };
  const r = await put(broken, KEY, body);
  assert.equal(r.status, 500);
});

test("addendum: an immutable note under manifests/, needs a reason and the run_id of its key", async () => {
  const e = env();
  const key = `manifests/${RUN}.addendum.json`;
  const ok = { schema: "eta-lab-result/1", provenance: { run_id: RUN, producer: "hist-bulk" }, addendum: { reason: "ruling 196; field absent", temperature_fallback: "on (ruling 196; field absent)" } };
  assert.ok(parseKey(key) && parseKey(key).kind === "addendum");
  assert.equal((await put(e, KEY, prov())).status, 201); // the run has records, so a note may be pinned on it
  assert.equal((await put(e, key, ok)).status, 201);
  assert.equal((await put(e, key, ok)).status, 200);
  assert.equal((await put(e, key, { ...ok, addendum: { reason: "changed" } })).status, 409); // still write-once
  assert.equal((await put(e, `manifests/${RUN}.addendum.json`.replace("ab12cd3", "ab12cd4"), ok)).status, 422); // run_id differs from the key
  await put(e, `runs/hist-bulk-20260924T1913-ab12cd3/room_x/2026-09-24/win1.json`, { ...prov(), provenance: { ...prov().provenance, run_id: "hist-bulk-20260924T1913-ab12cd3" } });
  for (const bad of [{ ...ok, addendum: {} }, { ...ok, addendum: { reason: " " } }, { ...ok, addendum: [] }, { schema: "eta-lab-result/1", provenance: ok.provenance }])
    assert.equal((await put(e, `manifests/hist-bulk-20260924T1913-ab12cd3.addendum.json`, { ...bad, provenance: { ...(bad.provenance ?? ok.provenance), run_id: "hist-bulk-20260924T1913-ab12cd3" } })).status, 422);
  assert.equal(parseKey(`manifests/${RUN}.addendum.start.json`), null);
});

test("empty source_audio_keys only for a window that says it used no audio", async () => {
  const e = env();
  const empty = (extra) => ({ ...prov({ source_audio_keys: [] }), ...extra });
  assert.equal((await put(e, KEY, empty({}))).status, 422);                                   // no cut info: still rejected
  assert.equal((await put(e, KEY, empty({ cut: { n_chunks: 2 } }))).status, 422);              // chunks were used but none listed
  assert.equal((await put(e, KEY, empty({ cut: { n_chunks: 0, chunks_dropped: ["bc_x"] }, ok: false, error: "no_audio_in_window" }))).status, 201);
});

test("n_chunks==0 relaxation: exact 0 only, and the record must not claim a transcript (refuter-2 #892)", async () => {
  const e = env();
  const mk = (extra) => ({ ...prov({ source_audio_keys: [] }), ...extra });
  for (const n of ["0", false, null, -1, 1, "", [], undefined]) assert.equal((await put(e, KEY, mk({ cut: { n_chunks: n }, ok: false }))).status, 422, String(n));
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: true, segments: [{ text: "hi" }] }))).status, 422);   // claims a transcript with no audio
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: true, segments: [] }))).status, 422);        // must say it failed
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, segments: [{ text: "x" }] }))).status, 422);
  for (const text of [{ turns: [{ text: "hello" }] }, { transcript_native: "hello" }, { transcript_en: "hello" }, { segments: { a: 1 } }, { turns: ["hello"] }])
    assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, ...text }))).status, 422, JSON.stringify(text)); // text via any field (refuter-2 #951 F1)
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, state: "failed", error: "no_audio_in_window", segments: [], transcript_native: "" }))).status, 201);
});

test("addendum: producer must match the key's run, and the run must already have records", async () => {
  const e = env();
  const key = `manifests/${RUN}.addendum.json`;
  const body = (producer) => ({ schema: "eta-lab-result/1", provenance: { run_id: RUN, producer }, addendum: { reason: "note" } });
  assert.equal((await put(e, key, body("hist-bulk"))).status, 422);             // run has no records yet
  assert.equal((await put(e, KEY, prov())).status, 201);                       // now it does
  assert.equal((await put(e, key, body("vj"))).status, 422);                   // wrong producer
  assert.equal((await put(e, key, body("hist-bulk"))).status, 201);
});

test("segments must be an array when present (protects the nightly index build)", async () => {
  const e = env();
  for (const segments of ["x", { a: 1 }, 5]) assert.equal((await put(e, KEY, { ...prov(), segments })).status, 422, JSON.stringify(segments));
  assert.equal((await put(e, `runs/${RUN}/room_x/2026-09-24/win2.json`, { ...prov(), segments: null })).status, 201);   // real no-audio records carry segments: null
  assert.equal((await put(e, KEY, { ...prov(), segments: [{ text: "ok" }] })).status, 201);
});

test("non-backfill provenance_complete:false is saved when it has a reason, but required fields are still enforced", async () => {
  const e = env();
  const d = prov({ provenance_complete: false, incomplete_reason: "stack drift: router unit hash differs from the published file" });
  assert.equal((await put(e, KEY, d)).status, 201);
  const gone = prov({ provenance_complete: false, incomplete_reason: "x" }); delete gone.provenance.stack.router.commit;
  assert.equal((await put(e, `runs/${RUN}/room_x/2026-09-24/win9.json`, gone)).status, 422);   // a missing required leaf is never excused
  assert.equal((await put(e, `runs/${RUN}/room_x/2026-09-24/win8.json`, prov({ provenance_complete: "no", incomplete_reason: "x" }))).status, 422);
});

test("flagged record with an ENTIRELY null stack/guards block is saved (Mini window without a stack file); partial or unflagged is not", async () => {
  const e = env();
  const nullify = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, nullify(v)])) : null);
  const flag = (extra = {}) => { const d = prov({ provenance_complete: false, incomplete_reason: "no published stack_versions for stack_kind mini-production", missing: ["no published stack_versions for stack_kind mini-production"], ...extra }); d.provenance.stack = nullify(d.provenance.stack); d.provenance.guards = nullify(d.provenance.guards); return d; };
  assert.equal((await put(e, KEY, flag())).status, 201);
  const withMarker = flag(); withMarker.provenance.stack.whisper.flags.temperature_fallback = "on";   // hist-bulk adds this to the stack copy (ruling 196)
  assert.equal((await put(e, `runs/${RUN}/room_x/2026-09-24/marker.json`, withMarker)).status, 201);
  const at = (n) => `runs/${RUN}/room_x/2026-09-24/m${n}.json`;
  const partial = flag(); partial.provenance.stack.whisper.model = "large-v3";           // one leaf filled, the rest null: still enforced
  assert.equal((await put(e, at(1), partial)).status, 422);
  const noMissing = flag(); delete noMissing.provenance.missing;                            // no named gap
  assert.equal((await put(e, at(2), noMissing)).status, 422);
  const emptyMissing = flag({ missing: [] }); assert.equal((await put(e, at(3), emptyMissing)).status, 422);
  const noReason = flag(); delete noReason.provenance.incomplete_reason; assert.equal((await put(e, at(4), noReason)).status, 422);
  const complete = flag({ provenance_complete: true }); assert.equal((await put(e, at(5), complete)).status, 422);   // claims complete with a null stack
  const noSha = flag({ stack_versions_sha256: "x" }); assert.equal((await put(e, at(6), noSha)).status, 422);     // other required fields unchanged
  const keys = flag({ source_audio_keys: [] }); assert.equal((await put(e, at(7), keys)).status, 422);
  // refuter-2 #1318: `missing` must name the excused block
  const unrelated = flag({ missing: ["x"] }); assert.equal((await put(e, at(8), unrelated)).status, 422);
  const stackOnly = flag({ missing: ["stack block unavailable"] }); assert.equal((await put(e, at(9), stackOnly)).status, 422);       // guards are null too but not named
  const both = flag({ missing: ["stack block unavailable", "guards unavailable"] }); assert.equal((await put(e, at(10), both)).status, 201);
  const viaDoc = flag({ missing: ["no published stack_versions for stack_kind mini-production"] }); assert.equal((await put(e, at(11), viaDoc)).status, 201); // the real Mini wording
});

test("addendum.no_signal: rule + non-empty window_ids list of strings", async () => {
  const e = env(); const key = `manifests/${RUN}.addendum.json`;
  assert.equal((await put(e, KEY, prov())).status, 201);
  const body = (ns) => ({ schema: "eta-lab-result/1", provenance: { run_id: RUN, producer: "hist-bulk" }, addendum: { reason: "exact-zero recording", no_signal: ns } });
  for (const bad of [null, [], {}, { rule: "r" }, { rule: "r", window_ids: [] }, { rule: "r", window_ids: [1] }, { rule: "", window_ids: ["a"] }, { rule: "r", window_ids: "a" }])
    assert.equal((await put(e, key, body(bad))).status, 422, JSON.stringify(bad));
  assert.equal((await put(e, key, body({ rule: "exact_zero_by_size_v1", rule_sha: "abc", window_ids: ["w1", "w2"] }))).status, 201);
});

test("annotations: additive overlay files with a strict grammar, body and a binding to the source record sha (r341)", async () => {
  const e = env();
  const ROOM = "room_2qe955hy", DAY = "2026-09-24";
  const kw = (w) => `${RUN}/${ROOM}/${DAY}/${w}`, sha = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
  const rec = { w1: prov(), w2: prov({ source_audio_keys: ["audio/y.wav"] }) };
  for (const w of ["w1", "w2"]) assert.equal((await put(e, `runs/${kw(w)}.json`, rec[w])).status, 201);
  const key = `annotations/translation/${ROOM}/${DAY}/202609250900-linker.json`;
  const body = (o = {}) => ({ schema: "eta-lab-annotation/1", kind: "translation", provenance: { producer: "linker", model: "m", created_at: "2026-09-25T09:00:00+05:30" }, sources: { [kw("w1")]: sha(rec.w1) }, items: [{ k: kw("w1"), i: 0, en: "hello" }], ...o });
  assert.equal((await put(e, key, body())).status, 201);
  assert.equal((await put(e, key, body())).status, 200);                                                   // identical: no-op
  assert.equal((await put(e, key, body({ items: [{ k: kw("w1"), i: 0, en: "changed" }] }))).status, 409);   // write-once
  const other = (k, st = "202609250901") => `annotations/${k}/${ROOM}/${DAY}/${st}-linker.json`;
  assert.equal((await put(e, other("readability"), body({ kind: "readability", items: [{ k: kw("w1"), i: 3, ok: false }] }))).status, 201);
  assert.equal((await put(e, other("retranscription"), body({ kind: "retranscription", items: [{ k: kw("w1"), i: 3, text2: "t", better: true }] }))).status, 201);
  const p = (k, b) => put(e, k, b);
  assert.equal((await p(other("translation"), body({ kind: "readability" }))).status, 422);                   // kind differs from the key
  assert.equal((await p(other("translation"), body({ provenance: { producer: "someone-else" } }))).status, 422);
  assert.equal((await p(other("translation"), body({ items: [] }))).status, 422);
  assert.equal((await p(other("translation"), body({ items: [{ k: kw("w1"), i: -1 }] }))).status, 422);
  assert.equal((await p(other("translation"), body({ items: [{ k: kw("w1"), i: 1.5 }] }))).status, 422);
  assert.equal((await p(other("translation"), body({ schema: "wrong" }))).status, 422);
  // binding: sources required, exact, for every k; the record must exist in the vault with exactly that sha
  assert.equal((await p(other("translation", "202609250902"), body({ sources: undefined }))).status, 422);
  assert.equal((await p(other("translation", "202609250903"), body({ sources: { [kw("w1")]: "0".repeat(64) } }))).status, 422);              // wrong sha
  assert.equal((await p(other("translation", "202609250904"), body({ sources: { [kw("w1")]: sha(rec.w1).toUpperCase() } }))).status, 422);  // not lower-case hex
  assert.equal((await p(other("translation", "202609250905"), body({ items: [{ k: kw("w1"), i: 0 }, { k: kw("w2"), i: 0 }] }))).status, 422); // k without a source
  assert.equal((await p(other("translation", "202609250906"), body({ sources: { [kw("w1")]: sha(rec.w1), [kw("w2")]: sha(rec.w2) } }))).status, 422); // source nobody uses
  const ghost = kw("w9"); assert.equal((await p(other("translation", "202609250907"), body({ items: [{ k: ghost, i: 0 }], sources: { [ghost]: "1".repeat(64) } }))).status, 422); // record not in the vault
  const elsewhere = `${RUN}/room_other/${DAY}/w1`;
  assert.equal((await p(other("translation", "202609250908"), body({ items: [{ k: elsewhere, i: 0 }], sources: { [elsewhere]: sha(rec.w1) } }))).status, 422);  // k not in the key's room
  assert.equal((await p(other("translation", "202609250909"), body({ items: [{ k: "x", i: 0 }], sources: { x: sha(rec.w1) } }))).status, 422);                 // not a run key
  assert.equal((await p(other("translation", "202609250910"), body({ sources: { [kw("w1")]: sha(rec.w1) }, items: [{ k: kw("w1"), i: 0 }, { k: kw("w1"), i: 1 }] }))).status, 201);   // several items, one window: one source
  for (const bad of ["annotations/other/room_x/2026-09-24/202609250900-linker.json", "annotations/translation/room_x/2026-09-24/20260925-linker.json", "annotations/translation/room_x/2026-9-24/202609250900-linker.json",
    "annotations/translation/room_x/2026-09-24/202609250900-Linker.json", "annotations/translation/../runs/x/2026-09-24/202609250900-linker.json", "annotations/translation/room_x/2026-09-24/202609250900-linker.json/extra"])
    assert.equal(parseKey(bad), null, bad);
});

test("annotations kind=correction: window-level status, bound to the record sha, write-once (r341, r342)", async () => {
  const e = env();
  const ROOM = "room_87frpus9", DAY = "2026-09-11", W = `${RUN}/${ROOM}/${DAY}/2026-09-11_${ROOM}_0315`;
  const record = prov(); assert.equal((await put(e, `runs/${W}.json`, record)).status, 201);
  const ckey = (st = "202609250930") => `annotations/correction/${ROOM}/${DAY}/${st}-hist-bulk.json`;
  const doc = (o = {}) => ({ schema: "eta-lab-annotation/1", kind: "correction", provenance: { producer: "hist-bulk", created_at: "2026-09-25T09:30:00+05:30" },
    sources: { [W]: createHash("sha256").update(JSON.stringify(record)).digest("hex") }, items: [{ k: W, status: "undetermined", reason: "short-chunk-only window" }], ...o });
  assert.equal(parseKey(ckey()).annotKind, "correction");
  assert.equal((await put(e, ckey(), doc())).status, 201);                                                    // no i needed for a window-level correction
  assert.equal((await put(e, ckey(), doc())).status, 200);
  assert.equal((await put(e, ckey(), doc({ items: [{ k: W, status: "near_silence" }] }))).status, 409);       // write-once: a change is a new file
  assert.equal((await put(e, ckey("202609250931"), doc({ items: [{ k: W, status: "near_silence" }] }))).status, 201);
  for (const bad of [{ k: W }, { k: W, status: "no_signal" }, { k: W, status: "undetermined", reason: 5 }, { k: W, status: "undetermined", reason: "x".repeat(301) }, { k: W, status: "undetermined", i: -1 }])
    assert.equal((await put(e, ckey("202609250932"), doc({ items: [bad] }))).status, 422, JSON.stringify(bad));
  assert.equal((await put(e, ckey("202609250933"), doc({ items: [{ k: W, status: "undetermined" }], sources: { [W]: "0".repeat(64) } }))).status, 422); // bound to the record's sha
  assert.equal((await put(e, `annotations/corrections/${ROOM}/${DAY}/202609250930-hist-bulk.json`, doc())).status, 400);   // no separate key kind
  for (const k of ["notes", "rating", "labels", "Correction", "translation2"]) assert.equal(parseKey(`annotations/${k}/${ROOM}/${DAY}/202609250930-hist-bulk.json`), null, k);   // the kind list is exactly the four of r341
  assert.deepEqual(["translation", "readability", "retranscription", "correction"].map((k) => parseKey(`annotations/${k}/${ROOM}/${DAY}/202609250930-hist-bulk.json`)?.annotKind), ["translation", "readability", "retranscription", "correction"]);
});
