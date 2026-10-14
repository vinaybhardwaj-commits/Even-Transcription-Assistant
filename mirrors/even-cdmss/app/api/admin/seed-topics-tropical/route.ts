export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// Tropical / infectious-disease / India-relevant topic seeding for the literature
// engine. Same guard as the harvest cron (x-vercel-cron OR ?secret=CRON_SECRET);
// writes to the CAT-only ingest_topics table. ON CONFLICT (topic) DO NOTHING, so
// re-running is harmless. These domains are heavily OPEN ACCESS (PLoS NTD, BMC,
// MDPI, IJID…), so they yield the most Europe PMC full text — and they close the
// "India / local sources" gap (open issue L-6): kala-azar, dengue, malaria,
// typhoid, TB, scrub typhus, snakebite, rabies, JE, filariasis, leptospirosis, AMR.
const TOPICS: [string, string][] = [
  ['Leishmaniasis (cutaneous & visceral)', 'leishmaniasis OR kala-azar OR "post-kala-azar dermal leishmaniasis"'],
  ['Dengue & severe dengue', 'dengue OR "dengue hemorrhagic fever" OR "severe dengue"'],
  ['Malaria diagnosis & treatment', 'malaria AND (treatment OR management OR artemisinin OR diagnosis)'],
  ['Enteric fever (typhoid)', '"typhoid fever" OR "enteric fever" OR "Salmonella Typhi"'],
  ['Tuberculosis (pulmonary & extrapulmonary)', 'tuberculosis AND (treatment OR management OR diagnosis OR "drug-resistant")'],
  ['Leptospirosis', 'leptospirosis'],
  ['Scrub typhus & rickettsial fevers', '"scrub typhus" OR rickettsial OR "Orientia tsutsugamushi"'],
  ['Chikungunya', 'chikungunya'],
  ['Snakebite envenomation', 'snakebite OR "snake envenomation" OR antivenom'],
  ['Rabies post-exposure prophylaxis', 'rabies AND (prophylaxis OR "post-exposure" OR vaccine)'],
  ['Amoebiasis & amoebic liver abscess', 'amoebiasis OR "amebic liver abscess" OR "Entamoeba histolytica"'],
  ['Lymphatic filariasis', '"lymphatic filariasis" OR filariasis'],
  ['Acute encephalitis & Japanese encephalitis', '"Japanese encephalitis" OR "acute encephalitis syndrome"'],
  ['Brucellosis', 'brucellosis'],
  ['Antimicrobial resistance & stewardship', '"antimicrobial resistance" OR "antibiotic stewardship"'],
  ['HIV/AIDS management', 'HIV AND (antiretroviral OR management OR "opportunistic infection")'],
];

export async function GET(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const secret = req.nextUrl.searchParams.get('secret');
  const ok = isCron || (process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const before = (await sql`SELECT count(*)::int AS n FROM ingest_topics`) as Array<{ n: number }>;
    for (const [topic, terms] of TOPICS) {
      await sql`INSERT INTO ingest_topics (topic, query_terms) VALUES (${topic}, ${terms}) ON CONFLICT (topic) DO NOTHING`;
    }
    const after = (await sql`SELECT count(*)::int AS n FROM ingest_topics`) as Array<{ n: number }>;
    return NextResponse.json({
      ok: true,
      proposed: TOPICS.length,
      topics_before: before[0]?.n ?? 0,
      topics_after: after[0]?.n ?? 0,
      added: (after[0]?.n ?? 0) - (before[0]?.n ?? 0),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
