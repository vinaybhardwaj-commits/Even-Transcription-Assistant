/**
 * v1.9 — PubChem PUG REST + PUG-View helpers.
 *
 * Free, no auth, ~5 req/sec rate limit. All functions soft-fail: never throw,
 * return empty data on error (PubChem outage must NEVER block /drugs lookup).
 *
 * 24h in-memory LRU cache by URL — same drug looked up across multiple sessions
 * costs one fetch per day.
 *
 * Reference: https://pubchem.ncbi.nlm.nih.gov/docs/programmatic-access
 */

const PUG_BASE     = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const PUGVIEW_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 2000;

type CacheEntry = { value: unknown; expires: number };
const CACHE = new Map<string, CacheEntry>();

async function cachedFetch(url: string): Promise<unknown | null> {
  const hit = CACHE.get(url);
  if (hit && Date.now() < hit.expires) return hit.value;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      CACHE.set(url, { value: null, expires: Date.now() + TTL_MS }); // v1.9b: negative cache 24h (was 60s) — stops typo-spam against PubChem
      return null;
    }
    const data = await r.json();
    CACHE.set(url, { value: data, expires: Date.now() + TTL_MS });
    // crude LRU eviction
    if (CACHE.size > MAX_CACHE) {
      const k = CACHE.keys().next().value; if (k) CACHE.delete(k);
    }
    return data;
  } catch {
    CACHE.set(url, { value: null, expires: Date.now() + TTL_MS });
    return null;
  }
}

// ─── name → CID ────────────────────────────────────────────────────────────

export async function lookupByName(name: string): Promise<number | null> {
  const clean = (name || '').trim();
  if (!clean) return null;
  const url = `${PUG_BASE}/compound/name/${encodeURIComponent(clean)}/cids/JSON`;
  const data = await cachedFetch(url) as { IdentifierList?: { CID?: number[] } } | null;
  return data?.IdentifierList?.CID?.[0] ?? null;
}

// ─── synonyms (filtered) ───────────────────────────────────────────────────

export async function getSynonyms(cid: number, limit: number = 20): Promise<string[]> {
  const url = `${PUG_BASE}/compound/cid/${cid}/synonyms/JSON`;
  const data = await cachedFetch(url) as { InformationList?: { Information?: Array<{ Synonym?: string[] }> } } | null;
  const all = data?.InformationList?.Information?.[0]?.Synonym ?? [];
  // Filter out CAS numbers, chemical formulas, IUPAC strings — keep human-readable names
  const isHuman = (s: string) => {
    if (!s || s.length > 80) return false;
    if (/^\d+-\d+-\d+$/.test(s)) return false;                  // CAS numbers
    if (/^[A-Z][a-z]?\d/.test(s) && s.length > 30) return false; // chemical formulas
    if (/^\([0-9RSrs]+\)-/.test(s)) return false;               // stereoisomer prefixes
    if (s.includes('imidodicarbonimidic')) return false;        // IUPAC-style
    if (/^[A-Z]{2,}\d/.test(s)) return false;                   // research codes
    return true;
  };
  return all.filter(isHuman).slice(0, limit);
}

// ─── PUG-View by heading (for pharmacology / ATC / drug info) ──────────────

async function pugViewByHeading(cid: number, heading: string): Promise<unknown | null> {
  const url = `${PUGVIEW_BASE}/data/compound/${cid}/JSON?heading=${encodeURIComponent(heading)}`;
  return cachedFetch(url);
}

// Walk PUG-View tree collecting all 'String' leaf values
function collectStrings(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if (typeof o.String === 'string') out.push(o.String);
    for (const v of Object.values(o)) collectStrings(v, out);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
  }
}

// ─── MeSH Pharmacological Classification ──────────────────────────────────

export async function getMeshPharmacologicalActions(cid: number): Promise<string[]> {
  const data = await pugViewByHeading(cid, 'MeSH Pharmacological Classification');
  if (!data) return [];
  const all: string[] = [];
  collectStrings(data, all);
  // Filter for short, descriptive MeSH terms — typically named like "Hypoglycemic Agents"
  // The heading description text is ALSO returned, so we dedupe + filter for plausible MeSH terms.
  const unique = Array.from(new Set(all));
  return unique
    .filter((s) => s.length > 2 && s.length < 80)
    .filter((s) => !s.startsWith('This section') && !s.includes('classification was created'))
    .filter((s) => !/^(Compound|Substance|Record|Pharmacological)$/.test(s))
    .slice(0, 10);
}

// ─── ATC Code ──────────────────────────────────────────────────────────────

const ATC_RE = /^[A-Z]\d{2}[A-Z]{2}\d{2}$/;  // e.g. A10BA02

export async function getATCCodes(cid: number): Promise<string[]> {
  const data = await pugViewByHeading(cid, 'ATC Code');
  if (!data) return [];
  const all: string[] = [];
  collectStrings(data, all);
  return Array.from(new Set(all.filter((s) => ATC_RE.test(s.trim()))));
}

// ─── Drug indication (one-liner) ───────────────────────────────────────────

export async function getDrugIndication(cid: number): Promise<string | null> {
  const data = await pugViewByHeading(cid, 'Drug Indication');
  if (!data) return null;
  const all: string[] = [];
  collectStrings(data, all);
  // First long enough non-meta string
  const meaningful = all.find((s) => s.length > 30 && !s.startsWith('A drug indication') && !s.includes('this compound'));
  return meaningful ? meaningful.slice(0, 400) : null;
}

// ─── One-call combined enrichment ──────────────────────────────────────────

export type PubChemFacts = {
  cid: number | null;
  canonical_name: string | null;        // from synonyms[0] if available
  synonyms: string[];                   // human-readable, deduped, capped
  mesh_pharmacological_actions: string[];
  atc_codes: string[];
  indication: string | null;
  url: string | null;                   // pubchem.ncbi.nlm.nih.gov/compound/<cid>
  fetched_at: string;
};

export async function enrichDrug(name: string): Promise<PubChemFacts> {
  const cid = await lookupByName(name);
  if (cid === null) {
    return {
      cid: null, canonical_name: null, synonyms: [],
      mesh_pharmacological_actions: [], atc_codes: [],
      indication: null, url: null, fetched_at: new Date().toISOString(),
    };
  }
  const [synonyms, mesh, atc, indication] = await Promise.all([
    getSynonyms(cid),
    getMeshPharmacologicalActions(cid),
    getATCCodes(cid),
    getDrugIndication(cid),
  ]);
  // v1.9b: merge multi-mechanism secondary ATCs (PubChem returns only primary).
  // Lookup by both the input name AND the canonical name from synonyms so brand-name
  // inputs like 'Eliquis' also pick up apixaban's secondary codes.
  const secondaryAtc = Array.from(new Set([
    ...getSecondaryAtcCodes(name),
    ...getSecondaryAtcCodes(synonyms[0] || ''),
  ]));
  const mergedAtc = Array.from(new Set([...atc, ...secondaryAtc]));

  return {
    cid,
    canonical_name: synonyms[0] || name,
    synonyms,
    mesh_pharmacological_actions: mesh,
    atc_codes: mergedAtc,
    indication,
    url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
    fetched_at: new Date().toISOString(),
  };
}

// ─── Class-overlap detection for interactions ──────────────────────────────

/**
 * ATC hierarchy reminder:
 *   A          (anatomical group, e.g. "Cardiovascular")
 *   A10        (therapeutic subgroup, e.g. "Drugs used in diabetes")  ← ATC2 (first 3)
 *   A10B       (pharmacological subgroup, e.g. "Blood glucose lowering excl. insulins") ← ATC3 (first 4)
 *   A10BA      (chemical subgroup, e.g. "Biguanides")  ← ATC4 (first 5)
 *   A10BA02    (chemical substance, e.g. "metformin")  ← ATC5 (full)
 *
 * ATC3 is the right level for clinical class-overlap flagging:
 *   - Warfarin B01AA03 + Apixaban B01AF02 both share B01A (antithrombotics excl heparin) ✓
 *   - Lisinopril C09AA03 + Losartan C09CA01 differ at C09A vs C09C (ACE-I vs ARB) — separate classes, correct
 *   - Aspirin has codes in B01A (antiplatelet) + N02B (analgesic) — multi-class drug, both checked
 *
 * Friendly labels for the top ATC3 classes likely to come up clinically.
 */
const ATC3_LABEL: Record<string, string> = {
  'A10B': 'oral hypoglycemics',
  'B01A': 'antithrombotics (anticoagulants / antiplatelets)',
  'B03X': 'erythropoiesis stimulators',
  'C01A': 'cardiac glycosides',
  'C01B': 'antiarrhythmics',
  'C03A': 'thiazide diuretics', 'C03B': 'loop-type diuretics', 'C03C': 'high-ceiling loop diuretics',
  'C03D': 'potassium-sparing diuretics',
  'C07A': 'beta-blockers',
  'C08C': 'dihydropyridine calcium-channel blockers', 'C08D': 'non-DHP CCBs',
  'C09A': 'ACE inhibitors', 'C09C': 'angiotensin-II receptor blockers (ARBs)',
  'C09D': 'ARB combinations',
  'C10A': 'lipid-lowering agents (statins / fibrates)',
  'J01A': 'tetracyclines', 'J01C': 'beta-lactam penicillins', 'J01D': 'cephalosporins',
  'J01F': 'macrolides + lincosamides', 'J01M': 'fluoroquinolones',
  'M01A': 'NSAIDs',
  'N02A': 'opioids', 'N02B': 'non-opioid analgesics',
  'N03A': 'antiepileptics',
  'N05A': 'antipsychotics', 'N05B': 'anxiolytics', 'N05C': 'hypnotics/sedatives',
  'N06A': 'antidepressants',
  'R03A': 'inhaled beta-agonists', 'R03B': 'inhaled anticholinergics',
  'R03D': 'systemic asthma drugs (LTRA, theophylline)',
};

/** Label an ATC3 prefix using the friendly map; falls back to "ATC class X". */
export function atc3Label(prefix: string): string {
  return ATC3_LABEL[prefix] || `ATC class ${prefix}`;
}

/**
 * v1.9b: Multi-mechanism ATC fallback.
 *
 * PubChem returns ONE primary ATC code per CID. Some drugs are clinically used
 * across multiple mechanisms (e.g. aspirin = analgesic AND antiplatelet) but
 * PubChem only exposes the primary code. This map adds the secondary clinical
 * ATC codes so findClassOverlap catches cross-mechanism overlaps.
 *
 * Keyed by canonical lowercase drug name. Merged with PubChem's primary in enrichDrug.
 *
 * Source: WHOCC ATC/DDD index 2025. Expand as the team discovers gaps.
 */
const MULTI_MECHANISM_ATC: Record<string, string[]> = {
  // Antiplatelet/analgesic dual
  'aspirin':              ['B01AC06', 'N02BA01'],   // antiplatelet + analgesic — PubChem returns only N02BA01
  'acetylsalicylic acid': ['B01AC06', 'N02BA01'],

  // Beta-blockers with secondary mechanisms
  'propranolol':          ['C07AA05', 'N07XX'],     // beta-blocker + migraine prophylaxis
  'carvedilol':           ['C07AG02'],              // beta + alpha-blocker — already C07
  'labetalol':            ['C07AG01'],              // alpha-beta blocker

  // Antidepressants used for chronic pain
  'amitriptyline':        ['N06AA09', 'N03AX'],     // TCA antidepressant + neuropathic pain
  'duloxetine':           ['N06AX21', 'N03AX'],     // SNRI + neuropathic pain
  'gabapentin':           ['N03AX12'],              // antiepileptic + neuropathic pain — single ATC OK
  'pregabalin':           ['N03AX16'],

  // Anti-inflammatories with cardiac risk
  'colchicine':           ['M04AC01', 'C01EB16'],   // gout + pericarditis/CV inflammation

  // Antiarrhythmics with multiple mechanisms
  'amiodarone':           ['C01BD01'],              // Class III antiarrhythmic — PubChem gets this right
  'sotalol':              ['C07AA07', 'C01BD'],     // beta-blocker AND Class III antiarrhythmic — PubChem usually only C07
  'verapamil':            ['C08DA01', 'C07F'],      // non-DHP CCB + rate control

  // Anticholinergics + antiemetics
  'metoclopramide':       ['A03FA01', 'N05AX'],     // prokinetic + dopamine antagonist
  'promethazine':         ['R06AD02', 'N05AA10'],   // antihistamine + antiemetic + sedation

  // PPI + H2 — usually fine in PubChem but worth being defensive
  'omeprazole':           ['A02BC01'],
  'pantoprazole':         ['A02BC02'],
  'ranitidine':           ['A02BA02'],

  // Opioids — many have multi-mechanism pain pathways
  'tramadol':             ['N02AX02'],              // opioid + SNRI — class N02A captures DDI with antidepressants too
  'methadone':            ['N07BC02', 'N02AC52'],   // addiction + analgesic

  // Hormones / contraceptives — multi-use
  'spironolactone':       ['C03DA01'],              // diuretic AND aldosterone antagonist (heart failure)
  'eplerenone':           ['C03DA04'],

  // Antibiotics with secondary uses
  'doxycycline':          ['J01AA02', 'A01AB22'],   // tetracycline antibiotic + periodontal
  'erythromycin':         ['J01FA01', 'A03FA0'],    // macrolide antibiotic + prokinetic

  // Statins — usually fine
  'atorvastatin':         ['C10AA05'],
  'simvastatin':          ['C10AA01'],
  'rosuvastatin':         ['C10AA07'],

  // Antihypertensives + secondary indications
  'losartan':             ['C09CA01'],
  'lisinopril':           ['C09AA03'],
  'enalapril':            ['C09AA02'],

  // Anticonvulsants + mood stabilizer
  'valproic acid':        ['N03AG01', 'N05AN'],     // antiepileptic + bipolar
  'lamotrigine':          ['N03AX09', 'N05AN'],

  // Common India-specific brand normalisations (PubChem usually catches via synonyms but seed for class-overlap)
  'paracetamol':          ['N02BE01'],
  'acetaminophen':        ['N02BE01'],
  'ibuprofen':            ['M01AE01'],
  'diclofenac':           ['M01AB05'],
};

/** Look up secondary ATC codes for a drug name (case-insensitive). Returns [] if none known. */
export function getSecondaryAtcCodes(name: string): string[] {
  return MULTI_MECHANISM_ATC[name.toLowerCase().trim()] || [];
}

/**
 * ATC2 supergroups where clinical class-overlap is meaningful at the therapeutic-
 * subgroup level even when the ATC3 pharmacological subgroups differ.
 *
 * Example: lisinopril (C09AA03 ACE-I) + losartan (C09CA01 ARB) differ at ATC3
 * but share C09 (renin-angiotensin system agents) → cumulative hyperkalemia + AKI.
 * Example: warfarin (B01AA) + clopidogrel (B01AC) differ at ATC3 but share B01
 * → cumulative bleeding risk.
 */
const CLINICAL_ATC2: Record<string, string> = {
  'B01': 'antithrombotic stack (bleeding risk)',
  'C01': 'cardiac therapy (proarrhythmia / bradycardia)',
  'C07': 'beta-blocker stack (bradycardia / AV block)',
  'C09': 'renin-angiotensin blockers (hyperkalemia / AKI)',
  'C03': 'diuretic stack (volume + electrolyte derangement)',
  'C10': 'lipid-lowering stack (myopathy / hepatotoxicity)',
  'J01': 'systemic antibiotic stack (Cdiff / resistance)',
  'N02': 'analgesic stack (sedation / overdose)',
  'N05': 'CNS depressant stack (respiratory depression)',
  'N06': 'antidepressant stack (serotonin syndrome risk)',
  'M01': 'NSAID stack (GI bleed / nephrotoxicity)',
};

/** A pair of drugs share a clinical class if any of their ATC codes match at ATC3
 *  (pharmacological subgroup, e.g. B01A antithrombotics) OR at ATC2 for the curated
 *  set of clinically-meaningful supergroups (e.g. C09 RAAS blockers — ACE-I + ARB). */
export function findClassOverlap(a: PubChemFacts, b: PubChemFacts): {
  shared_atc3: string[];
  shared_atc2: string[];
  shared_labels: string[];
  any: boolean;
} {
  // ATC3 = first 4 chars (pharmacological subgroup) — high precision
  const atcA3 = new Set(a.atc_codes.map((s) => s.slice(0, 4)));
  const sharedAtc3 = Array.from(new Set(b.atc_codes.map((s) => s.slice(0, 4)).filter((p) => atcA3.has(p))));

  // ATC2 = first 3 chars (therapeutic subgroup) — only flag if curated supergroup
  const atcA2 = new Set(a.atc_codes.map((s) => s.slice(0, 3)));
  const sharedAtc2 = Array.from(new Set(b.atc_codes.map((s) => s.slice(0, 3))
    .filter((p) => atcA2.has(p) && CLINICAL_ATC2[p])));

  // Dedupe labels: prefer ATC3 specificity when both ATC3 and ATC2 fire on the same root
  const atc3Roots = new Set(sharedAtc3.map((s) => s.slice(0, 3)));
  const atc2Filtered = sharedAtc2.filter((p) => !atc3Roots.has(p));

  const labels = [
    ...sharedAtc3.map(atc3Label),
    ...atc2Filtered.map((p) => CLINICAL_ATC2[p]),
  ];

  return {
    shared_atc3: sharedAtc3,
    shared_atc2: atc2Filtered,
    shared_labels: labels,
    any: labels.length > 0,
  };
}
