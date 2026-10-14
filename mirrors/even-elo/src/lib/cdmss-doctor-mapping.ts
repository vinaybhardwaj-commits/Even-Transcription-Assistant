/**
 * CDMSS doctor mapping (F1) — pure matching of EPI physicians to the CDMSS doctor directory.
 *
 * Before: only doctors who happened to appear in the top-5 `affected[]` of an OPD cohort signal
 * were even candidates, and the name match was an order-sensitive string compare. A doctor with
 * discharge or OT findings but no OPD signal could never be linked, and the portal then said
 * "not linked" while the nightly ingest silently skipped their audits.
 *
 * Now every physician is matched against `GET /api/governance/doctor-directory` (the canonical
 * roster). The matching key is the CDMSS recipe: lower-case, drop "Dr." and punctuation, split into
 * tokens, SORT the tokens ("Dr. K N Srikanth" == "Srikanth K N"). Linking is deliberately
 * conservative. It only writes a link when it is certain:
 *
 *   exact_unique_name   one directory doctor and one unlinked active physician share the key, and
 *                       the mobile last-4 does not contradict it
 *   name_and_mobile     several people share the key, and the mobile last-4 picks exactly one on
 *                       each side
 *
 * Anything weaker (ambiguous names, a mobile that disagrees, a partial name such as a missing
 * middle name) goes to a REVIEW list for governance staff. It is never auto-linked and never
 * reaches a doctor. `alias_uids` (duplicate CDMSS identities collapsed into one canonical uid)
 * are honoured only with proof of identity. CDMSS collapses on the mobile number alone, so two
 * different doctors who share a department phone arrive as one canonical uid plus an alias:
 *
 *   · a physician linked through an alias is moved to the canonical uid ONLY when the physician's
 *     normalized name equals the canonical doctor's name; otherwise it goes to review as
 *     `alias_name_mismatch` and keeps its link;
 *   · an alias uid is recorded on a physician (so audits that still carry the old uid resolve to
 *     them) only when it is proven: the physician was already linked to it under a matching name,
 *     or the directory supplies the alias's name (`alias_names`) and it matches the canonical name.
 *     An unproven alias is not recorded, so an audit under it stays unmapped instead of landing on
 *     the wrong doctor.
 */

export interface DirectoryDoctor {
  doctor_uid: string;
  name: string;
  mobile_last4: string | null;
  alias_uids: string[];
  /** Optional proof: alias uid -> the name CDMSS holds for it. Absent today. */
  alias_names?: Record<string, string>;
  /** CDMSS includes disabled doctors with `disabled: true`; the consumer decides what that means. */
  disabled: boolean;
}

export interface PhysicianRow {
  id: string;
  full_name: string;
  phone: string | null;
  cdmss_doctor_uid: string | null;
  cdmss_alias_uids?: string[] | null;
}

export type AutoReason = "exact_unique_name" | "name_and_mobile" | "alias_relink";

export interface AutoLink {
  uid: string;
  name: string;
  physician_id: string;
  physician_name: string;
  reason: AutoReason;
  alias_uids: string[];
  disabled: boolean;
}

export type ReviewReason =
  | "ambiguous_name"
  | "mobile_mismatch"
  | "partial_name"
  | "linked_to_other_uid"
  | "physician_claimed_twice"
  | "alias_name_mismatch";

export interface ReviewItem {
  uid: string;
  name: string;
  reason: ReviewReason;
  candidates: Array<{ physician_id: string; physician_name: string }>;
  disabled: boolean;
}

export interface Coverage {
  active_physicians: number;
  linked_physicians: number;
  directory_doctors: number;
  directory_linked: number;
  physician_percent: number;
  directory_percent: number;
}

export interface MappingResult {
  auto: AutoLink[];
  review: ReviewItem[];
  unmatched: Array<{ uid: string; name: string; disabled: boolean }>;
  already_linked: number;
  /** Physicians already linked whose recorded alias list differs from the directory's. */
  alias_updates: Array<{ physician_id: string; uid: string; alias_uids: string[] }>;
  coverage: { before: Coverage; after: Coverage };
}

/** Order-independent name key. Same recipe as CDMSS `normalizeDoctorName`. */
export function nameTokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "dr")
    .sort();
}

export function normalizeName(name: string): string {
  return nameTokens(name).join(" ");
}

/** Last 4 digits of a phone number, or null. Never more than 4 digits leave this function. */
export function last4(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

/** Tolerant parse of the directory response. Rows without a uid or a name are dropped. */
export function parseDirectory(raw: unknown): DirectoryDoctor[] {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const rows = Array.isArray(root?.doctors) ? (root!.doctors as unknown[]) : [];
  const out: DirectoryDoctor[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const uid = typeof o.doctor_uid === "string" ? o.doctor_uid.trim() : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!uid || !name || seen.has(uid)) continue;
    seen.add(uid);
    const aliases = Array.isArray(o.alias_uids)
      ? Array.from(new Set(o.alias_uids.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim())))
          .filter((a) => a !== uid)
          .sort()
      : [];
    const m = typeof o.mobile_last4 === "string" ? o.mobile_last4.replace(/\D/g, "") : "";
    const aliasNames: Record<string, string> = {};
    const rawNames = o.alias_names;
    if (rawNames && typeof rawNames === "object" && !Array.isArray(rawNames)) {
      for (const [k, v] of Object.entries(rawNames as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) aliasNames[k.trim()] = v.trim();
      }
    }
    if (Array.isArray(o.aliases)) {
      for (const a of o.aliases) {
        const ao = a && typeof a === "object" ? (a as Record<string, unknown>) : null;
        if (ao && typeof ao.doctor_uid === "string" && typeof ao.name === "string" && ao.name.trim()) {
          aliasNames[ao.doctor_uid.trim()] = ao.name.trim();
        }
      }
    }
    out.push({
      doctor_uid: uid,
      name,
      mobile_last4: m.length === 4 ? m : null,
      alias_uids: aliases,
      ...(Object.keys(aliasNames).length > 0 ? { alias_names: aliasNames } : {}),
      disabled: o.disabled === true,
    });
  }
  return out;
}

/** Aliases of this doctor whose identity the directory proves (a name that matches the canonical's). */
export function provenAliases(d: DirectoryDoctor): string[] {
  const want = normalizeName(d.name);
  return d.alias_uids.filter((a) => {
    const n = d.alias_names?.[a];
    return !!n && normalizeName(n) === want;
  });
}

function coverage(
  physicians: PhysicianRow[],
  directory: DirectoryDoctor[],
  linkedUids: Set<string>,
  linkedPhysicianIds: Set<string>,
): Coverage {
  const linkedPhys = physicians.filter((p) => linkedPhysicianIds.has(p.id)).length;
  const dirLinked = directory.filter((d) => linkedUids.has(d.doctor_uid)).length;
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
  return {
    active_physicians: physicians.length,
    linked_physicians: linkedPhys,
    directory_doctors: directory.length,
    directory_linked: dirLinked,
    physician_percent: pct(linkedPhys, physicians.length),
    directory_percent: pct(dirLinked, directory.length),
  };
}

/** PURE. Match the directory against the active physicians. Writes nothing. */
export function matchDirectory(directory: DirectoryDoctor[], physicians: PhysicianRow[]): MappingResult {
  const sortedDir = [...directory].sort((a, b) => a.doctor_uid.localeCompare(b.doctor_uid));
  const dirByUid = new Map(sortedDir.map((d) => [d.doctor_uid, d]));
  const aliasToCanonical = new Map<string, string>();
  for (const d of sortedDir) for (const a of d.alias_uids) if (!dirByUid.has(a)) aliasToCanonical.set(a, d.doctor_uid);

  // ---- who is already linked, directly or through an alias ----
  const linkedUidsBefore = new Set<string>();
  const linkedPhysBefore = new Set<string>();
  const handled = new Set<string>(); // directory uids resolved by an existing link
  const autoLinks: AutoLink[] = [];
  const aliasUpdates: MappingResult["alias_updates"] = [];
  const review: ReviewItem[] = [];
  let alreadyLinked = 0;

  for (const p of physicians) {
    const uid = p.cdmss_doctor_uid;
    if (!uid) continue;
    linkedPhysBefore.add(p.id);
    linkedUidsBefore.add(uid);
    const canonical = dirByUid.has(uid) ? uid : aliasToCanonical.get(uid);
    if (!canonical) {
      alreadyLinked += 1; // linked to a uid the directory no longer lists: leave it alone
      continue;
    }
    const d = dirByUid.get(canonical)!;
    const sameName = normalizeName(p.full_name) === normalizeName(d.name);
    if (canonical !== uid && !sameName) {
      // The directory says this uid was collapsed into another doctor's, but the names differ
      // (e.g. two doctors on a shared phone). Never move them; a person decides. They keep their
      // link, and the canonical doctor stays free to be matched on its own name.
      alreadyLinked += 1;
      review.push({
        uid: d.doctor_uid,
        name: d.name,
        reason: "alias_name_mismatch",
        candidates: [{ physician_id: p.id, physician_name: p.full_name }],
        disabled: d.disabled,
      });
      continue;
    }
    handled.add(canonical);
    linkedUidsBefore.add(canonical);
    if (canonical !== uid) {
      // Linked through an alias under a matching name: move to the canonical uid and keep the old
      // one recorded as a (proven) alias.
      const aliases = Array.from(new Set([...provenAliases(d), uid])).sort();
      autoLinks.push({
        uid: canonical,
        name: d.name,
        physician_id: p.id,
        physician_name: p.full_name,
        reason: "alias_relink",
        alias_uids: aliases,
        disabled: d.disabled,
      });
      continue;
    }
    alreadyLinked += 1;
    if (!sameName) continue; // an existing link under a different name: leave it and its aliases alone
    // Keep aliases already on record that the directory still lists, plus newly proven ones.
    const kept = (p.cdmss_alias_uids ?? []).filter((a) => d.alias_uids.includes(a));
    const proven = Array.from(new Set([...kept, ...provenAliases(d)])).sort();
    const have = [...(p.cdmss_alias_uids ?? [])].sort().join("|");
    if (have !== proven.join("|")) {
      aliasUpdates.push({ physician_id: p.id, uid: canonical, alias_uids: proven });
    }
  }

  // ---- match the rest by name (+ mobile) ----
  const unlinked = physicians.filter((p) => !p.cdmss_doctor_uid);
  const physByKey = new Map<string, PhysicianRow[]>();
  for (const p of unlinked) {
    const k = normalizeName(p.full_name);
    if (!k) continue;
    (physByKey.get(k) ?? physByKey.set(k, []).get(k)!).push(p);
  }
  const linkedByKey = new Map<string, PhysicianRow[]>();
  for (const p of physicians) {
    if (!p.cdmss_doctor_uid) continue;
    const k = normalizeName(p.full_name);
    (linkedByKey.get(k) ?? linkedByKey.set(k, []).get(k)!).push(p);
  }

  const pending = sortedDir.filter((d) => !handled.has(d.doctor_uid));
  const dirByKey = new Map<string, DirectoryDoctor[]>();
  for (const d of pending) {
    const k = normalizeName(d.name);
    (dirByKey.get(k) ?? dirByKey.set(k, []).get(k)!).push(d);
  }

  const unmatched: MappingResult["unmatched"] = [];
  const cand = (ps: PhysicianRow[]) =>
    ps.map((p) => ({ physician_id: p.id, physician_name: p.full_name })).sort((a, b) => a.physician_id.localeCompare(b.physician_id));
  const pushAuto = (d: DirectoryDoctor, p: PhysicianRow, reason: AutoReason) =>
    autoLinks.push({
      uid: d.doctor_uid,
      name: d.name,
      physician_id: p.id,
      physician_name: p.full_name,
      reason,
      alias_uids: provenAliases(d),
      disabled: d.disabled,
    });

  for (const d of pending) {
    const key = normalizeName(d.name);
    const sameName = dirByKey.get(key) ?? [d];
    const phys = physByKey.get(key) ?? [];
    const dMobile = d.mobile_last4;

    if (phys.length === 0) {
      const linkedSameName = linkedByKey.get(key) ?? [];
      if (linkedSameName.length > 0) {
        review.push({ uid: d.doctor_uid, name: d.name, reason: "linked_to_other_uid", candidates: cand(linkedSameName), disabled: d.disabled });
        continue;
      }
      // Weaker evidence: a partial name (token subset, at least two shared tokens). Review only.
      const dTok = nameTokens(d.name);
      const partial = unlinked.filter((p) => {
        const pTok = nameTokens(p.full_name);
        const shared = pTok.filter((t) => dTok.includes(t)).length;
        const subset = shared === pTok.length || shared === dTok.length;
        return shared >= 2 && subset;
      });
      if (partial.length > 0) {
        review.push({ uid: d.doctor_uid, name: d.name, reason: "partial_name", candidates: cand(partial), disabled: d.disabled });
      } else {
        unmatched.push({ uid: d.doctor_uid, name: d.name, disabled: d.disabled });
      }
      continue;
    }

    if (phys.length === 1 && sameName.length === 1) {
      const p = phys[0];
      const pMobile = last4(p.phone);
      if (dMobile && pMobile && dMobile !== pMobile) {
        review.push({ uid: d.doctor_uid, name: d.name, reason: "mobile_mismatch", candidates: cand(phys), disabled: d.disabled });
      } else {
        pushAuto(d, p, dMobile && pMobile ? "name_and_mobile" : "exact_unique_name");
      }
      continue;
    }

    // Several people share this name key: the mobile must pick exactly one on each side.
    if (dMobile) {
      const byMobile = phys.filter((p) => last4(p.phone) === dMobile);
      const dirSameMobile = sameName.filter((x) => x.mobile_last4 === dMobile);
      if (byMobile.length === 1 && dirSameMobile.length === 1) {
        pushAuto(d, byMobile[0], "name_and_mobile");
        continue;
      }
    }
    review.push({ uid: d.doctor_uid, name: d.name, reason: "ambiguous_name", candidates: cand(phys), disabled: d.disabled });
  }

  // Safety: one physician may be the auto target of at most one directory doctor.
  const byPhysician = new Map<string, AutoLink[]>();
  for (const a of autoLinks) (byPhysician.get(a.physician_id) ?? byPhysician.set(a.physician_id, []).get(a.physician_id)!).push(a);
  const finalAuto: AutoLink[] = [];
  for (const [physicianId, links] of Array.from(byPhysician.entries())) {
    const distinctUids = new Set(links.map((l) => l.uid));
    if (distinctUids.size === 1) {
      finalAuto.push(links[0]);
      continue;
    }
    for (const l of links) {
      review.push({
        uid: l.uid,
        name: l.name,
        reason: "physician_claimed_twice",
        candidates: [{ physician_id: physicianId, physician_name: l.physician_name }],
        disabled: l.disabled,
      });
    }
  }
  finalAuto.sort((a, b) => a.uid.localeCompare(b.uid));
  review.sort((a, b) => a.uid.localeCompare(b.uid));
  unmatched.sort((a, b) => a.uid.localeCompare(b.uid));

  const afterUids = new Set(linkedUidsBefore);
  const afterPhys = new Set(linkedPhysBefore);
  for (const a of finalAuto) {
    afterUids.add(a.uid);
    afterPhys.add(a.physician_id);
  }

  return {
    auto: finalAuto,
    review,
    unmatched,
    already_linked: alreadyLinked,
    alias_updates: aliasUpdates,
    coverage: {
      before: coverage(physicians, sortedDir, linkedUidsBefore, linkedPhysBefore),
      after: coverage(physicians, sortedDir, afterUids, afterPhys),
    },
  };
}
