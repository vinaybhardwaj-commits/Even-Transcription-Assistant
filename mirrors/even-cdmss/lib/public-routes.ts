/**
 * Routes that intentionally answer without an authenticated principal.
 *
 * Everything that reads or writes audit rows, a patient chart, or a doctor record
 * is outside this list and must check a principal (cookie or a scoped token).
 * Host is not a principal. The presence of `x-vercel-cron` is not a principal.
 *
 * Prefix entries match the path and its children (`/calculators` covers
 * `/calculators/news2`). `/` is exact, so it does not open the rest of the app.
 */
export interface PublicRoute {
  path: string;
  reason: string;
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: '/', reason: 'CAT home. Shows a corpus size and an aggregate audit count, not a patient, doctor, or audit row.' },
  { path: '/audit/login', reason: 'Pharmacist login form. It sets the med_audit cookie only after PHARMACIST_TOKEN matches.' },
  { path: '/api/audit/login', reason: 'Pharmacist login endpoint. Fail closed when PHARMACIST_TOKEN is unset. Returns no audit row.' },
  { path: '/care/login', reason: 'Care-manager login form.' },
  { path: '/api/care/login', reason: 'Care-manager login endpoint. Fail closed when CARE_TOKEN is unset. Returns no member record.' },
  { path: '/api/admin/unlock', reason: 'Admin unlock and logout. Sets cat_admin only after ADMIN_TOKEN matches; logout clears it. No clinical payload.' },
  { path: '/calculators', reason: 'Bedside score calculators. The input is the form, not a stored chart.' },
  { path: '/api/calculators', reason: 'Calculator math over the request body. No patient, doctor, or audit read.' },
  { path: '/drugs', reason: 'Formulary reference pages.' },
  { path: '/api/drugs', reason: 'Drug lookup and interaction reference shared with the pharmacist tool. No patient chart.' },
  { path: '/knowledge', reason: 'Evidence-corpus browser.' },
  { path: '/search', reason: 'Corpus search page.' },
  { path: '/api/search', reason: 'Corpus search. Returns passages, not charts.' },
  { path: '/topics', reason: 'Topic guides from the corpus.' },
  { path: '/learn', reason: 'Teaching tools over the corpus.' },
  { path: '/browse', reason: 'Corpus browse.' },
  { path: '/practice', reason: 'Practice questions from the corpus.' },
  { path: '/coach', reason: 'Coaching over the corpus.' },
  { path: '/api/coach', reason: 'Coaching session endpoints. The transcript is the caller\'s own session, not a chart read.' },
  { path: '/ask', reason: 'Cited Q&A over the evidence corpus. Not a patient chart.' },
  { path: '/api/ask', reason: 'Ask API. Answers from the corpus for the submitted question.' },
  { path: '/ddx', reason: 'Differential from a pasted presentation. Not a stored chart.' },
  { path: '/api/ddx', reason: 'Differential API over the submitted presentation.' },
  { path: '/review', reason: 'Flashcard review of the corpus.' },
  { path: '/api/flashcards', reason: 'Flashcard queue for the corpus review tool.' },
  { path: '/appropriateness', reason: 'Right-care check of text the clinician submits. Saved runs are read from the admin surface, which is gated.' },
  { path: '/api/appropriateness', reason: 'Right-care check of the submitted text. The admin run browser is a separate gated route.' },
  { path: '/concordance', reason: 'Concordance check of a result the clinician submits. The admin concordance board is gated.' },
  { path: '/api/concordance', reason: 'Concordance API over the submitted result. Does not list stored patients.' },
  { path: '/api/log/query', reason: 'Telemetry ingest for the clinical tools. Writes the caller\'s own query text and does not read a patient, doctor, or audit row.' },
  { path: '/api/practice', reason: 'Practice-question API over the corpus.' },
  { path: '/api/digest', reason: 'Literature digest generation over the corpus, not a chart.' },
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => {
    if (route.path === '/') return pathname === '/';
    return pathname === route.path || pathname.startsWith(`${route.path}/`);
  });
}
