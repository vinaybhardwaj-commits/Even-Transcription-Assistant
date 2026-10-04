// Rebuilds the encounter-windows test fixture from the reference run's raw exports.
//   node tests/fixtures/encounter-windows/build-fixture.mjs <dir-with-events.json-and-consults.json>
// The reference (V's ~/pulse-watch/gate-p1: dump.mjs -> events.json, consults.mjs -> consults.json) covers 2-4 Oct 2026.
// Output (committed):
//   events.json.gz   the events the resolver reads, as arrays: [id, source, machine, event, ts, uid, dn, enc, rx, focus]
//                    encounter ids, prescription refs and display names are replaced by short SHA-256 pseudonyms
//                    (equality is preserved, which is all the resolver uses); no patient or doctor names are kept.
//   expected.json    the reference's 114 consults reduced to the facts the tests compare, plus the crosswalk and the
//                    reference's unpaired-ref total.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) throw new Error("usage: build-fixture.mjs <dir>");
const here = dirname(fileURLToPath(import.meta.url));
const ev = JSON.parse(readFileSync(join(src, "events.json"), "utf8"));
const ref = JSON.parse(readFileSync(join(src, "consults.json"), "utf8"));

// room slugs can embed a doctor name ("opd-5-dr-<name>-xxxx"); strip it, the tests only need slugs to be distinct
const slug = (v) => (v == null ? null : v.replace(/-dr-[a-z]+/g, ""));
const pseudo = (prefix, v) => (v == null ? null : prefix + createHash("sha256").update(String(v)).digest("hex").slice(0, 12));
const rows = ev.map((e) => [
  Number(e.id), e.source, e.machine, e.event, e.ts,
  e.uid ?? null, pseudo("dn-", e.dn), pseudo("enc-", e.enc), pseudo("rx-", e.rx),
  e.focus === "true" ? 1 : 0,
]);
writeFileSync(join(here, "events.json.gz"), gzipSync(Buffer.from(JSON.stringify(rows))));

const expected = {
  xwalk: Object.fromEntries(Object.entries(ref.xwalk).map(([m, r]) => [m, r ? { room_id: r.room_id, slug: slug(r.slug) } : null])),
  unpaired_refs_total: Object.values(ref.orphanR).reduce((a, b) => a + b, 0),
  consults: ref.consults.map((c) => ({
    machine: c.machine, room_id: c.room_id ?? null, slug: slug(c.slug ?? null), ist_date: c.ist_date,
    open_ms: c.open_ms, close_ms: c.close_ms, close_by: c.close_by, unclosed: c.unclosed, reopens: c.reopens,
    uid: c.uid, attrib: c.attrib, multi_doc: c.multi_doc, n_present_open: c.n_present_open,
  })),
};
writeFileSync(join(here, "expected.json"), JSON.stringify(expected));
console.log("events", rows.length, "consults", expected.consults.length, "unpaired_refs_total", expected.unpaired_refs_total);
