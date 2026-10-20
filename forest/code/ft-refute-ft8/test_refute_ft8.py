"""Refuter tests (Opus 5.5) for FT8. Independent of the lane code: reads the raw pulls, labels D and the target parquet.
The cutoff checker must FAIL on any record at or after the cutoff (age_d <= 0) and on a record with no real date
(1970-01-01 sentinel, i.e. age_d > SENTINEL_AGE_D)."""
import os, sys
import numpy as np, pandas as pd, pytest
H = os.path.expanduser('~')
sys.path.insert(0, f'{H}/oc/forest-lead/ft'); import ftio
TARGET = f'{H}/oc/forest-lead/ft/out/ft8-clinical/features_ft8.parquet'
AUDIT = f'{H}/oc/forest-lead/ft/out/ft8-clinical/features_ft8_audit.parquet'
LABELS = f'{H}/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
SENTINEL_AGE_D = 15000   # result_date 1970-01-01 => age ~20,000 d; real dated records here are <= ~1,100 d
LABS = ['hba1c', 'hb', 'creat', 'egfr', 'tsh']


class Leak(AssertionError):
    pass


def check_records(rx_date, rec_date, what):
    """rx_date, rec_date: aligned datetime Series of USED records. Raises Leak on any rec_date >= rx_date (day level)
    or on an undatable record (sentinel)."""
    rx = pd.to_datetime(rx_date).dt.normalize(); d = pd.to_datetime(rec_date)
    used = d.notna()
    at_after = used & (d.dt.normalize() >= rx)
    sentinel = used & (d.dt.year <= 1971)
    if at_after.any() or sentinel.any():
        raise Leak(f'{what}: at/after cutoff={int(at_after.sum())} undatable={int(sentinel.sum())}')


def check_blocks_dated(audit, used_blocks):
    """A block that is used but carries no per-record date cannot be proven pre-cutoff."""
    nd = [b for b, used in used_blocks.items() if used.any() and audit[f'src_max_date_{b}'].isna().loc[used].all()]
    if nd:
        raise Leak(f'blocks used with no source date: {nd}')


@pytest.fixture(scope='module')
def data():
    L = pd.read_parquet(LABELS, filters=[('split', '=', 'D')])
    B = pd.DataFrame(ftio.read_export(f'{H}/eta-data/forest/ft8/ft8-pull-b.tsv'))
    B['age_d'] = B.age_d.astype(int)
    B = B.merge(L[['prescription_uid', 'episode_id', 'rx_date']], on='prescription_uid')
    B['rec_date'] = B.rx_date - pd.to_timedelta(B.age_d, 'D')
    return L, B, pd.read_parquet(TARGET), pd.read_parquet(AUDIT)


# --- the checker itself must fail on the mutants ------------------------------------------------
@pytest.mark.parametrize('delta', [0, 1, 30])
def test_checker_fails_on_record_at_or_after_cutoff(delta):
    rx = pd.Series(pd.to_datetime(['2026-03-10', '2026-03-10']))
    with pytest.raises(Leak):
        check_records(rx, pd.Series([rx[0] - pd.Timedelta(days=5), rx[1] + pd.Timedelta(days=delta)]), 'mutant')


def test_checker_fails_on_same_day_earlier_timestamp():
    rx = pd.Series(pd.to_datetime(['2026-03-10']))          # Rx day; a record at 09:00 that day is AT the cutoff
    with pytest.raises(Leak):
        check_records(rx, pd.Series(pd.to_datetime(['2026-03-10 09:00'])), 'same-day')


def test_checker_fails_on_sentinel_date():
    with pytest.raises(Leak):
        check_records(pd.Series(pd.to_datetime(['2026-03-10'])), pd.Series(pd.to_datetime(['1970-01-01'])), 'sentinel')


def test_checker_passes_day_before():
    assert check_records(pd.Series(pd.to_datetime(['2026-03-10'])), pd.Series(pd.to_datetime(['2026-03-09 23:59'])), 'ok') is None


def test_block_checker_fails_on_undated_block():
    a = pd.DataFrame({'src_max_date_util': [pd.NaT, pd.NaT]})
    with pytest.raises(Leak):
        check_blocks_dated(a, {'util': pd.Series([True, False])})


# --- the target, checked with the checker ------------------------------------------------------
def test_target_labs_used_are_pre_cutoff_and_dated(data):
    """EXPECTED TO FAIL on 95df8ba1bfd9: 1970-01-01 result dates are used (undatable)."""
    L, B, T, A = data
    for lab in LABS:
        used = T.set_index('episode_id')[f'ft8_has_{lab}']
        x = B[(B.lab == lab) & B.episode_id.map(used).eq(1)]
        check_records(x.rx_date, x.rec_date, lab)


def test_target_audit_dates_pre_cutoff(data):
    L, B, T, A = data
    for c in [c for c in A.columns if c.startswith('src_max_date_')]:
        check_records(A.rx_date, A[c], c)


def test_target_aggregate_blocks_dated(data):
    """EXPECTED TO FAIL: util/icd/ip/meds are used but carry no per-record date (timestamp-cut aggregates)."""
    L, B, T, A = data
    used = {'util': T.ft8_has_prior_rx.eq(1), 'icd': T.ft8_has_icd.eq(1), 'ip': T.ft8_n_ip_events_pre.gt(0),
            'meds': T.ft8_has_meds.eq(1)}
    check_blocks_dated(A, used)


def test_target_d_only_and_keys(data):
    L, B, T, A = data
    sys.path.insert(0, f'{H}/oc/forest-lead/ft/vendor_split'); import split_guard
    assert split_guard.PINNED_LIST_SHA256.startswith('52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
    g = split_guard.load()
    ck = T.episode_id.map(L.set_index('episode_id').cluster_key)
    assert ck.notna().all() and (ck.map(g.set_of) == 'D').all()
    g.require_dev(list(ck))
    assert len(T) == 1233 and T.episode_id.is_unique and set(T.episode_id) == set(L.episode_id)


def test_target_matches_refuter_rebuild(data):
    L, B, T, A = data
    R = pd.read_parquet(os.path.join(os.path.dirname(__file__), 'refuter_ft8_day.parquet')).set_index('episode_id')
    T = T.set_index('episode_id').loc[R.index]
    for lab in LABS:
        assert np.allclose(R[lab], T[f'ft8_{lab}'], equal_nan=True) and np.allclose(R[f'{lab}_age_d'], T[f'ft8_{lab}_age_d'], equal_nan=True)
    for r, t in [('has_prior_rx', 'ft8_has_prior_rx'), ('has_icd', 'ft8_has_icd'), ('sbp', 'ft8_sbp'), ('n_prior_rx_12m', 'ft8_n_prior_rx_12m'),
                 ('n_meds', 'ft8_n_meds_latest_prior_rx'), ('dm', 'ft8_dm'), ('htn', 'ft8_htn')]:
        assert np.allclose(R[r].astype(float), T[t].astype(float), equal_nan=True), r


# --- v3 delta: the builder's own assert_cutoff must not be vacuous (mutants on the REAL v3 audit) -----------
@pytest.fixture(scope='module')
def fb():
    sys.path.insert(0, f'{H}/oc/forest-lead/ft/out/ft8-clinical/code'); import ft8_build
    return ft8_build


@pytest.mark.parametrize('blk', ['util', 'icd', 'ip', 'meds', 'comorb', 'bp', 'hba1c'])
@pytest.mark.parametrize('mut', ['rx_day', 'rx_day_plus1', 'sentinel', 'missing'])
def test_builder_assert_cutoff_catches_mutant(fb, data, blk, mut):
    L, B, T, A = data
    assert fb.assert_cutoff(A)                                   # clean v3 audit passes
    M = A.copy(); used = M.index[M[f'used_{blk}'].astype(bool)]; i = used[0]
    M[f'src_max_date_{blk}'] = pd.to_datetime(M[f'src_max_date_{blk}'])
    M.loc[i, f'src_max_date_{blk}'] = {'rx_day': M.loc[i, 'rx_date'], 'rx_day_plus1': M.loc[i, 'rx_date'] + pd.Timedelta(days=1),
                                       'sentinel': pd.Timestamp('1970-01-01'), 'missing': pd.NaT}[mut]
    with pytest.raises(AssertionError):
        fb.assert_cutoff(M)


def test_v3_no_sentinel_lab_used(data):
    L, B, T, A = data
    ep = set(B.loc[B.age_d > SENTINEL_AGE_D, 'episode_id'])
    Ti = T.set_index('episode_id')
    for lab in LABS:
        x = B[(B.lab == lab) & (B.age_d > SENTINEL_AGE_D)]
        assert Ti.loc[x.episode_id, f'ft8_has_{lab}'].eq(0).all(), lab
    assert len(ep) == 24
