/**
 * lib/architecture/changelog-types.ts — the shared platform changelog shape (System Map Stage 1).
 * A SUPERSET of lib/opd-audit-changelog.ts's EngineChange: every existing OPD_AUDIT_CHANGELOG
 * entry already conforms with no data change (the conformance is asserted type-level in
 * lib/__tests__/architecture-map-gen.test.ts). Other subsystems register their own
 * ChangeEntry[] over time; the map page shows which subsystems don't have one yet.
 * A shape only — no data lives here.
 */

export interface ChangeEntry {
  engine: string | null;    // subsystem version this change shipped under; null = no version bump
  date: string;             // YYYY-MM-DD (IST)
  scoring: boolean;         // did stored scores change (engine bump / backfill)?
  title: string;
  points: string[];         // what changed, concretely
  why: string;              // the trigger — clinician feedback, mined prevalence, V ruling
  plain?: string;           // plain-language headline for in-product timelines
  subsystem?: string;       // manifest id of the owning module (optional — the OPD audit
                            // changelog predates this field and implies 'opd-note-audit-core')
}
