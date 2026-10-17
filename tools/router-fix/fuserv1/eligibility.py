#!/usr/bin/env python3
"""FUSER v1 step 2: TEST-eligibility check for a fused.v0 track (Fable 14:50, per lid-debug #4716 --
lives in step-2 code, NOT in the frozen fuser_v0.py/v0 pin, so it needs no new v0 addendum).

Per eta-refuter-2 #4724: defined on FIELDS IN THE TRACK ONLY, never on stderr logs (a
REB_LIB_PATH_PIN or ETA_FUSER_ALLOW_DIRTY_CODE override is only visible on stderr at run time, not to
a consumer reading the written track later) -- so the reb pin AND the v0 pin are re-checked against
values baked into config, not inferred from the absence of a log line or "any clean sha" (eta-refuter-2
#4734 E1: a track from a later, unfrozen v0 commit is clean but not the frozen one).

A fused.v0 track is usable for a DEV-to-TEST decision or for TEST S1/S2 only if:
  - config['fuser_code_sha'] EQUALS the frozen v0 pin (V0_LIB_PIN below), not just "any 40-hex sha".
  - config['fuser_code_dirty'] is exactly False.
  - config['reb_sha'] equals the frozen reb pin (REB_LIB_PIN below).
  - config['etr_enabled'] matches the arm the caller expects (V0 = True, V0-noETR = False, per
    ADDENDUM-1 A1) -- REQUIRED, not optional (eta-refuter-2 #4734 E2: an omitted expectation must not
    let a caller silently skip the arm check). Use eligibility_dev_only() for the rare case of
    checking a track before its arm is decided.
"""
REB_LIB_PIN = "a447dc367d6ba825c9fe63b78fee7a9652bb3988"       # step-1 freeze (ADDENDUM-3 8640dea9fd13)
V0_LIB_PIN = "c403e9b6a8f1f2b35c9197fe11f8bd369020d89c"        # step-1 freeze (ADDENDUM-3 8640dea9fd13)


def eligibility(track_config, expected_etr_enabled: bool) -> tuple[bool, list[str]]:
    """(usable, reasons). reasons is empty iff usable is True. Never raises, even on a malformed
    (non-dict) config (eta-refuter-2 #4734 E3): an eligibility check that can crash on bad input is
    worse than one that fails closed with a reason."""
    if not isinstance(track_config, dict):
        return False, [f"track_config is not a dict: {type(track_config).__name__}"]
    reasons = []
    sha = track_config.get("fuser_code_sha")
    if sha != V0_LIB_PIN:
        reasons.append(f"fuser_code_sha is {sha!r}, not the frozen v0 pin {V0_LIB_PIN}")
    if track_config.get("fuser_code_dirty") is not False:
        reasons.append(f"fuser_code_dirty is not False: {track_config.get('fuser_code_dirty')!r}")
    if track_config.get("reb_sha") != REB_LIB_PIN:
        reasons.append(f"reb_sha is {track_config.get('reb_sha')!r}, not the frozen pin {REB_LIB_PIN}")
    if track_config.get("etr_enabled") is not expected_etr_enabled:
        reasons.append(f"etr_enabled is {track_config.get('etr_enabled')!r}, expected {expected_etr_enabled!r}")
    return (len(reasons) == 0, reasons)


def is_eligible(track_config, expected_etr_enabled: bool) -> bool:
    return eligibility(track_config, expected_etr_enabled)[0]


def eligibility_dev_only(track_config) -> tuple[bool, list[str]]:
    """Same checks EXCEPT the arm match -- for the rare case of inspecting a track before its arm is
    decided. Named _dev_only so it can never be reached by omitting expected_etr_enabled on the real
    check (eta-refuter-2 #4734 E2)."""
    if not isinstance(track_config, dict):
        return False, [f"track_config is not a dict: {type(track_config).__name__}"]
    ok, reasons = eligibility(track_config, expected_etr_enabled=track_config.get("etr_enabled"))
    return ok, [r for r in reasons if "etr_enabled" not in r]
