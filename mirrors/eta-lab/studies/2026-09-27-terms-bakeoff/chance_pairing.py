"""W50 terms bake-off: chance-hit guard (refuter-2, bus #4878), pre-registered before STEP 2.

Once false_drug_rate stops gating (ADDENDUM-4's proposal), drug_hit is the ONLY entry-rule signal, and it uses the same
detector whose decoy false-positive rate is ~12pp on short utterances (ADDENDUM-4's E1) - likely higher on set (c)'s
multi-minute consult windows. A verbose or hallucinating engine could raise its apparent drug_hit purely by emitting
many drug-like words that happen to fuzzy-match SOME truth drug somewhere, without actually understanding the consult.

Fix: for every linked consult, assign a FIXED "chance partner" - another linked consult, same day, a DIFFERENT room
(so genuinely unrelated: different patient, different visit), that has at least one truth drug group. Score each
engine's transcript for consult C against partner(C)'s truth groups too: any "hit" there is by construction not real
signal (C's patient was never discussed in relation to partner(C)'s drugs), so it estimates how often this detector
fires on a transcript of this length/content by pure chance. Entry rule becomes bootstrap CI on
(drug_hit - chance_hit), not raw drug_hit.

Pairing algorithm (fully deterministic, no randomness/seed needed - a fixed rule, not a fixed random draw): sort a
day's linked consults by consult_id; for consult at position i, walk forward (wrapping) to the nearest OTHER position
whose room differs AND whose truth groups are not ENTIRELY absorbed by consult i's own truth groups (i.e.
partner_truth - own_truth is non-empty, so the chance-hit rate this pairing produces is always well-defined per C1's
exclusion rule); that is partner(i). This "next partner in the walk" fallback (refuter-3, bus #4889, #4887) is what
makes the rule total even though, verified on the real 22/23/24 Sep set, it is never actually NEEDED there: 0/49
drug-having consults have their nearest qualifying-by-room partner degenerate this way (5/49 partners share ONE common
drug with their consult but always have at least one OTHER, non-shared drug too) - the fallback exists for
correctness/robustness against a future re-link or a different day's data, not because today's data needs it.
Covers all 99 linked consults, 0 gaps (every day has 6-7 rooms, so a same-day different-room drug-having partner
always exists close by).

Public API:
  build_chance_pairs(consults, truth_groups) -> {(day, consult_id): (day, partner_consult_id)}
    consults: iterable of (day, consult_id, room)
    truth_groups: {(day, consult_id): set(group_key)} for consults that have >=1 truth drug group
"""


def build_chance_pairs(consults, truth_groups):
    by_day = {}
    for day, cid, room in consults:
        by_day.setdefault(day, []).append((cid, room))

    pairs = {}
    for day, items in by_day.items():
        items_sorted = sorted(items, key=lambda x: x[0])
        n = len(items_sorted)
        for i in range(n):
            cid_i, room_i = items_sorted[i]
            own_truth = truth_groups.get((day, cid_i), set())
            partner = None
            for step in range(1, n):
                j = (i + step) % n
                cid_j, room_j = items_sorted[j]
                if room_j == room_i:
                    continue
                partner_truth = truth_groups.get((day, cid_j))
                if partner_truth and (partner_truth - own_truth):
                    partner = (day, cid_j)
                    break
            pairs[(day, cid_i)] = partner
    return pairs
