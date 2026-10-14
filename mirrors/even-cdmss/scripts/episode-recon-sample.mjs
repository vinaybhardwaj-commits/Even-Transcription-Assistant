// scripts/episode-recon-sample.mjs — EpisodeState (#4) SL5a: populate the reconstruction-fidelity
// bench SAMPLE. Stratified by speciality; the OPD-linked / IPD-only split falls out of the cohort
// (~50/50). For each sampled admission it runs the SHIPPED episode path — extract → persist via the
// SL4 persistEpisodeState wiring (toKxEnvelope + resolveOpdLinkage + buildEpisodeState +
// saveEpisodeState) — producing a v0.2 episode_states row. It deliberately SKIPS the analyze/score
// pass: the episode is extract-derived and the bench measures the BUILDER, not the audit.
//
// This is bench SETUP, not the prod pass. Nothing is scored; the episode rows are the same v0.2
// objects a forward audit would write. De-identified — the manifest carries link-back keys +
// counts only. Credentialed, never CI.
//
//   node --env-file=.env.local --import tsx scripts/episode-recon-sample.mjs [--n 24] [--width 4]

import { writeFileSync } from 'fs';
import { sql } from '../lib/db.ts';
import { extractCase } from '../lib/doc-audit.ts';
import { fetchIpdDoc, fetchIpdAdmissionHeader } from '../lib/ipd-audit/db13.ts';
import { fetchBillingEnvelope } from '../lib/ipd-audit/billing.ts';
import { persistEpisodeState } from '../lib/ipd-audit/episode-adapter.ts';
import { getVertexAccessToken } from '../lib/gcp-auth.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const N = Math.max(6, Number(argOf('--n') ?? 24) | 0);
const WIDTH = Math.max(1, Number(argOf('--width') ?? 4) | 0);
const OUT = argOf('--out') ?? 'episode-recon-sample.json';
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// STRATIFIED per-speciality quotas (deterministic: oldest-first within each speciality), summing to
// ~N across the 13 specialities so the bench spans the cohort rather than the General-Surgery mode.
const QUOTA = { 'General Surgery': 5, 'Orthopedics': 4, 'Internal Medicine': 3, 'Urology': 2,
  'Plastic Surgery': 2, 'Emergency Medicine': 2, 'Obstetrics and gynecology': 2, 'Pediatrics': 1,
  'Cardiology': 1, 'Ear Nose and Throat': 1, 'Oncology': 1 };

async function fetchPdf(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 3000);
    try {
      const plain = await fetch(url).catch(() => null);
      if (plain?.ok) return Buffer.from(await plain.arrayBuffer());
      const token = await getVertexAccessToken();
      const authed = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!authed.ok) throw new Error(`GCS ${authed.status}`);
      return Buffer.from(await authed.arrayBuffer());
    } catch (e) { last = e; }
  }
  throw last;
}

async function pool(items, width, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── select the stratified sample ──
const picks = [];
for (const [spec, q] of Object.entries(QUOTA)) {
  const rows = await sql(
    `SELECT document_id, ip_uid, member_id, speciality FROM ipd_discharge_audits
     WHERE engine_version='ipd-discharge-audit/0.1' AND ip_uid IS NOT NULL AND speciality=$1
     ORDER BY audited_at ASC LIMIT $2`, [spec, q]);
  picks.push(...rows);
}
log(`[sample] selected ${picks.length} admissions across ${new Set(picks.map((p) => p.speciality)).size} specialities (target ${N})`);

// ── build + persist a v0.2 episode for each ──
let done = 0, ok = 0, linked = 0;
const results = await pool(picks, WIDTH, async (p) => {
  const doc = await fetchIpdDoc(p.document_id).catch(() => null);
  if (!doc?.pdfUrl) { done++; log(`[sample] ${done}/${picks.length} ${p.ip_uid} skip (no pdf)`); return { ...p, status: 'no-pdf' }; }
  let extracted = null, attempts = 0;
  for (; attempts < 3 && !extracted; attempts++) {
    if (attempts) await sleep(attempts * 4000);
    try {
      const buf = await fetchPdf(doc.pdfUrl);
      const r = await extractCase({ base64: buf.toString('base64'), mime: 'application/pdf', docTypeHint: 'discharge_summary', bytes: buf.length });
      extracted = r.extracted;
    } catch { /* retry */ }
  }
  if (!extracted) { done++; log(`[sample] ${done}/${picks.length} ${p.ip_uid} UNREADABLE`); return { ...p, status: 'unreadable' }; }
  const [header, billing] = await Promise.all([
    doc.ipUid ? fetchIpdAdmissionHeader(doc.ipUid).catch(() => null) : null,
    doc.ipUid ? fetchBillingEnvelope(doc.ipUid).catch(() => null) : null,
  ]);
  const ep = await persistEpisodeState(doc.documentId, extracted, header, billing);
  done++; ok++;
  if (ep?.opdLinked) linked++;
  log(`[sample] ${done}/${picks.length} ${p.ip_uid} ${p.speciality} · ${ep?.status} · opd ${ep?.opdLinked ? `linked(${ep.opdEncounters})` : 'none'}`);
  return { document_id: p.document_id, ip_uid: p.ip_uid, speciality: p.speciality, status: ep?.status ?? 'persisted', opdLinked: !!ep?.opdLinked, opdEncounters: ep?.opdEncounters ?? 0 };
});

const manifest = {
  version: 'episode-recon-sample/1', builtWith: 'episode-state/0.2',
  n: results.length, persisted: ok, linked, unlinked: ok - linked,
  bySpeciality: Object.fromEntries(Object.keys(QUOTA).map((s) => [s, results.filter((r) => r.speciality === s && r.status !== 'unreadable' && r.status !== 'no-pdf').length])),
  cases: results,
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2));
log(`\n[sample] persisted ${ok}/${picks.length} v0.2 episodes · linked ${linked} · unlinked ${ok - linked} → ${OUT}`);
process.exit(0);
