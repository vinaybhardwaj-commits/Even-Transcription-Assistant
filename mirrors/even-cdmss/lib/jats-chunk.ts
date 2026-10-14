// Section-aware chunker for JATS full-text XML (Europe PMC / PMC OA articles).
//
// Zero-dependency regex parser (the codebase forbids new npm deps). Goal: emit
// clean, retrieval-sized chunks of the SUBSTANTIVE prose (introduction / results /
// discussion / conclusions) and DROP the non-content matter — references, methods
// boilerplate, funding, acknowledgements, competing interests, tables, figures,
// formulas — that polluted the Jun-2026 bulk load (open issue L-7: mid-sentence
// fragments + stats tables + funding lines stored as standalone chunks). Each
// chunk carries its section heading and is token-capped for the nomic-768 embedder.

export type FullTextChunk = { section: string; text: string; tokens: number };

const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));

// Section headings (matched against <title> text) whose content we DROP.
const SKIP_HEADING =
  /\b(references?|bibliography|literature cited|methods?|materials? and methods?|patients? and methods?|study design|statistical analysis|data collection|sample size|randomi[sz]ation|eligibility|funding|financial (support|disclosure)|grant support|acknowledge?ments?|competing interests?|conflicts? of interest|declaration of interest|disclosures?|authors?.{0,3}contributions?|data availability|availability of data|supplementary|supporting information|abbreviations?|ethics?( statement| approval)?|consent)\b/i;

// JATS <sec sec-type="..."> values whose content we DROP.
const SKIP_SECTYPE =
  /^(methods|materials|materials\|methods|supplementary-material|supplementary|coi-statement|funding-information|funding|ethics|data-availability|abbreviations|appendix|ack|supporting-information)$/i;

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, e: string) => {
    const k = e.toLowerCase();
    const map: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      mdash: '—', ndash: '–', deg: '°', micro: 'µ',
      plusmn: '±', times: '×', le: '≤', ge: '≥', alpha: 'α', beta: 'β',
    };
    if (map[k]) return map[k];
    if (e[0] === '#') {
      const n = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    }
    return ' ';
  });
}

/** Strip inline markup + drop inline cross-references (citation numbers, "Fig. 2",
 *  "Table 1") and formulas so they don't fragment or pollute the prose. */
function cleanText(s: string): string {
  s = s.replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/gi, '');
  s = s.replace(/<inline-formula\b[\s\S]*?<\/inline-formula>/gi, ' ');
  s = s.replace(/<(?:tex-math|mml:math)\b[\s\S]*?<\/(?:tex-math|mml:math)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');         // remaining inline tags
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Chunk a JATS full-text XML string into clean, section-tagged, token-capped
 * prose chunks. Returns [] when there is no usable <body> (caller should then
 * fall back to the abstract).
 */
export function chunkJatsFullText(
  xml: string,
  opts: { maxTokens?: number; minTokens?: number; maxChunks?: number } = {},
): FullTextChunk[] {
  const maxTokens = opts.maxTokens ?? 350;
  const minTokens = opts.minTokens ?? 40;
  const maxChunks = opts.maxChunks ?? 25;

  // <body> only — excludes <front> (metadata) and <back> (references/funding/ack).
  const bodyM = xml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyM) return [];
  let body = bodyM[1];

  // Remove block non-prose wholesale (tables, figures, formulas, supplements, boxes).
  body = body
    .replace(/<table-wrap\b[\s\S]*?<\/table-wrap>/gi, ' ')
    .replace(/<fig\b[\s\S]*?<\/fig>/gi, ' ')
    .replace(/<table\b[\s\S]*?<\/table>/gi, ' ')
    .replace(/<disp-formula\b[\s\S]*?<\/disp-formula>/gi, ' ')
    .replace(/<supplementary-material\b[\s\S]*?<\/supplementary-material>/gi, ' ')
    .replace(/<boxed-text\b[\s\S]*?<\/boxed-text>/gi, ' ');

  // Walk the body in document order: <sec> (sec-type), <title> (heading), <p> (prose).
  const tokenRe = /<sec\b([^>]*)>|<title\b[^>]*>([\s\S]*?)<\/title>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let heading = 'Body';
  let skip = false;
  const groups: { heading: string; paras: string[] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    if (m[1] !== undefined) {
      const stM = m[1].match(/sec-type="([^"]+)"/i);
      if (stM && SKIP_SECTYPE.test(stM[1].trim())) skip = true;
    } else if (m[2] !== undefined) {
      heading = cleanText(m[2]) || 'Body';
      skip = SKIP_HEADING.test(heading);
    } else if (m[3] !== undefined) {
      if (skip) continue;
      const text = cleanText(m[3]);
      if (text.length < 40) continue; // drop fragments early
      const g = groups[groups.length - 1];
      if (g && g.heading === heading) g.paras.push(text);
      else groups.push({ heading, paras: [text] });
    }
  }

  // Token-cap chunks within each section group (paragraph-boundary splits).
  const chunks: FullTextChunk[] = [];
  for (const g of groups) {
    if (chunks.length >= maxChunks) break;
    let buf: string[] = [];
    let bufTok = 0;
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join(' ');
      const tokens = approxTokens(text);
      if (tokens >= minTokens) chunks.push({ section: g.heading.slice(0, 120), text, tokens });
      buf = [];
      bufTok = 0;
    };
    for (const p of g.paras) {
      const pt = approxTokens(p);
      if (bufTok + pt > maxTokens && buf.length) flush();
      buf.push(p);
      bufTok += pt;
      if (chunks.length >= maxChunks) break;
    }
    flush();
  }
  return chunks.slice(0, maxChunks);
}
