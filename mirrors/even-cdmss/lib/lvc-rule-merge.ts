/**
 * lib/lvc-rule-merge.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.1–§3.4 (Phase 1), 25 Aug 2026.
 *
 * THE MERGE MECHANISM, AND THE 19 DRAFT RECORDS THE RATIFICATION SURFACE LOADS.
 *
 * WHAT THIS IS. 67 house rules mined from CDMSS's own audit output express 19 clinical concepts at
 * 3.5 duplicates per concept. "Complete Blood Profile" and "Complete Blood Profile testing" are two
 * separate rules splitting 562 findings over one word. This module expresses ONE canonical rule per
 * concept: a survivor that receives merged wording, a precondition, phrase keywords and a category,
 * and a set of absorbed variants that retire pointing at it through `merged_into`.
 *
 * ⚠️ NOTHING HERE IS RATIFIED. Every statement, precondition, keyword phrase and category below is a
 * DRAFT written by the orchestrator (D-6). They are READ-ONLY INPUT to /admin/lvc-ratify, where V
 * edits or accepts each one on screen. Under D-18 THE ACCEPT IS THE WRITE — there is no data
 * migration for rule content, and merely deploying this file changes nothing in the rulebook.
 *
 * THE TWO EXCEPTIONS, and they are load-bearing: R3 (safety-netting) and R5 (antibiotic for acute
 * upper-respiratory illness) carry preconditions V RATIFIED ON 10 AUGUST 2026. Those two texts are
 * not redrafted here — they are IMPORTED from lib/lvc-ratified-wording.ts, so they are byte-exact
 * with the ratified record by construction and cannot drift. PRD §3.3 says "reproduced verbatim;
 * not rewritten here", and an import is the only way to mean that literally.
 *
 * SHAPE. Mirrors lib/lvc-ratified-wording.ts exactly: typed records, exported SQL constants, a
 * readback-first runner, dry-run support, and idempotence through IS DISTINCT FROM guards. It is
 * the same discipline because the same thing can go wrong — a half-applied write to clinical rules
 * a doctor is judged against.
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED (no live DB writes from the builder's sandbox) and is
 * reproduced verbatim in the build report for orchestrator validation BEFORE any accept is pressed.
 * The COLUMN NAMES were confirmed read-only against the live schema; the STATEMENTS were not run.
 *
 * FAIL-SAFE AND IDEMPOTENT, by construction:
 *   · a READBACK runs FIRST over survivors AND absorbed ids — a schema/connectivity fault therefore
 *     aborts before any write (PRD §6.2);
 *   · every UPDATE carries an IS DISTINCT FROM guard on the content columns, so a second accept
 *     reports `changed: 0` (PRD §6.8);
 *   · `ratified_at` / `updated_at` are DELIBERATELY OUTSIDE the guard predicate — they are now() at
 *     the moment of the accept, so including them would make every re-run "changed" and destroy the
 *     idempotence claim the whole design rests on;
 *   · statements are independent and individually idempotent, so an error part-way leaves a
 *     consistent table and pressing accept again completes the job (PRD §6.10).
 * There is NO transaction: lib/db speaks the Neon HTTP protocol, one statement per round trip.
 */

import { LVC_CATEGORIES } from './opd-lvc-classify-core';
import { RATIFIED_PRECONDITIONS } from './lvc-ratified-wording';
import { DEFAULT_AUTHOR } from './lvc-proposal-core';

// ── the two ratified texts, imported rather than retyped (PRD §3.3, R3 / R5) ───────────────────
/** §3.2 of the 10 Aug pinning PRD — the merged safety-netting precondition. */
const RATIFIED_SAFETY_NETTING = RATIFIED_PRECONDITIONS.find((p) => p.section === '3.2')!;
/** §3.1 of the 10 Aug pinning PRD — antibiotic for acute upper-respiratory illness. */
const RATIFIED_ANTIBIOTIC_URI = RATIFIED_PRECONDITIONS.find((p) => p.section === '3.1')!;

/**
 * A single clinical concept: one surviving rule and the variants it absorbs.
 * `absorbs` NEVER contains `id`, and no id appears in two records (asserted in the test).
 */
export interface MergedRule {
  /** the PRD section this record is copied from — 'R1' … 'R19' */
  section: string;
  /** the surviving lvc_recommendations.id */
  id: string;
  statement: string;
  precondition: string;
  /** phrase keywords — never single stopword-grade tokens (§6.3) */
  keywords: string[];
  /** one of LVC_CATEGORIES */
  category: string;
  /** Even Clinical Protocols section + line, or null when none covers it (D-11) */
  citation_url: string | null;
  /** ids retired into this rule */
  absorbs: string[];
}

/**
 * A record set is what the surface loads (D-21). Phase 2 (the 13 ELV rules) and Phase 3 (batches of
 * 15 harvested candidates) supply a DIFFERENT record set to the SAME screen. The page is driven by
 * this shape and knows nothing about merging beyond `absorbs` being possibly empty.
 */
export interface RuleRecordSet {
  key: string;
  title: string;
  blurb: string;
  records: MergedRule[];
}

/**
 * ⚠️ A SINGLE-TOKEN KEYWORD IS HOW THE CURRENT RULEBOOK BROKE (D-15). Live keywords are stored
 * word-shattered: `Avoid: Complete Blood Profile testing` carries {complete, blood, profile,
 * testing} as four independent single-word triggers, so the rule fires on the bare word "blood".
 * The matcher treats each keyword as an ALTERNATIVE trigger, so one stray single token makes a rule
 * a catch-all. The guard below refuses the whole record set before any write.
 *
 * The allowlist is for MOLECULE NAMES, which are single tokens but are not stopwords — a note
 * containing "serratiopeptidase" is unambiguously about serratiopeptidase.
 *
 * ⚠️ FLAGGED DEVIATION — `cholecalciferol` IS ON THIS LIST AND THE KICKOFF SAID "initially
 * ['serratiopeptidase']". The kickoff and PRD §6.3 pin the starting contents to one entry; PRD §3.4
 * simultaneously ships `cholecalciferol` as one of R4's four keyword phrases. Both cannot hold. It
 * is resolved in favour of §3.4's clinical content, because cholecalciferol is a molecule name by
 * exactly the test §3.4 applies to serratiopeptidase ("a molecule name, not a stopword"), and
 * because the alternative — silently dropping it — would leave V unable to re-enter it at the
 * sitting without a code change. Reverting is a one-line edit here plus removing the keyword from
 * R4. Raised in the build report; V's call.
 */
export const MOLECULE_ALLOWLIST: readonly string[] = ['serratiopeptidase', 'cholecalciferol'];

/** Who a ratification may never be attributed to — re-exported from the ONE lvc_ratify convention,
 *  never redeclared, so the surface and the MCP refuse exactly the same string. */
export { DEFAULT_AUTHOR };

// ── §3.2 / §3.3 / §3.4 — THE 19 DRAFT RECORDS ──────────────────────────────────────────────────
//
// ⚠️ SURVIVOR IDS. PRD §3.2 prints ids in an 8-hex-character SHORT FORM (`ehrc-19d73d33`). The real
// lvc_recommendations.id is a full UUID (`ehrc-19d73d33-266b-4b8a-86a5-c35075c0556c`). Each short
// form was resolved read-only against the live rulebook and each resolves to EXACTLY ONE row; the
// resolution was then cross-checked against the PRD's own "Fires" column, which agrees on all 19.
//
// ⚠️ ABSORBED IDS ARE DERIVED, NOT QUOTED. PRD §3.2 gives absorbed COUNTS, never ids. The 48
// non-survivor house rules were partitioned by clinical concept and the partition is pinned by two
// independent constraints that both hold exactly:
//   · the per-rule counts reproduce the PRD's column for all 19 records (with the one correction
//     noted at R5), and they sum to the PRD's own stated total of 48 absorbed / 67 accounted;
//   · D-14 holds on every cluster — the survivor named by the PRD is the highest-firing member of
//     the cluster derived here, with the single documented exception at R3 (safety-netting), which
//     is precisely the one cluster D-14 says the exception applies to.
// The surface shows every absorbed variant's verbatim statement, id and lifetime finding count on
// the rule's own screen, so this partition is reviewed by a human before any accept (§3.5).
export const MERGE_RULES: MergedRule[] = [
  {
    section: 'R1',
    id: 'ehrc-19d73d33-266b-4b8a-86a5-c35075c0556c',
    statement: 'Limit: A diagnosis is recorded without a corresponding diagnosis code.',
    precondition: 'Applies when the note records a diagnosis in words and no diagnosis code is recorded against it. Does not apply when a code is present in any form, including a partial or unspecified code, or when the note records no diagnosis at all.',
    keywords: ['diagnosis code', 'diagnosis without code', 'undocumented diagnosis', 'diagnosis not coded'],
    category: 'other',
    citation_url: null,
    absorbs: [
      'ehrc-00d4fe18-8c9c-4cde-ad1e-4cd2cb02991b',   // Limit: Diagnosis without coding
      'ehrc-1f74a581-36e0-40e7-979b-ec52f3efe085',   // Limit: Diagnosis documented without coding
      'ehrc-289a3bb4-fd7a-4363-b291-cc44be7b9014',   // Limit: Inaccurate or undocumented diagnosis
      'ehrc-32358076-cfbf-414c-910f-d682b5a12c05',   // Limit: Incomplete diagnosis documentation
      'ehrc-5a43d02f-fabc-48b1-afbb-6e854b71ce39',   // Limit: Diagnosis without specific etiology
      'ehrc-8b62e973-e278-41f5-ba08-4b8d84e2496f',   // Limit: Diagnosis lacking specific code
      'ehrc-cdfcf3bc-b737-4058-91af-600b5ca414fd',   // Limit: Undocumented diagnosis code (already retired, 0034 D-5b)
    ],
  },
  {
    section: 'R2',
    id: 'ehrc-be7ce7e2-0a67-47cc-99cd-63b049ceecaa',
    statement: 'Avoid: The recorded diagnosis is not supported by any documented complaint, examination finding or investigation.',
    precondition: 'Applies when the note records a diagnosis and no documented complaint, symptom, examination finding or investigation in the same note supports it. Does not apply when any documented finding supports the diagnosis, when the diagnosis is a comorbidity carried forward rather than the reason for the visit, or when the note records a working or provisional diagnosis under active investigation.',
    keywords: ['diagnosis mismatch', 'unsupported diagnosis', 'diagnosis without complaint', 'diagnosis discordance'],
    category: 'other',
    citation_url: null,
    absorbs: [
      'ehrc-017042f0-6074-4a67-8ee3-a5a295321b36',   // Avoid: Diagnosis documentation without complaint
      'ehrc-6ae5ef4c-8754-4f98-b1ac-70ec44f843f5',   // Avoid: Diagnosis without corresponding complaint
      'ehrc-78e6b3eb-e493-46eb-8fd1-19fd268488a0',   // Avoid: Diagnosis documentation mismatch
      'ehrc-7d334d04-ef8f-437d-be4c-3033a64b96db',   // Avoid: Diagnosis mismatch
      'ehrc-94df953b-f4ef-41d8-9d7a-a90fa148c79c',   // Avoid: Diagnosis-complaint discordance
      'ehrc-ea1c5bc6-2c6b-476c-bfa9-858264089349',   // Limit: Diagnosis-complaint mismatch
    ],
  },
  {
    section: 'R3',
    id: 'ehrc-f8b0572d-b082-48ec-9774-b7b8970aeb1c',
    statement: 'Limit: Missing safety-netting or follow-up instructions.',
    // RATIFIED 10 AUG 2026 — imported verbatim, never redrafted (PRD §3.3 R3).
    precondition: RATIFIED_SAFETY_NETTING.precondition,
    keywords: ['safety netting', 'safety-netting', 'follow up instruction', 'follow-up advice', 'return advice'],
    category: 'other',
    citation_url: null,
    absorbs: [
      'ehrc-3fbdbcca-15ac-4281-ac3a-1d1ea64317bc',   // Limit: Missing or inadequate follow-up instructions
      'ehrc-6e916c11-698c-41f5-bd17-060e5acd5409',   // Avoid: Lack of safety-netting instructions
      'ehrc-afafb781-14df-4658-8420-8d36fd1370c4',   // Avoid: Inadequate safety netting or follow-up
      'ehrc-b177d8c7-cb9b-410f-9276-af48215901bc',   // Limit: Missing follow-up instructions
      'ehrc-f2e52e55-a231-4d6f-ab88-2ac04d0d99af',   // Limit: Lack of safety-netting and follow-up instructions
      'ehrc-fe8f229b-d818-4e40-a360-367fa85bfb02',   // Avoid: Missing safety-netting instructions (already retired, 0034 D-5a)
    ],
  },
  {
    section: 'R4',
    id: 'ehrc-17b9b233-4e18-4f9b-b8c5-db24024b1f0a',
    statement: 'Avoid: Vitamin D is prescribed without a documented indication, or at a dose that does not match the documented indication.',
    precondition: 'Applies when the note prescribes vitamin D and either no deficiency, risk factor or measured level is documented, or the dose and schedule do not correspond to the documented indication. Does not apply when a measured 25-hydroxyvitamin D result, documented deficiency, malabsorption, chronic kidney disease, osteoporosis, or long-term corticosteroid use supports the prescription at the dose given. If no indication is written in the note, treat it as absent and conclude the recommendation applies.',
    keywords: ['vitamin d', 'cholecalciferol', 'vitamin d dose', 'vitamin d supplementation'],
    category: 'supplement_polypharmacy',
    citation_url: null,
    absorbs: [
      'ehrc-395dda54-0f46-4780-8e77-96b1ceb33d42',   // Limit: Inappropriate Vitamin D dosage
      'ehrc-476e7e80-cae5-45c3-89bc-4ac16c87a9f2',   // Limit: Inappropriate Vitamin D supplementation
      'ehrc-88e9e061-153e-4983-91f0-89b9229257f9',   // Limit: Unindicated vitamin D supplementation
      'ehrc-e4a51ebb-800d-4640-a14b-5850d5575053',   // Limit: Inappropriate Vitamin D dosing
    ],
  },
  {
    section: 'R5',
    id: 'ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c',
    statement: 'Avoid: A systemic antibiotic is prescribed for an acute upper respiratory illness.',
    // RATIFIED 10 AUG 2026 — imported verbatim, never redrafted (PRD §3.3 R5).
    precondition: RATIFIED_ANTIBIOTIC_URI.precondition,
    keywords: ['antibiotic viral', 'antibiotic upper respiratory', 'antibiotic for uri', 'antibiotic common cold'],
    category: 'antibiotic',
    citation_url: null,
    // ⚠️ PRD §3.2 says R5 absorbs 3. The live rulebook holds only THREE non-survivor antibiotic
    // rules in total — the two below plus the one at R6 — and the PRD's own totals line (48
    // absorbed, 67 accounted) is only satisfiable at 2 here. See the report's flagged deviations.
    absorbs: [
      'ehrc-7ac10177-dc6f-4d8a-9f52-ed2fc39f3fa2',   // Avoid: Antibiotic for viral respiratory infection
      'ehrc-f4fb811c-7e57-440a-bf0d-3386d0f3dcbb',   // Avoid: Antibiotic for viral infection
    ],
  },
  {
    section: 'R6',
    id: 'ehrc-e7724b30-d58c-441f-9080-a0f6f1329b48',
    statement: 'Avoid: A systemic antibiotic is prescribed with no documented bacterial indication.',
    precondition: 'Applies when the note prescribes a systemic antibiotic and documents no bacterial infection, no positive culture or rapid test, no radiographic confirmation, and no clinical syndrome for which empiric antibiotic treatment is standard. Does not apply when any of those is documented, when the antibiotic is prescribed as surgical or endocarditis prophylaxis, or when the case falls under R5. Where R5 and R6 both apply, R5 wins.',
    keywords: ['unindicated antibiotic', 'antibiotic without indication', 'antibiotic no indication'],
    category: 'antibiotic',
    citation_url: null,
    absorbs: [
      'ehrc-06e581ae-0a42-47c7-af1e-b99cac562638',   // Avoid: Unindicated antibiotic
    ],
  },
  {
    section: 'R7',
    id: 'ehrc-a98ce8c5-fe89-4934-afe5-b110b7dfc5fc',
    statement: 'Avoid: A complete blood count or complete blood profile is ordered without a documented indication.',
    precondition: 'Applies when the note orders a complete blood count or complete blood profile and documents no symptom, sign, condition or monitoring requirement that the result would inform. Does not apply when anaemia, infection, bleeding, a haematological condition, drug monitoring, or a pre-procedure requirement is documented.',
    keywords: ['complete blood count', 'complete blood profile', 'cbc ordered', 'unindicated cbc'],
    category: 'unindicated_investigation',
    citation_url: null,
    absorbs: [
      'ehrc-0baa7e11-877f-43d2-809d-e7d1ade35322',   // Avoid: Complete Blood Profile testing
      'ehrc-7ffc130c-81ad-4254-a81d-13944ed3c682',   // Avoid: Unindicated complete blood profile
      'ehrc-c96aaff7-0e35-4217-9058-8823dc1c8e49',   // Avoid: Unindicated complete blood count
    ],
  },
  {
    section: 'R8',
    id: 'ehrc-479c0468-b601-44e4-9a87-db42f63883c6',
    statement: 'Avoid: A nutritional supplement, multivitamin or nutraceutical is prescribed with no evidence of benefit for the documented condition.',
    precondition: 'Applies when the note prescribes a nutritional supplement, multivitamin, mineral or nutraceutical and documents no deficiency, no dietary restriction and no condition for which that supplement has an evidence base. Does not apply when a measured deficiency, pregnancy, documented malabsorption, or a condition with an established supplement indication is recorded.',
    keywords: ['multivitamin prescription', 'nutritional supplement', 'nutraceutical prescription', 'non-evidence-based supplement'],
    category: 'supplement_polypharmacy',
    citation_url: null,
    absorbs: [
      'ehrc-19bc33d4-4dc0-402d-ae37-4cfd5cb3864a',   // Limit: Unindicated multivitamin/nutraceutical prescription
      'ehrc-292ea0b5-31eb-41eb-9ab4-258c2f2328ec',   // Avoid: Unindicated vitamin supplementation
      'ehrc-f650a163-a5e5-44ec-8903-d8f8da87e63f',   // Limit: Unindicated multi-vitamin/mineral supplement
    ],
  },
  {
    section: 'R9',
    id: 'ehrc-237ed223-64bd-4192-9c20-ad9643eb2aa8',
    statement: 'Avoid: An oral and a topical NSAID are prescribed together, or two NSAIDs are prescribed concurrently.',
    precondition: 'Applies when the note prescribes an oral and a topical NSAID together, or two systemic NSAIDs together. Does not apply when only one NSAID is prescribed, when low-dose aspirin is being used as an antiplatelet alongside a single NSAID, or when the note documents a deliberate short overlap during a switch.',
    keywords: ['oral and topical nsaid', 'nsaid duplication', 'concurrent nsaid', 'two nsaids'],
    category: 'therapeutic_duplication',
    citation_url: null,
    absorbs: [
      'ehrc-6543ccfa-53fb-457b-89e0-485df5e9169d',   // Avoid: Therapeutic duplication of NSAIDs
      'ehrc-8473546f-cf21-4194-b113-f9ce5751bace',   // Limit: Concurrent oral and topical NSAID use
      'ehrc-e776afe4-1fe0-4cd0-823e-0574f5cea8c8',   // Avoid: Therapeutic duplication oral topical NSAIDs
    ],
  },
  {
    section: 'R10',
    id: 'ehrc-9aa9be1a-9fd1-48b1-9209-7cb0a2a0ec86',
    statement: 'Avoid: Serratiopeptidase is prescribed, alone or in a fixed-dose combination.',
    precondition: 'Applies whenever serratiopeptidase is prescribed, alone or as part of a fixed-dose combination. There is no documented indication for which it is supported. Does not apply when serratiopeptidase is not prescribed.',
    // 'serratiopeptidase' is a single token and is permitted ONLY because it is on the molecule
    // allowlist (§3.4 / §6.3). It is a molecule name, not a stopword.
    keywords: ['serratiopeptidase', 'serratiopeptidase combination'],
    category: 'other',
    citation_url: null,
    absorbs: [
      'ehrc-70cfc786-1600-47ab-8a06-d0d702b8b9fe',   // Avoid: Fixed-dose combination with serratiopeptidase
      'ehrc-a097c781-12d6-4724-9bd4-526b7054036a',   // Avoid: Use of Serratiopeptidase
      'ehrc-e83536f4-bf33-4210-8d14-eb505f892a6c',   // Avoid: Unindicated Serratiopeptidase fixed-dose combination
    ],
  },
  {
    section: 'R11',
    id: 'ehrc-581439a8-cb5f-47ba-8629-e41aba51f65e',
    statement: 'Avoid: An antihistamine is prescribed with no documented allergic indication.',
    precondition: 'Applies when the note prescribes an antihistamine and documents no allergic rhinitis, urticaria, allergic reaction, pruritus or other histamine-mediated condition. Does not apply when any such condition is documented, or when the antihistamine is prescribed for a documented non-allergic indication such as vertigo or nausea.',
    keywords: ['unindicated antihistamine', 'antihistamine without indication', 'antihistamine no allergic'],
    category: 'antihistamine_allergy',
    citation_url: null,
    absorbs: [
      'ehrc-2b42c495-61d4-49d5-9e2c-8d58b5045e6d',   // Avoid: Antihistamine for viral upper respiratory infection
      'ehrc-4fd1cb48-938b-4f11-b828-0ced7767b809',   // Avoid: Levocetirizine+Montelukast for viral URTI
      'ehrc-787ad54d-bd44-4c6b-a272-b01edfadb110',   // Avoid: Unindicated antihistamine
    ],
  },
  {
    section: 'R12',
    id: 'ehrc-e5503ea1-440d-49b8-8d58-dc45845b305a',
    statement: 'Limit: An investigation is ordered without a documented indication.',
    precondition: 'Applies when the note orders an investigation and documents no symptom, sign, condition or monitoring requirement that the result would inform. Does not apply when any documented finding supports the order, when the investigation is a guideline-scheduled screening test appropriate to the patient’s age and risk, or when the case falls under a more specific rule such as R7 or R14.',
    keywords: ['unindicated investigation', 'investigation without indication', 'unnecessary test'],
    category: 'unindicated_investigation',
    citation_url: null,
    absorbs: [
      'ehrc-57fdd02d-7b82-49f6-a077-a5000a52c936',   // Avoid: Unindicated investigation (USG ABDOMEN)
      'ehrc-87fee4fa-9ac7-4739-8960-247d8139e3fd',   // Avoid: Unindicated investigation
      'ehrc-93f6572b-5f1a-4e38-a4fa-447eef6ae116',   // Avoid: Unindicated diagnostic investigation
    ],
  },
  {
    section: 'R13',
    id: 'ehrc-322a7507-f5ec-48d7-8da0-c0dd3d260f64',
    statement: 'Avoid: A medicine is prescribed with no documented indication in the note.',
    precondition: 'Applies when the note prescribes a medicine and no documented complaint, diagnosis or condition corresponds to it. Does not apply when the medicine matches a documented condition, when it is a continuation of established long-term treatment recorded in the note, or when a more specific rule such as R4, R6, R11, R15 or R16 covers it.',
    keywords: ['unindicated medication', 'medicine without indication', 'drug without indication'],
    category: 'other',
    citation_url: null,
    absorbs: [
      'ehrc-458998f9-1bf6-41ed-8ccb-5a4003c0365e',   // Avoid: Unindicated medication
      'ehrc-9b8871eb-119d-4012-8981-5b93149ec03b',   // Avoid: Unindicated drug prescription
    ],
  },
  {
    section: 'R14',
    id: 'ehrc-60cbb099-3ef7-4006-af3f-9b38d6d675e4',
    statement: 'Avoid: An abdominal or pelvic ultrasound is ordered without a documented indication.',
    precondition: 'Applies when the note orders an abdominal or pelvic ultrasound and documents no abdominal or pelvic symptom, sign, abnormal result or monitoring requirement. Does not apply when any such finding is documented, or when the scan is part of documented antenatal care.',
    keywords: ['abdominal ultrasound', 'pelvic ultrasound', 'usg abdomen'],
    category: 'imaging',
    citation_url: null,
    absorbs: [
      'ehrc-05d3716b-d61c-4324-86ba-1a7f5be7a738',   // Avoid: Unindicated abdominal ultrasound
    ],
  },
  {
    section: 'R15',
    id: 'ehrc-90d18db2-b578-405d-b2c3-02ddc09615f1',
    statement: 'Avoid: A proton pump inhibitor is prescribed at high dose without a documented indication for that dose.',
    precondition: 'Applies when the note prescribes a proton pump inhibitor above the standard daily dose and documents no indication for that dose. Does not apply when bleeding ulcer, Zollinger-Ellison syndrome, severe erosive oesophagitis, or documented failure of standard-dose therapy is recorded.',
    keywords: ['high dose ppi', 'high-dose proton pump', 'double dose ppi'],
    category: 'gi_ppi_prokinetic',
    citation_url: null,
    absorbs: [],
  },
  {
    section: 'R16',
    id: 'ehrc-56f4e0d7-c5bf-4f7d-aacb-75917e6437d6',
    statement: 'Avoid: A proton pump inhibitor is prescribed with no documented gastrointestinal indication.',
    precondition: 'Applies when the note prescribes a proton pump inhibitor and documents no reflux, dyspepsia, ulcer, upper gastrointestinal bleeding risk, or concurrent medicine that warrants gastroprotection. Does not apply when any of those is documented. Where R15 and R16 both apply, R15 wins.',
    keywords: ['unindicated ppi', 'proton pump inhibitor without', 'unindicated proton pump'],
    category: 'gi_ppi_prokinetic',
    citation_url: null,
    absorbs: [],
  },
  {
    section: 'R17',
    id: 'ehrc-df3d1c46-f5fe-442a-a684-2979753a4897',
    statement: 'Avoid: Two antihistamines are prescribed concurrently.',
    precondition: 'Applies when the note prescribes two or more antihistamines concurrently, whether as separate medicines or within fixed-dose combinations. Does not apply when only one antihistamine is prescribed, or when one is topical or ophthalmic and the other systemic for a documented reason.',
    keywords: ['antihistamine duplication', 'two antihistamines', 'duplicate antihistamine'],
    category: 'therapeutic_duplication',
    citation_url: null,
    absorbs: [
      'ehrc-6f414fed-3e58-45e9-960d-f1803457641d',   // Avoid: Antihistamine therapeutic duplication
    ],
  },
  {
    section: 'R18',
    id: 'ehrc-1c5340d3-cf20-4810-a2ae-bd528d056a28',
    statement: 'Avoid: A cold or cough preparation is prescribed for a viral upper respiratory illness.',
    precondition: 'Applies when the note documents an acute viral upper respiratory illness and prescribes a cough or cold preparation, including antitussives, expectorants, mucolytics and decongestant combinations. Does not apply when a specific non-viral cause is documented, or when the prescription is a single agent for a documented indication other than the viral illness.',
    keywords: ['cough and cold', 'cold preparation', 'cough syrup', 'expectorant prescribed'],
    category: 'cough_cold_fdc',
    citation_url: null,
    absorbs: [],
  },
  {
    section: 'R19',
    id: 'ehrc-e204a938-a5e1-4890-8693-07c44bf0ce23',
    statement: 'Limit: A referral is made without a documented indication.',
    precondition: 'Applies when the note records a referral to another clinician or specialty and documents no reason for it. Does not apply when a reason is recorded in any form, however brief, or when the referral is a scheduled part of documented ongoing care.',
    keywords: ['referral without indication', 'unindicated referral', 'referral no reason'],
    category: 'other',
    citation_url: null,
    absorbs: [],
  },
];

/** The Phase 1 record set the surface loads by default (D-21). */
export const MERGE_RECORD_SET: RuleRecordSet = {
  key: 'phase1-merge',
  title: 'Phase 1 — merge the mined house rules into concepts',
  blurb: '19 clinical concepts drawn from 67 mined house rules. Accepting a rule updates the survivor and retires its absorbed variants immediately. There is no undo.',
  records: MERGE_RULES,
};

/** Every id this record set touches, survivors first, in a stable order. */
export function recordSetIds(records: MergedRule[] = MERGE_RULES): string[] {
  return [...records.map((r) => r.id), ...records.flatMap((r) => r.absorbs)];
}

// ── validation — ONE implementation, called by the screen AND by the write path (§6.3 / §6.9) ──
/**
 * Why this is exported and shared: the surface must show the rejection reason INLINE as V types a
 * keyword, and the write path must refuse the same input. Two implementations would drift, and the
 * one that drifted would be the write.
 */
export function keywordError(keyword: string): string | null {
  const k = String(keyword ?? '').trim();
  if (!k) return 'keyword is empty';
  // ⚠️ HYPHENS AND SLASHES COUNT AS WORD BREAKS *FOR THIS GUARD*. `safety-netting` is a two-word
  // compound, not a stopword, and PRD §3.4 ships it as a legitimate phrase while naming only
  // `serratiopeptidase` as "a single token". The hazard the guard exists for is a lone
  // STOPWORD-GRADE word — "blood", "vitamin", "diagnosis" — which is what shattered the live
  // rulebook. Counting `safety-netting` as one token would reject the PRD's own ratified keyword.
  //
  // This is a SPECIFICITY judgement and is deliberately NOT the matcher's tokenisation: the matcher
  // splits on whitespace only, so `safety-netting` stays one `\bsafety-netting\b` regex token there.
  // The two are measuring different things and must not be unified.
  const tokens = k.split(/[\s/-]+/).filter(Boolean);
  if (tokens.length === 1) {
    if (MOLECULE_ALLOWLIST.includes(k.toLowerCase())) return null;
    return `"${k}" is a single token — keywords must be phrases (a lone token makes the rule a catch-all). Molecule names may be allowlisted.`;
  }
  return null;
}

export function categoryError(category: string): string | null {
  const c = String(category ?? '').trim();
  if (!c) return 'category is empty';
  if (!(LVC_CATEGORIES as readonly string[]).includes(c)) {
    return `"${c}" is not one of LVC_CATEGORIES (${LVC_CATEGORIES.join(', ')})`;
  }
  return null;
}

/**
 * Validate a whole record set BEFORE any write (§6.3, §6.9). Returns every problem, so a run that
 * is going to fail says everything that is wrong rather than one thing at a time.
 */
export function validateRecords(records: MergedRule[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const r of records) {
    if (!r.id) { errors.push(`${r.section}: missing survivor id`); continue; }
    if (!String(r.statement ?? '').trim()) errors.push(`${r.section} (${r.id}): statement is empty`);
    if (!String(r.precondition ?? '').trim()) errors.push(`${r.section} (${r.id}): precondition is empty`);
    const catErr = categoryError(r.category);
    if (catErr) errors.push(`${r.section} (${r.id}): ${catErr}`);
    if (!r.keywords.length) errors.push(`${r.section} (${r.id}): no keywords — a rule with no keyword can never match`);
    for (const k of r.keywords) {
      const kwErr = keywordError(k);
      if (kwErr) errors.push(`${r.section} (${r.id}): ${kwErr}`);
    }
    for (const id of [r.id, ...r.absorbs]) {
      const prior = seen.get(id);
      if (prior) errors.push(`${id} appears in both ${prior} and ${r.section}`);
      else seen.set(id, r.section);
    }
    if (r.absorbs.includes(r.id)) errors.push(`${r.section} (${r.id}): a rule cannot absorb itself`);
  }
  return errors;
}

/** Refuse an unnamed or default ratifier — the same rule lvc_ratify enforces (§3.5 Gate). */
export function ratifierError(ratifiedBy: string): string | null {
  const by = String(ratifiedBy ?? '').trim();
  if (!by) return 'ratified_by is required — name the clinician accepting this';
  if (by === DEFAULT_AUTHOR) {
    return `ratified_by must not be the default '${DEFAULT_AUTHOR}' — a ratification must name a real person`;
  }
  if (by.length < 2) return 'ratified_by is too short to identify a person';
  return null;
}

// ── INFERRED SQL 1 — read every touched row BEFORE writing anything ────────────────────────────
// Runs first precisely so that a missing column (0041 unapplied), a missing table or a dead
// connection aborts with ZERO writes rather than part-way through (§6.2).
export const MERGE_READBACK_SQL = `SELECT id, statement, precondition, keywords, category, citation_url,
       status, merged_into, ratified_by, ratified_at
  FROM lvc_recommendations
 WHERE id = ANY($1)`;

// ── INFERRED SQL 2 — one guarded survivor update ───────────────────────────────────────────────
// The IS DISTINCT FROM guard is what makes the accept idempotent: a survivor already carrying the
// accepted values matches nothing and RETURNING yields no id, so a second accept reports unchanged.
// ⚠️ ratified_at / updated_at are now() and are therefore OUTSIDE the guard predicate on purpose —
// inside it, every re-run would "change" and the idempotence claim would be false.
export const SURVIVOR_UPDATE_SQL = `UPDATE lvc_recommendations
   SET statement    = $2,
       precondition = $3,
       keywords     = $4::text[],
       category     = $5,
       citation_url = $6,
       ratified_by  = $7,
       ratified_at  = now(),
       updated_at   = now()
 WHERE id = $1
   AND (statement    IS DISTINCT FROM $2
     OR precondition IS DISTINCT FROM $3
     OR keywords     IS DISTINCT FROM $4::text[]
     OR category     IS DISTINCT FROM $5
     OR citation_url IS DISTINCT FROM $6
     OR ratified_by  IS DISTINCT FROM $7)
 RETURNING id`;

// ── INFERRED SQL 3 — one guarded retirement ────────────────────────────────────────────────────
// Retirement does NOT touch statement or precondition: the retired row still reads as what it was
// (PRD §3.1 step 3), and `status = 'retired'` is what removes it from recall — getLvcRules selects
// status = 'active'. `merged_into` is what makes the trail readable afterwards (§6.6).
export const ABSORBED_UPDATE_SQL = `UPDATE lvc_recommendations
   SET status      = $2,
       merged_into = $3,
       ratified_by = $4,
       ratified_at = now(),
       updated_at  = now()
 WHERE id = $1
   AND (status      IS DISTINCT FROM $2
     OR merged_into IS DISTINCT FROM $3
     OR ratified_by IS DISTINCT FROM $4)
 RETURNING id`;

/** PRD §2.1: `status` has no CHECK constraint; two rows already carry 'retired'. */
export const RETIRED_STATUS = 'retired';

/** The one DB primitive this module needs. Injected, so the runner is unit-testable. */
export type SqlRunner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export type MergeRowAction = 'survivor' | 'absorbed';
export type MergeRowResult = 'updated' | 'unchanged' | 'missing' | 'error';

export interface MergeRowReport {
  section: string;
  id: string;
  action: MergeRowAction;
  result: MergeRowResult;
  /** for an absorbed row: the survivor it now points at */
  mergedInto?: string;
  /** post-write readback: does the row now hold exactly the accepted value? */
  verified?: boolean;
  detail?: string;
}

export interface MergeResult {
  ok: boolean;
  dryRun: boolean;
  ratifiedBy: string;
  sections: string[];
  changed: number;
  unchanged: number;
  missing: number;
  /** every touched row read back and confirmed */
  verified: boolean;
  rows: MergeRowReport[];
  error?: string;
}

export interface CurrentRuleRow {
  id: string;
  statement: string | null;
  precondition: string | null;
  keywords: string[];
  category: string | null;
  citationUrl: string | null;
  status: string | null;
  mergedInto: string | null;
  ratifiedBy: string | null;
  ratifiedAt: string | null;
}

/**
 * `keywords` comes back from Neon as a JS array for text[], but a driver or a view can hand back the
 * Postgres literal `{a,b}` or a JSON string instead. Normalised here so a shape surprise degrades to
 * a best-effort array rather than throwing inside the runner. Mirrors the tolerance getLvcRules has.
 */
export function parseKeywordColumn(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) { try { const j = JSON.parse(s); return Array.isArray(j) ? j.map(String) : []; } catch { return []; } }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
    return s ? [s] : [];
  }
  return [];
}

export function readRuleRows(rows: Record<string, unknown>[]): Map<string, CurrentRuleRow> {
  const m = new Map<string, CurrentRuleRow>();
  for (const r of rows ?? []) {
    const id = String(r.id ?? '');
    if (!id) continue;
    m.set(id, {
      id,
      statement: r.statement == null ? null : String(r.statement),
      precondition: r.precondition == null ? null : String(r.precondition),
      keywords: parseKeywordColumn(r.keywords),
      category: r.category == null ? null : String(r.category),
      citationUrl: r.citation_url == null ? null : String(r.citation_url),
      status: r.status == null ? null : String(r.status),
      mergedInto: r.merged_into == null ? null : String(r.merged_into),
      ratifiedBy: r.ratified_by == null ? null : String(r.ratified_by),
      ratifiedAt: r.ratified_at == null ? null : String(r.ratified_at),
    });
  }
  return m;
}

/** Do two keyword arrays hold the same phrases in the same order? (The guard's JS mirror.) */
export function sameKeywords(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Does the live row already hold exactly what this record says? (`changed: 0` on a repeat.) */
export function survivorMatches(cur: CurrentRuleRow | undefined, r: MergedRule, ratifiedBy: string): boolean {
  if (!cur) return false;
  return cur.statement === r.statement
    && cur.precondition === r.precondition
    && sameKeywords(cur.keywords, r.keywords)
    && cur.category === r.category
    && cur.citationUrl === r.citation_url
    && cur.ratifiedBy === ratifiedBy;
}

export function absorbedMatches(cur: CurrentRuleRow | undefined, survivorId: string, ratifiedBy: string): boolean {
  if (!cur) return false;
  return cur.status === RETIRED_STATUS && cur.mergedInto === survivorId && cur.ratifiedBy === ratifiedBy;
}

/**
 * Apply a merge (PRD §3.1). Idempotent: a second run over the same records changes zero rows.
 *
 * WRITE ORDER, AND IT IS LOAD-BEARING (PRD §3.1, §6.2, §6.10):
 *   1. READBACK FIRST over survivors AND absorbed ids. Any failure ⇒ ok:false, ZERO writes.
 *   2. Survivors — one guarded UPDATE each.
 *   3. Absorbed — one guarded UPDATE each, status='retired' + merged_into=<survivor>.
 *   4. Verification readback — re-read and confirm each row landed.
 *
 * `records` defaults to the whole Phase 1 set; the ratification surface passes ONE record carrying
 * the values V edited on screen, which is why the records are a parameter and not a closure.
 *
 * There is NO transaction (Neon HTTP, one statement per round trip), so a failure part-way leaves
 * some rows written. That is reported precisely — see MergeResult.rows — never hidden behind a
 * success, and pressing accept again completes the job because every write is individually guarded.
 */
export async function applyRuleMerge(
  run: SqlRunner,
  opts: { records?: MergedRule[]; ratifiedBy: string; dryRun?: boolean },
): Promise<MergeResult> {
  const records = opts.records ?? MERGE_RULES;
  const dryRun = opts.dryRun === true;
  const ratifiedBy = String(opts.ratifiedBy ?? '').trim();
  const base: MergeResult = {
    ok: true, dryRun, ratifiedBy, sections: records.map((r) => r.section),
    changed: 0, unchanged: 0, missing: 0, verified: false, rows: [],
  };

  // 0) Refuse a bad ratifier or an invalid record set BEFORE touching the database at all.
  const whoErr = ratifierError(ratifiedBy);
  if (whoErr) return { ...base, ok: false, error: whoErr };
  const recErrors = validateRecords(records);
  if (recErrors.length) {
    return { ...base, ok: false, error: `record set rejected, nothing written: ${recErrors.join(' | ').slice(0, 600)}` };
  }

  const ids = recordSetIds(records);

  // 1) READ FIRST. Any fault here aborts with zero writes — the fail-safe property.
  let before: Map<string, CurrentRuleRow>;
  try {
    before = readRuleRows(await run(MERGE_READBACK_SQL, [ids]));
  } catch (e) {
    return { ...base, ok: false, error: `readback failed, nothing written: ${String((e as Error).message).slice(0, 300)}` };
  }

  const rows: MergeRowReport[] = [];

  // 2) Survivors.
  for (const r of records) {
    const cur = before.get(r.id);
    if (!cur) { rows.push({ section: r.section, id: r.id, action: 'survivor', result: 'missing' }); continue; }
    const wouldChange = !survivorMatches(cur, r, ratifiedBy);
    if (dryRun) { rows.push({ section: r.section, id: r.id, action: 'survivor', result: wouldChange ? 'updated' : 'unchanged' }); continue; }
    try {
      const out = await run(SURVIVOR_UPDATE_SQL, [r.id, r.statement, r.precondition, r.keywords, r.category, r.citation_url, ratifiedBy]);
      rows.push({ section: r.section, id: r.id, action: 'survivor', result: out.length ? 'updated' : 'unchanged' });
    } catch (e) {
      rows.push({ section: r.section, id: r.id, action: 'survivor', result: 'error', detail: String((e as Error).message).slice(0, 200) });
    }
  }

  // 3) Absorbed rules — retired, pointing at their survivor.
  for (const r of records) {
    for (const absorbedId of r.absorbs) {
      const cur = before.get(absorbedId);
      if (!cur) { rows.push({ section: r.section, id: absorbedId, action: 'absorbed', result: 'missing', mergedInto: r.id }); continue; }
      const wouldChange = !absorbedMatches(cur, r.id, ratifiedBy);
      if (dryRun) { rows.push({ section: r.section, id: absorbedId, action: 'absorbed', result: wouldChange ? 'updated' : 'unchanged', mergedInto: r.id }); continue; }
      try {
        const out = await run(ABSORBED_UPDATE_SQL, [absorbedId, RETIRED_STATUS, r.id, ratifiedBy]);
        rows.push({ section: r.section, id: absorbedId, action: 'absorbed', result: out.length ? 'updated' : 'unchanged', mergedInto: r.id });
      } catch (e) {
        rows.push({ section: r.section, id: absorbedId, action: 'absorbed', result: 'error', mergedInto: r.id, detail: String((e as Error).message).slice(0, 200) });
      }
    }
  }

  // 4) READ BACK. The orchestrator's verification, done in the same call rather than by hand.
  let verifiedAll = false;
  if (!dryRun) {
    try {
      const after = readRuleRows(await run(MERGE_READBACK_SQL, [ids]));
      for (const row of rows) {
        const cur = after.get(row.id);
        if (!cur) { row.verified = false; continue; }
        if (row.action === 'survivor') {
          const spec = records.find((r) => r.id === row.id);
          row.verified = !!spec && survivorMatches(cur, spec, ratifiedBy);
        } else {
          row.verified = absorbedMatches(cur, String(row.mergedInto ?? ''), ratifiedBy);
        }
      }
      verifiedAll = rows.length === ids.length && rows.every((r) => r.verified === true);
    } catch (e) {
      return {
        ...base, ok: false, rows,
        changed: rows.filter((r) => r.result === 'updated').length,
        unchanged: rows.filter((r) => r.result === 'unchanged').length,
        missing: rows.filter((r) => r.result === 'missing').length,
        error: `writes ran but the verification readback failed: ${String((e as Error).message).slice(0, 300)}`,
      };
    }
  }

  const errored = rows.filter((r) => r.result === 'error');
  return {
    ...base,
    ok: errored.length === 0 && rows.every((r) => r.result !== 'missing'),
    changed: rows.filter((r) => r.result === 'updated').length,
    unchanged: rows.filter((r) => r.result === 'unchanged').length,
    missing: rows.filter((r) => r.result === 'missing').length,
    verified: dryRun ? false : verifiedAll,
    rows,
    ...(errored.length ? { error: `${errored.length} row(s) failed to update; every statement is independently idempotent, so pressing accept again completes the job` } : {}),
  };
}

// ── INFERRED SQL 4 — migration 0041, applied through the admin route ───────────────────────────
// ⚠️ SCHEMA ONLY. There is deliberately no rule-content statement here: under D-18 the ratification
// surface is the write. These three strings are byte-identical to migrations/0041_lvc_rule_merge.sql
// (the test asserts it), because migrations/ is not bundled into the Vercel serverless function.
export const MERGE_DDL_STATEMENTS: string[] = [
  `ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS merged_into TEXT`,
  `COMMENT ON COLUMN lvc_recommendations.merged_into IS 'For a rule retired by a merge: the id of the surviving rule that replaced it. NULL for every active rule.'`,
  `CREATE INDEX IF NOT EXISTS lvc_merged_into_idx ON lvc_recommendations (merged_into)`,
];

// ── INFERRED SQL 5 — the column-existence probe the migration route reports ────────────────────
export const MERGED_INTO_PROBE_SQL = `SELECT 1 AS ok
  FROM information_schema.columns
 WHERE table_name = 'lvc_recommendations' AND column_name = 'merged_into'`;

export interface DdlResult {
  ok: boolean;
  dryRun: boolean;
  statements: Array<{ sql: string; result: 'applied' | 'planned' | 'error'; detail?: string }>;
  mergedIntoPresent: boolean;
  error?: string;
}

/**
 * Apply migration 0041 — the column, its comment and its index. Idempotent by IF NOT EXISTS.
 * Fail-safe: a probe failure is reported, never thrown, and `?dry=1` writes nothing.
 */
export async function applyMergeDdl(run: SqlRunner, opts: { dryRun?: boolean } = {}): Promise<DdlResult> {
  const dryRun = opts.dryRun === true;
  const statements: DdlResult['statements'] = [];

  const probe = async (): Promise<boolean> => {
    try { return (await run(MERGED_INTO_PROBE_SQL, [])).length > 0; } catch { return false; }
  };

  if (dryRun) {
    for (const sqlText of MERGE_DDL_STATEMENTS) statements.push({ sql: sqlText, result: 'planned' });
    return { ok: true, dryRun, statements, mergedIntoPresent: await probe() };
  }

  let failed = 0;
  for (const sqlText of MERGE_DDL_STATEMENTS) {
    try { await run(sqlText, []); statements.push({ sql: sqlText, result: 'applied' }); }
    catch (e) { failed++; statements.push({ sql: sqlText, result: 'error', detail: String((e as Error).message).slice(0, 200) }); }
  }
  const present = await probe();
  return {
    ok: failed === 0 && present,
    dryRun,
    statements,
    mergedIntoPresent: present,
    ...(failed ? { error: `${failed} DDL statement(s) failed; every statement is IF NOT EXISTS, so re-running is safe` } : {}),
    ...(!failed && !present ? { error: 'statements ran without error but merged_into is still not visible on lvc_recommendations' } : {}),
  };
}
