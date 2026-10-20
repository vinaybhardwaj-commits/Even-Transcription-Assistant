"""ft-lexical shared helpers: load corpora + labels, tokenizer (any script: letters + combining marks), admin mask, stats."""
import json, os, re, unicodedata, functools
import numpy as np, pandas as pd
from scipy import stats

H = os.path.expanduser
W = H('~/eta-data/forest/ft-lexical'); OUT = H('~/oc/forest-lead/ft/out/ft-lexical')
LABELS = ('ale', 'h14', 'h90')
ROLE_OK = {'lexicon', 'lexicon_weak'}                 # R role-specific results
K_ROLE_OK = {'llm-roles', 'text-judge', 'caa-labels', 'sarvam-doctor-map'}


def k_role_ok(it):
    """consult speaker cells: role source usable AND not one ft-audio marked caa-weak (< 0.5 labelled share; refute F6)."""
    return it['role_src_k'] in K_ROLE_OK and it.get('feat_role_src') != 'caa-weak'

# admin talk: pre-authorisation, insurance, payment, booking (English + common native-script spellings Sarvam writes for these English words)
ADMIN = re.compile('|'.join([
    r'insur', r'\btpa\b', r'cashless', r'cash less', r'\bclaim', r'pre.?auth', r'approv', r'\bpolicy', r'payment', r'\bpay\b', r'\bpaid\b', r'advance',
    r'deposit', r'amount', r'rupee', r'\brs\b', r'₹', r'package', r'estimat', r'\bcost', r'\bprice', r'\bfees?\b', r'\bbill', r'thousand', r'lakh', r'discount',
    r'\bbook', r'admission', r'\badmit', r'\bslot', r'\bdate\b', r'schedul', r'\bot\b', r'\bcard\b', r'\bscheme', r'ayushman', r'\bupi\b', r'\bgpay', r'phonepe',
    r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>',
    r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>',
    r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>',
    r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>', r'<native-redacted>',
]), re.I)


@functools.lru_cache(maxsize=None)
def _ok(ch):
    c = unicodedata.category(ch)
    return c[0] in 'LM' or ch == "'"


def tokens(text):
    t = ''.join(ch if _ok(ch) else ' ' for ch in (text or '').lower())
    return [w.strip("'") for w in t.split() if w.strip("'")]


def ngrams(tok, nmax=3):
    out = list(tok)
    for n in range(2, nmax + 1):
        out += [' '.join(tok[i:i + n]) for i in range(len(tok) - n + 1)]
    return out


def items():
    return [json.loads(l) for l in open(f'{W}/items.jsonl')]


def units():
    return pd.read_parquet(f'{W}/units.parquet')


def label_map(U, label, kind):
    """unit_id -> 0/1. Episodes: cohort P (amb_hash dropped). Consults: as FT4."""
    u = U[(U.kind == kind)]
    if kind == 'episode': u = u[~u.amb_hash.fillna(False).astype(bool)]
    u = u[u[label].notna()]
    return dict(zip(u.unit_id, u[label].astype(int)))


def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def fisher(a, n1, b, n0):
    return stats.fisher_exact([[a, n1 - a], [b, n0 - b]])[1]


def bh(p):
    p = np.asarray(p, float); n = len(p); o = np.argsort(p); q = np.empty(n)
    r = p[o] * n / np.arange(1, n + 1); q[o] = np.minimum.accumulate(r[::-1])[::-1]
    return np.minimum(q, 1)


def pct(k, n):
    lo, hi = wilson(k, n)
    return f'{k}/{n} ({100 * k / n:.0f}% [{100 * lo:.0f}-{100 * hi:.0f}])' if n else '0/0'
