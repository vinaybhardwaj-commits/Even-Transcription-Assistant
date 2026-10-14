/**
 * Sprint 2.1 / 2.2 — Overview tiles and Surgical ELO honesty.
 * Stage 4 — Document Audits / RMO go live (honest empty when no ingest);
 * Adherence starts from available audits + surgical feedback.
 *
 * Pure shaping only. Callers pass queried counts. This module never invents
 * Document Audits volumes or Surgical ELO scores.
 */

import {
  ADHERENCE_EMPTY_LABEL,
  computeAdherencePresentation,
  emptyAdherenceInputs,
  type AdherenceInputs,
  type AdherencePresentation,
} from "@/lib/adherence-stage4";

/** Last OPD snapshot older than this (calendar days) is labeled Stale. */
export const OPD_STALE_AFTER_DAYS = 14;

/**
 * Lab / warehouse context from the ratified Sprint 2.2 mock (EHRC cohort,
 * locked ~1 Sep 2026). This is not a Surgical ELO score and is not read
 * from score_snapshots.
 */
export const LAB_EHRC_COHORT = {
  kind: "lab_context" as const,
  label: "Lab Bot EHRC cohort",
  stays: 129,
  lockedNote: "locked ~1 Sep 2026",
};

/** @deprecated Stage 4 — prefer adherencePresentation(inputs). Kept for old string matches. */
export const ADHERENCE_STATE = "empty" as const;
export const ADHERENCE_LABEL = ADHERENCE_EMPTY_LABEL;

export interface EloCounts {
  vcs: number;
  cases: number;
  snapshots: number;
  observationCases: number;
}

export interface IrisCounts {
  open: number | null;
  total: number | null;
  highSev: number | null;
  withRca: number | null;
  overdue: number | null;
}

export interface Stage2DbCounts {
  physiciansActive: number;
  physiciansRoster: number;
  engagementsActive: number;
  positionsActive: number;
  feedbackTotal: number;
  feedbackPositive: number;
  feedbackOpenNegative: number;
  physiciansWithFeedback: number;
  elo: EloCounts;
  opdLastDay: string | null;
  opdAgeDays: number | null;
  /** Stage 4 — null when tables unreadable; 0 when empty (honest). */
  documentAudits: number | null;
  documentAuditOpenFindings: number | null;
  adherence: AdherenceInputs | null;
}

export type TileChip = "live" | "proposed" | "stale" | "empty" | "partial" | "not_loaded" | "live_route";

export interface ModuleTile {
  id: string;
  group: "people" | "clinical" | "safety";
  title: string;
  chip: TileChip;
  chipLabel: string;
  body: string;
  meta: string;
  href: string | null;
  /** Set for live queried modules. Null when unread / not applicable. */
  volume: number | null;
}

export interface HeadlineItem {
  label: string;
  value: string;
  hint: string;
  tone: "default" | "danger" | "muted";
}

export interface OverviewViewModel {
  countsAvailable: boolean;
  headline: HeadlineItem[];
  tiles: ModuleTile[];
  banner: string;
  opd: { stale: boolean; lastDay: string | null };
  eloEmpty: boolean;
}

export interface OverviewAccess {
  canOpenElo: boolean;
  canOpenSafety: boolean;
}

const EMPTY_IRIS: IrisCounts = {
  open: null,
  total: null,
  highSev: null,
  withRca: null,
  overdue: null,
};

/** Volume for Overview tile — null only when counts could not be read. */
export function documentAuditVolume(count: number | null | undefined): number | null {
  if (count === null || count === undefined) return null;
  return count;
}

export function eloIsProductionEmpty(counts: Pick<EloCounts, "vcs" | "cases" | "snapshots">): boolean {
  return counts.vcs === 0 && counts.cases === 0 && counts.snapshots === 0;
}

export function opdIsStale(ageDays: number | null, staleAfterDays = OPD_STALE_AFTER_DAYS): boolean {
  if (ageDays === null || !Number.isFinite(ageDays)) return true;
  return ageDays > staleAfterDays;
}

export function adherencePresentation(inputs?: AdherenceInputs | null): AdherencePresentation {
  return computeAdherencePresentation(inputs ?? emptyAdherenceInputs());
}

/** Outcomes copy for the empty ELO surface. Never an ELO score. */
export function outcomesLabContext(): {
  kind: "lab_context";
  stays: number;
  label: string;
  lockedNote: string;
  eloScore: null;
} {
  return {
    kind: LAB_EHRC_COHORT.kind,
    stays: LAB_EHRC_COHORT.stays,
    label: LAB_EHRC_COHORT.label,
    lockedNote: LAB_EHRC_COHORT.lockedNote,
    eloScore: null,
  };
}

function n(value: number): string {
  return String(value);
}

function irisHint(iris: IrisCounts): string {
  const parts: string[] = [];
  if (iris.total !== null) parts.push(`${iris.total} total`);
  if (iris.highSev !== null) parts.push(`${iris.highSev} high-sev`);
  if (iris.withRca !== null) parts.push(`${iris.withRca} with RCA`);
  if (iris.overdue !== null) parts.push(`${iris.overdue} overdue`);
  parts.push("LIVE");
  return parts.join(" · ");
}

function irisBody(iris: IrisCounts): string {
  if (iris.open === null && iris.total === null) {
    return "Hospital incident module. Separate from physician feedback. Live e-IRIS totals were not returned.";
  }
  const bits: string[] = [];
  if (iris.open !== null) bits.push(`${iris.open} open`);
  if (iris.highSev !== null) bits.push(`${iris.highSev} high severity`);
  if (iris.overdue !== null) bits.push(`${iris.overdue} overdue`);
  if (iris.withRca !== null) bits.push(`${iris.withRca} with RCA`);
  return `${bits.join(" · ")}. Separate from physician feedback.`;
}

function eloBody(elo: EloCounts, adherence: AdherencePresentation): string {
  const adh =
    adherence.state === "empty"
      ? "Adherence empty (no audits / surgical feedback yet)"
      : `Adherence ${adherence.label}`;
  return `${elo.vcs} VCs · ${elo.cases} surgical cases · ${elo.snapshots} score snapshots. ${adh}.`;
}

export function buildOverviewModel(
  db: Stage2DbCounts | null,
  iris: IrisCounts = EMPTY_IRIS,
  access: OverviewAccess = { canOpenElo: false, canOpenSafety: false },
): OverviewViewModel {
  const auditVolume = documentAuditVolume(db?.documentAudits ?? null);
  const openFindings = db?.documentAuditOpenFindings ?? null;
  const adherence = adherencePresentation(db?.adherence ?? null);
  const opdStale = db ? opdIsStale(db.opdAgeDays) : true;
  const eloEmpty = db ? eloIsProductionEmpty(db.elo) : false;

  const headline: HeadlineItem[] = db
    ? [
        {
          label: "Physicians active",
          value: n(db.physiciansActive),
          hint: `LIVE · EPI · of ${db.physiciansRoster} roster`,
          tone: "default",
        },
        {
          label: "Engagements active",
          value: n(db.engagementsActive),
          hint: "LIVE · EPI",
          tone: "default",
        },
        {
          label: "Open negative feedback",
          value: n(db.feedbackOpenNegative),
          hint: `of ${db.feedbackTotal} total · LIVE`,
          tone: db.feedbackOpenNegative > 0 ? "danger" : "default",
        },
        {
          label: "e-IRIS open",
          value: iris.open === null ? "—" : n(iris.open),
          hint: iris.open === null ? "Not returned · separate from feedback" : irisHint(iris),
          tone: (iris.open ?? 0) > 0 ? "danger" : "default",
        },
        {
          label: "Surgical ELO · VCs",
          value: n(db.elo.vcs),
          hint: `${db.elo.cases} cases · ${db.elo.snapshots} snapshots`,
          tone: eloEmpty ? "muted" : "default",
        },
        {
          label: "Positions active",
          value: n(db.positionsActive),
          hint: "LIVE · EPI",
          tone: "default",
        },
      ]
    : [
        { label: "Physicians active", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Engagements active", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Open negative feedback", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "e-IRIS open", value: iris.open === null ? "—" : n(iris.open), hint: iris.open === null ? "Not returned" : irisHint(iris), tone: "muted" },
        { label: "Surgical ELO · VCs", value: "—", hint: "Volumes not shown", tone: "muted" },
        { label: "Positions active", value: "—", hint: "Counts unavailable", tone: "muted" },
      ];

  const opdBody = !db
    ? "OPD snapshot day could not be read. No act-now volume is shown."
    : db.opdLastDay
      ? `Last gov_signal_snapshots day: ${db.opdLastDay} (source cdmss_opd). ${opdStale ? "Stale vs today." : "Within the freshness window."}`
      : "No OPD snapshot is stored. Labeled Stale — no act-now volume is invented.";

  const feedbackBody = db
    ? `${db.feedbackTotal} total · ${db.feedbackOpenNegative} open negative · ${db.feedbackPositive} positive · ${db.physiciansWithFeedback} physicians with feedback (grouped home).`
    : "Live feedback counts could not be read. Open the grouped home — volumes are not invented here.";

  const tiles: ModuleTile[] = [
    {
      id: "physicians",
      group: "people",
      title: "Physicians",
      chip: "live",
      chipLabel: "Live",
      body: db
        ? `${db.physiciansActive} active · ${db.physiciansRoster} roster · specialty mix across the network.`
        : "Roster counts unavailable.",
      meta: "Open roster →",
      href: "/physicians",
      volume: db ? db.physiciansActive : null,
    },
    {
      id: "credentialing",
      group: "people",
      title: "Credentialing",
      chip: "partial",
      chipLabel: "Partial",
      body: "Qualifications are live. Pending and expiry workqueues are not spotlighted on this Overview.",
      meta: "Open credentialing →",
      href: "/onboarding",
      volume: null,
    },
    {
      id: "document-audits",
      group: "clinical",
      title: "Document Audits",
      chip: !db || auditVolume === null ? "empty" : auditVolume === 0 ? "empty" : "live",
      chipLabel: !db || auditVolume === null ? "Empty" : auditVolume === 0 ? "Empty" : "Live",
      body:
        auditVolume === null
          ? "Document audit tables could not be read. Volumes are omitted rather than invented."
          : auditVolume === 0
            ? "Progress / OT / Discharge audits. None ingested yet — honest empty."
            : `${auditVolume} audits · ${openFindings ?? 0} open findings. RMO-authored; physicians remediate via portal.`,
      meta: "Open Document Audits →",
      href: "/document-audits",
      volume: auditVolume,
    },
    {
      id: "opd",
      group: "clinical",
      title: "OPD Governance",
      chip: opdStale ? "stale" : "live",
      chipLabel: opdStale ? "Stale" : "Live",
      body: opdBody,
      meta: "View last snapshot →",
      href: "/opd-governance",
      volume: null,
    },
    {
      id: "rmo",
      group: "clinical",
      title: "RMO Inbox",
      chip: !db || openFindings === null ? "empty" : openFindings === 0 ? "empty" : "live",
      chipLabel: !db || openFindings === null ? "Empty" : openFindings === 0 ? "Empty" : "Live",
      body:
        openFindings === null
          ? "RMO authoring queue could not be read."
          : openFindings === 0
            ? "RMO authoring / triage pipe. Empty until findings are authored. Doctors remediate via portal — RMOs do not fix."
            : `${openFindings} open findings in the RMO pipe. Authored by RMO; remediator = target physician.`,
      meta: "Open RMO Inbox →",
      href: "/rmo-inbox",
      volume: openFindings,
    },
    {
      id: "surgical-elo",
      group: "clinical",
      title: "Surgical ELO",
      chip: !db ? "empty" : eloEmpty ? "empty" : "live",
      chipLabel: !db ? "Unavailable" : eloEmpty ? "Empty" : "Live",
      body: db ? eloBody(db.elo, adherence) : "Counts unavailable — VC, case, and snapshot volumes are not shown.",
      meta: access.canOpenElo ? "View Surgical ELO →" : "Super admin",
      href: access.canOpenElo ? "/surgical-governance" : null,
      volume: db ? db.elo.vcs : null,
    },
    {
      id: "mm",
      group: "clinical",
      title: "M&M",
      chip: "not_loaded",
      chipLabel: "Not loaded",
      body: "SGC / super module — counts are not queried for this Overview.",
      meta: access.canOpenSafety ? "Open M&M →" : "SGC / super",
      href: access.canOpenSafety ? "/mm" : null,
      volume: null,
    },
    {
      id: "feedback",
      group: "safety",
      title: "Patient Feedback",
      chip: "live",
      chipLabel: "Live",
      body: feedbackBody,
      meta: "Open grouped Feedback →",
      href: "/incidents",
      volume: db ? db.feedbackTotal : null,
    },
    {
      id: "e-iris",
      group: "safety",
      title: "Incidents (e-IRIS)",
      chip: "live",
      chipLabel: "Live",
      body: irisBody(iris),
      meta: access.canOpenSafety ? "Open e-IRIS →" : "SGC / super",
      href: access.canOpenSafety ? "/safety" : null,
      volume: iris.open,
    },
    {
      id: "safety-report",
      group: "safety",
      title: "Safety Report",
      chip: "live_route",
      chipLabel: "Live route",
      body: "Report an incident (SGC). Separate from physician feedback.",
      meta: access.canOpenSafety ? "Open report →" : "SGC / super",
      href: access.canOpenSafety ? "/safety/report" : null,
      volume: null,
    },
  ];

  const banner = db
    ? `Document Audits ${db.documentAudits ?? "—"} · RMO open ${db.documentAuditOpenFindings ?? "—"}. Surgical ELO is ${db.elo.vcs} / ${db.elo.cases} / ${db.elo.snapshots}; Adherence ${adherence.label}. OPD last snapshot day ${db.opdLastDay ?? "none"} — ${opdStale ? "labeled Stale" : "current"}. Patient Feedback uses live ${db.feedbackTotal} / ${db.feedbackOpenNegative} open negative / ${db.feedbackPositive} positive / ${db.physiciansWithFeedback} physicians with feedback.`
    : "Live database counts could not be read. Document Audits, RMO, and Surgical ELO volumes are not shown.";

  return {
    countsAvailable: db !== null,
    headline,
    tiles,
    banner,
    opd: { stale: opdStale, lastDay: db?.opdLastDay ?? null },
    eloEmpty,
  };
}

export function shellBadgeModel(db: Stage2DbCounts | null): {
  opd: { stale: boolean; lastDay: string | null } | null;
  elo: { empty: boolean; vcs: number; cases: number; snapshots: number } | null;
  documentAudits: { chip: "empty" | "live"; volume: number | null };
  rmo: { chip: "empty" | "live"; volume: number | null };
} {
  const audits = documentAuditVolume(db?.documentAudits ?? null);
  const open = db?.documentAuditOpenFindings ?? null;
  return {
    documentAudits: {
      chip: audits === null || audits === 0 ? "empty" : "live",
      volume: audits,
    },
    rmo: {
      chip: open === null || open === 0 ? "empty" : "live",
      volume: open,
    },
    opd: db ? { stale: opdIsStale(db.opdAgeDays), lastDay: db.opdLastDay } : null,
    elo: db
      ? {
          empty: eloIsProductionEmpty(db.elo),
          vcs: db.elo.vcs,
          cases: db.elo.cases,
          snapshots: db.elo.snapshots,
        }
      : null,
  };
}
