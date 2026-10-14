// Users Module #13/#15 — single source of truth for role labels + tooltips.
// NOTE: the DB role value `sgc_member` is now surfaced as "Site Governance Officer (SGO)".
// Surgical Governance visibility is super_admin-only (#18) — there is no separate ELO grant.
export interface RoleMeta { short: string; label: string; scope: string; desc: string }

export const ROLE_META: Record<string, RoleMeta> = {
  super_admin: {
    short: "Super",
    label: "Super Admin",
    scope: "Network-wide",
    desc: "Full network-wide control across all hospitals — manage users, physicians, credentialing, and settings everywhere. Set via the Super toggle, not per-hospital.",
  },
  site_medical_head: {
    short: "Site MH",
    label: "Site Medical Head",
    scope: "Per hospital",
    desc: "Senior medical authority for this hospital. Approves Core privilege grants, signs off FPPE and OPPE reviews, decides Special-privilege requests, and handles suspensions/revocations here.",
  },
  hr: {
    short: "HR",
    label: "Human Resources",
    scope: "Per hospital",
    desc: "Runs credentialing intake at this hospital: application and document checklists, OPPE packet prep, license/indemnity expiry nudges, and filing Special-privilege requests for physicians.",
  },
  sgc_member: {
    short: "SGO",
    label: "Site Governance Officer",
    scope: "Per hospital",
    desc: "The operations counterpart to the Site Medical Head. Records operational/governance feedback, incidents, and notes on physicians for the SMH to review, and views physician profiles read-only. Cannot credential, privilege, or run FPPE/OPPE reviews.",
  },
};
