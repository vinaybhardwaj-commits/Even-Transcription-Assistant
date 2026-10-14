export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// One-time / idempotent topic seeding for the literature engine. Same execution
// guard as the harvest cron (x-vercel-cron OR ?secret=CRON_SECRET) — this writes
// to the CAT-only ingest_topics control table. ON CONFLICT (topic) DO NOTHING, so
// re-running is harmless and only adds topics that don't already exist.
// Weighted toward primary care, general surgery and orthopaedics.
const TOPICS: [string, string][] = [
  // Primary care (34)
  ['Hypertension management', 'hypertension AND (management OR antihypertensive OR treatment)'],
  ['Type 2 diabetes management', '"type 2 diabetes" AND (management OR glycemic OR pharmacotherapy)'],
  ['Type 1 diabetes management', '"type 1 diabetes"'],
  ['Dyslipidemia & statin therapy', 'dyslipidemia OR hyperlipidemia OR statin'],
  ['Hypothyroidism', 'hypothyroidism OR levothyroxine'],
  ['Chronic kidney disease', '"chronic kidney disease"'],
  ['Asthma — chronic management', 'asthma AND (maintenance OR controller OR "long-term management")'],
  ['Stable COPD management', '"chronic obstructive pulmonary disease" AND (stable OR maintenance OR management)'],
  ['Major depressive disorder', '"major depressive disorder" OR depression'],
  ['Generalized anxiety disorder', '"generalized anxiety disorder" OR "anxiety disorder"'],
  ['Migraine & primary headache', 'migraine OR "tension-type headache"'],
  ['Gastroesophageal reflux disease', '"gastroesophageal reflux disease" OR GERD'],
  ['Irritable bowel syndrome', '"irritable bowel syndrome"'],
  ['Urinary tract infection', '"urinary tract infection" OR cystitis OR pyelonephritis'],
  ['Gout', 'gout OR "gouty arthritis"'],
  ['Osteoporosis', 'osteoporosis AND (management OR treatment OR "bone mineral density")'],
  ['Obesity management', 'obesity AND (management OR pharmacotherapy OR "weight loss")'],
  ['Smoking cessation', '"smoking cessation" OR "tobacco cessation"'],
  ['Iron deficiency anemia', '"iron deficiency anemia"'],
  ['Allergic rhinitis', '"allergic rhinitis"'],
  ['Acute otitis media', '"otitis media"'],
  ['Streptococcal pharyngitis', 'pharyngitis OR tonsillitis'],
  ['Acute rhinosinusitis', 'rhinosinusitis OR "acute sinusitis"'],
  ['Cellulitis & soft-tissue infection', 'cellulitis OR "skin and soft tissue infection"'],
  ['Benign prostatic hyperplasia', '"benign prostatic hyperplasia"'],
  ['Menopause & hormone therapy', 'menopause AND ("hormone therapy" OR management OR "hot flashes")'],
  ['Benign paroxysmal positional vertigo', '"benign paroxysmal positional vertigo" OR vertigo'],
  ['Chronic insomnia', 'insomnia AND (management OR treatment OR "cognitive behavioral")'],
  ['Vitamin D deficiency', '"vitamin D deficiency" OR "vitamin D supplementation"'],
  ['Heart failure with preserved EF', '"heart failure with preserved ejection fraction" OR HFpEF'],
  ['Adult immunization', '"adult immunization" OR "adult vaccination"'],
  ['Chronic constipation', '"chronic constipation"'],
  ['Prediabetes & metabolic syndrome', 'prediabetes OR "metabolic syndrome"'],
  ['Helicobacter pylori infection', '"Helicobacter pylori" AND (eradication OR treatment)'],
  // General surgery (22)
  ['Acute appendicitis', '"acute appendicitis"'],
  ['Acute cholecystitis & cholelithiasis', 'cholecystitis OR cholelithiasis OR "gallstone disease"'],
  ['Inguinal hernia repair', '"inguinal hernia"'],
  ['Ventral & incisional hernia', '"ventral hernia" OR "incisional hernia"'],
  ['Small bowel obstruction', '"small bowel obstruction" OR "intestinal obstruction"'],
  ['Acute diverticulitis', 'diverticulitis'],
  ['Perforated peptic ulcer', '"perforated peptic ulcer" OR "peptic ulcer perforation"'],
  ['Surgical site infection', '"surgical site infection"'],
  ['Breast lump evaluation', '"breast mass" OR "breast lump"'],
  ['Colorectal cancer screening', '"colorectal cancer screening" OR colonoscopy'],
  ['Acute abdomen evaluation', '"acute abdomen"'],
  ['Perianal abscess & anal fistula', '"perianal abscess" OR "anal fistula"'],
  ['Pilonidal disease', '"pilonidal sinus" OR "pilonidal disease"'],
  ['Hemorrhoidal disease', 'hemorrhoids OR hemorrhoidectomy'],
  ['Acute mesenteric ischemia', '"mesenteric ischemia"'],
  ['Thyroid nodule & thyroidectomy', '"thyroid nodule" OR thyroidectomy'],
  ['Varicose veins & venous insufficiency', '"varicose veins" OR "chronic venous insufficiency"'],
  ['Postoperative ileus', '"postoperative ileus"'],
  ['Enhanced recovery after surgery', '"enhanced recovery after surgery" OR ERAS'],
  ['Necrotizing soft-tissue infection', '"necrotizing fasciitis" OR "necrotizing soft tissue infection"'],
  ['Acute abdominal trauma', '"abdominal trauma" OR "blunt abdominal trauma"'],
  ['Gastrointestinal cancer surgery', '"gastric cancer" OR "colorectal cancer"'],
  // Orthopaedics (22)
  ['Hip fracture', '"hip fracture" OR "femoral neck fracture"'],
  ['Distal radius (Colles) fracture', '"distal radius fracture" OR "Colles fracture"'],
  ['Ankle fracture & sprain', '"ankle fracture" OR "ankle sprain"'],
  ['ACL injury & reconstruction', '"anterior cruciate ligament"'],
  ['Meniscal tear', '"meniscal tear" OR meniscus'],
  ['Rotator cuff disease', '"rotator cuff"'],
  ['Adhesive capsulitis (frozen shoulder)', '"adhesive capsulitis" OR "frozen shoulder"'],
  ['Carpal tunnel syndrome', '"carpal tunnel syndrome"'],
  ['Lumbar disc herniation & sciatica', '"lumbar disc herniation" OR sciatica OR "lumbar radiculopathy"'],
  ['Cervical radiculopathy & spondylosis', '"cervical radiculopathy" OR "cervical spondylosis"'],
  ['Knee osteoarthritis', '"knee osteoarthritis"'],
  ['Hip osteoarthritis', '"hip osteoarthritis"'],
  ['Septic arthritis', '"septic arthritis"'],
  ['Osteomyelitis', 'osteomyelitis'],
  ['Acute compartment syndrome', '"compartment syndrome"'],
  ['Total knee arthroplasty', '"total knee arthroplasty" OR "total knee replacement"'],
  ['Total hip arthroplasty', '"total hip arthroplasty" OR "total hip replacement"'],
  ['Plantar fasciitis', '"plantar fasciitis"'],
  ['Lateral epicondylitis (tennis elbow)', '"lateral epicondylitis" OR "tennis elbow"'],
  ['Shoulder dislocation & instability', '"shoulder dislocation" OR "shoulder instability"'],
  ['Scaphoid fracture', '"scaphoid fracture"'],
  ['Low back pain', '"low back pain" AND (management OR treatment)'],
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
