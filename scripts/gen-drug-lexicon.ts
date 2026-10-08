/**
 * scripts/gen-drug-lexicon.ts — S8A4: regenerate data/drug-lexicon.json from Pulse's medication catalog (Metabase db 13, table "individuals-prescriptions__medications").
 *
 *   METABASE_URL=... METABASE_API_KEY=... npx tsx scripts/gen-drug-lexicon.ts
 *
 * NAMES ONLY: it selects DISTINCT brand_name and generic_name (medications) and investigation__name (further_investigation), each only if used in >= 3 DISTINCT prescriptions (GROUP BY ... HAVING COUNT(DISTINCT <prescription id>) >= 3) and nothing else (no strength, no dose, no patient or prescription column), keeps letters / digits / space /
 * hyphen, and drops anything shorter than 4 letters. Metabase caps a result at about 2000 rows, so it pages with LIMIT / OFFSET over a stable ORDER BY. The output is
 * sorted and deduplicated case-insensitively, so a rerun on the same catalog is byte-identical. Run it where the Metabase env exists (Vercel env, or fable); commit only the JSON,
 * and READ the investigation list before committing it: it comes from a free-text field (the >= 3 distinct prescriptions rule and a length cap are the only filters).
 */
import { writeFileSync } from "node:fs";
import { metabaseQuery } from "../lib/metabase";

const MEDS = '"individuals-prescriptions__medications"';
const INVESTIGATIONS = '"individuals-prescriptions__further_investigation"';
const PAGE = 1800;
/** a name is kept only if it appears in at least this many DISTINCT prescriptions (one-off typos and free text fall out) */
const MIN_PRESCRIPTIONS = 3;
/**
 * The column that says WHICH prescription a row belongs to. Both tables are flattened Firestore sub-collections of a prescription document, so the parent document id is
 * the prescription: `_parent_doc_id` (confirmed for "individuals-prescriptions__further_investigation", whose columns include _parent_doc_id and investigation__name; the
 * medications table follows the same flattening convention but its columns were NOT inspected from here: check it once before trusting a rerun).
 */
const RX_COL = "_parent_doc_id";
/** free-text investigation rows can carry a patient's own words: nothing longer than this goes into a committed file (the longest name in the 09 Oct list is 87 characters) */
const MAX_NAME_LEN = 120;

async function names(table: string, col: "brand_name" | "generic_name" | "investigation__name"): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await metabaseQuery(
      `SELECT ${col} AS n FROM public.${table} WHERE ${col} IS NOT NULL GROUP BY ${col} HAVING COUNT(DISTINCT ${RX_COL}) >= ${MIN_PRESCRIPTIONS} ORDER BY ${col} LIMIT ${PAGE} OFFSET ${offset}`,
    );
    for (const r of rows) if (typeof r.n === "string") out.push(r.n);
    if (rows.length < PAGE) return out;
  }
}

const clean = (s: string): string => s.normalize("NFKC").replace(/[^A-Za-z0-9 -]/g, " ").replace(/\s+/g, " ").trim();

function uniq(all: string[]): string[] {
  const seen = new Map<string, string>();
  for (const n of all.map(clean).filter((x) => x.replace(/[^A-Za-z]/g, "").length >= 3 && x.length <= MAX_NAME_LEN)) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

async function main() {
  // drug / brand names (>= 4 letters) and investigation names (investigation__name of further_investigation, >= 3 letters: "IgE", "TSH"). Names only, nothing else is selected.
  const drugs = uniq([...(await names(MEDS, "brand_name")), ...(await names(MEDS, "generic_name"))]).filter((n) => n.replace(/[^A-Za-z]/g, "").length >= 4);
  const investigations = uniq(await names(INVESTIGATIONS, "investigation__name"));
  const doc = { version: new Date().toISOString().slice(0, 10), source: `pulse-medications (names used in >= ${MIN_PRESCRIPTIONS} prescriptions)`, names: drugs, investigations };
  writeFileSync("data/drug-lexicon.json", JSON.stringify(doc, null, 1) + "\n");
  console.log(`wrote data/drug-lexicon.json: ${drugs.length} drug names, ${investigations.length} investigation names (the curated clinical terms live in data/clinical-terms.json and are not touched)`);
}
main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
