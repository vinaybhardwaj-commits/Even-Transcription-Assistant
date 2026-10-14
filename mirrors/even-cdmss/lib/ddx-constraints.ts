// Deterministic demographic guard for the DDx engine.
// Belt-and-suspenders behind the prompt rules: even if the model slips, an
// anatomically/physiologically impossible diagnosis for the patient's stated sex
// is removed before it can reach the clinician. Sex must be clearly known; when
// sex is unknown/ambiguous, nothing is filtered. Age is handled in the prompt
// (prevalence weighting), not hard-filtered here.

export type DdxParsed = {
  summary?: string;
  missing_info?: string[];
  cannot_miss?: unknown[];
  most_likely?: unknown[];
  other?: unknown[];
};

type DdxItem = { diagnosis?: string };

// Female-only conditions — impossible in a male patient.
// NOTE: deliberately NOT matching bare "cervical" (that means neck — cervical
// spine / cervical lymphadenopathy) or "breast" (males get breast disease too).
const FEMALE_ONLY: RegExp[] = [
  /\bovar(y|ian|ies)\b/, /\btubo-?ovarian\b/, /\buter(us|ine)\b/, /\bendometri/,
  /\bcervix\b/, /\bcervical (cancer|carcinoma|dysplasia|intraepithelial)\b/, /\bcervicitis\b/,
  /\bectopic\b/, /\bpregnan/, /\b(pre)?eclampsia\b/, /\bplacenta/, /\bmiscarriage\b/, /\babortion\b/,
  /\bvagin/, /\bvulv/, /\bsalping/, /\bpelvic inflammatory\b/, /\bpid\b/,
  /\bmenstru/, /\bmenorrhagia\b/, /\bdysmenorrh/, /\bmittelschmerz\b/, /\buterine fibroid/,
];

// Male-only conditions — impossible in a female patient.
const MALE_ONLY: RegExp[] = [
  /\btestic(le|les|ular)\b/, /\btestis\b/, /\btestes\b/, /\bscrot/, /\bprostat/,
  /\bpenile\b/, /\bpenis\b/, /\bepididym/, /\bvaricocele\b/, /\bhydrocele\b/, /\bspermatic\b/,
  /\bbenign prostatic\b/, /\bbph\b/, /\bcryptorchid/, /\bbalanitis\b/, /\bphimosis\b/,
];

export function normSex(s?: string | null): 'male' | 'female' | null {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (!t) return null;
  if (/^(m\b|male|man|boy|♂)/.test(t) || t === 'm') return 'male';
  if (/^(f\b|female|woman|girl|♀)/.test(t) || t === 'f') return 'female';
  return null;
}

/**
 * Remove sex-impossible diagnoses from the parsed DDx. Returns the filtered
 * object (same shape) plus a list of "diagnosis [bucket]" strings that were
 * dropped, for audit logging.
 */
export function filterByDemographics(parsed: DdxParsed, sexRaw?: string | null): { filtered: DdxParsed; removed: string[] } {
  const sex = normSex(sexRaw);
  if (!sex) return { filtered: parsed, removed: [] };
  const banned = sex === 'male' ? FEMALE_ONLY : MALE_ONLY;
  const removed: string[] = [];

  const scrub = (arr: unknown, bucket: string): unknown[] => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((it) => {
      const name = String((it as DdxItem)?.diagnosis || '').toLowerCase();
      if (!name) return true;
      if (banned.some((rx) => rx.test(name))) {
        removed.push(`${(it as DdxItem).diagnosis || '?'} [${bucket}]`);
        return false;
      }
      return true;
    });
  };

  return {
    filtered: {
      ...parsed,
      cannot_miss: scrub(parsed.cannot_miss, 'cannot_miss'),
      most_likely: scrub(parsed.most_likely, 'most_likely'),
      other: scrub(parsed.other, 'other'),
    },
    removed,
  };
}

// ── Cross-axis listing guard ────────────────────────────────────────────────
// cannot_miss (ranked by danger) and most_likely (ranked by probability) are two
// INDEPENDENT axes, so a single diagnosis can legitimately score on both — e.g. a
// confirmed Wilson's disease is simultaneously the leading probability AND fatal if
// missed. The defect Dr Aravind reported (16 Jun) was not the dual-listing itself
// but that the two cards looked like two unrelated diagnoses (independently worded,
// different citation counts), blurring "this IS the diagnosis" vs "differentials
// still needing exclusion". Fix: deterministically DETECT a diagnosis that appears
// on both axes and flag BOTH entries so the UI can cross-link them as ONE diagnosis
// viewed on two axes — keeping both cards (product decision) while removing the
// accidental-duplicate look. Belt-and-suspenders behind the prompt, exactly like
// filterByDemographics: it fires whatever the LLM (Gemini or Ollama) emits.

type DdxItemFlagged = DdxItem & { also_cannot_miss?: boolean; also_most_likely?: boolean };

/** Normalise a diagnosis name for cross-axis identity matching. */
export function normDxName(name?: string | null): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')          // possessive: Wilson's → wilsons
    .replace(/[^a-z0-9]+/g, ' ')   // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect diagnoses listed on BOTH the cannot_miss and most_likely axes and flag
 * each occurrence (`also_cannot_miss` on the most_likely card, `also_most_likely`
 * on the cannot_miss card) so the client can render an explicit cross-reference
 * badge instead of two cards that read as separate diagnoses. Mutates the item
 * objects in place (they are the same references emitted to the client) and
 * returns the (unchanged-shape) object plus the list of cross-listed diagnosis
 * names for audit logging.
 */
export function crossLinkDdxBuckets(parsed: DdxParsed): { linked: DdxParsed; crossListed: string[] } {
  const cm = Array.isArray(parsed.cannot_miss) ? parsed.cannot_miss : [];
  const ml = Array.isArray(parsed.most_likely) ? parsed.most_likely : [];
  if (!cm.length || !ml.length) return { linked: parsed, crossListed: [] };

  const mlByName = new Map<string, DdxItemFlagged>();
  for (const it of ml) {
    const k = normDxName((it as DdxItem)?.diagnosis);
    if (k && !mlByName.has(k)) mlByName.set(k, it as DdxItemFlagged);
  }

  const crossListed: string[] = [];
  for (const it of cm) {
    const k = normDxName((it as DdxItem)?.diagnosis);
    if (!k) continue;
    const partner = mlByName.get(k);
    if (partner) {
      (it as DdxItemFlagged).also_most_likely = true;   // cannot_miss card: "also your leading dx"
      partner.also_cannot_miss = true;                  // most_likely card: "also a cannot-miss"
      crossListed.push((it as DdxItem).diagnosis || k);
    }
  }
  return { linked: parsed, crossListed };
}
