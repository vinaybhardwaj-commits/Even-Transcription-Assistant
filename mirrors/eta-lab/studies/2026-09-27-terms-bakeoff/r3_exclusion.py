"""R3/W51 blind room-day exclusion for set (c) (Fable ruling #6688: transcribing them counts as use).
List = excluded_room_days_union (manoj_session_list.json f07171dc) as given by vj-refuter #6712; only the two
23 Sep entries intersect set (c) (verified by eta-refuter-3 #6721). Shared by the baseline driver and the
candidate launchers so they cannot disagree."""

EXCLUDED_ROOM_DAYS = frozenset(
    [("room_qyzghzaf", d) for d in ("2026-08-23", "2026-09-15", "2026-09-18", "2026-09-20", "2026-09-23", "2026-09-28")]
    + [("room_ux92qpws", d) for d in ("2026-09-13", "2026-09-14", "2026-09-16", "2026-09-19", "2026-09-20",
                                      "2026-09-26", "2026-09-28")]
    + [("room_4ggnkg5x", "2026-09-23")]
)
SET_C_TOTAL = 87
SET_C_EXCLUDED = 11


def is_excluded(stub):
    return (stub["room_id"], stub["ist_date"]) in EXCLUDED_ROOM_DAYS


def filter_excluded(windows):
    """-> (kept, n_excluded). Fails loudly if set (c) is not exactly 87 windows with 11 excluded."""
    n_excluded = sum(1 for w in windows if is_excluded(w["manifest_stub"]))
    if len(windows) != SET_C_TOTAL or n_excluded != SET_C_EXCLUDED:
        raise RuntimeError(
            f"set (c) changed: {len(windows)} windows / {n_excluded} excluded, expected "
            f"{SET_C_TOTAL} / {SET_C_EXCLUDED} - refusing, re-review the exclusion"
        )
    return [w for w in windows if not is_excluded(w["manifest_stub"])], n_excluded
