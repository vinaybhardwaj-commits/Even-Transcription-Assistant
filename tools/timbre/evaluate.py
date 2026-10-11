"""Gold-set metrics for a Timbre labels CSV.

Intra-rater agreement on hidden repeats, CCC and Spearman for arousal and
valence, and a room-day grouped cross-validated logistic head (flags) plus a
ridge head (arousal/valence from embeddings). Rows with ``not_patient`` or
``unusable`` set are excluded from those metrics.

``outcome_linkage`` joins a separate outcomes CSV (accept/defer, unresolved
doubts). If that CSV also carries ``text_score`` and ``voice_score``, it
reports the two AUROCs and their difference. That is a descriptive hook, not
the pre-registered T-8 likelihood-ratio test.

``--fusion`` is opt-in. It compares voice-only, text-only, and late-fused
heads on the same room-day GroupKFold: ridge for arousal and valence, logistic
for the flags, over voice dimensions concatenated with Jev text dimensions.
The default report is unchanged when the flag is absent.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

FLAG_TARGETS = ("engaged", "anxious", "resistant", "words_ne_tone")
FLAG_ALIASES = {
    "engaged": ("engaged",),
    "anxious": ("anxious",),
    "resistant": ("resistant",),
    "words_ne_tone": ("words_ne_tone", "words_tone_mismatch"),
    "not_patient": ("not_patient",),
    "unusable": ("unusable",),
}
_TRUE = {"1", "true", "yes", "y", "t"}
_FALSE = {"0", "false", "no", "n", "f", ""}


class EvalError(ValueError):
    pass


def concordance_ccc(x, y) -> float | None:
    """Lin's concordance correlation, population variances (divisor n)."""
    a = np.asarray(x, dtype=np.float64).reshape(-1)
    b = np.asarray(y, dtype=np.float64).reshape(-1)
    if a.shape != b.shape:
        raise EvalError("ccc inputs differ in length")
    m = np.isfinite(a) & np.isfinite(b)
    a, b = a[m], b[m]
    if a.size < 2:
        return None
    mx, my = float(a.mean()), float(b.mean())
    vx = float(np.mean((a - mx) ** 2))
    vy = float(np.mean((b - my) ** 2))
    cov = float(np.mean((a - mx) * (b - my)))
    den = vx + vy + (mx - my) ** 2
    if den <= 0.0:
        return None
    return (2.0 * cov) / den


def spearman(x, y) -> float | None:
    from scipy.stats import spearmanr

    a = np.asarray(x, dtype=np.float64).reshape(-1)
    b = np.asarray(y, dtype=np.float64).reshape(-1)
    m = np.isfinite(a) & np.isfinite(b)
    a, b = a[m], b[m]
    if a.size < 2 or np.unique(a).size < 2 or np.unique(b).size < 2:
        return None
    res = spearmanr(a, b)
    val = float(res.statistic)
    if not np.isfinite(val):
        return None
    return val


def load_labels(path: Path | str) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    if "window_id" not in df.columns:
        raise EvalError("labels CSV missing window_id")
    out = df.copy()
    for flag, aliases in FLAG_ALIASES.items():
        out[flag] = [_flag_from_row(rec, aliases) for rec in out.to_dict(orient="records")]
    if "is_repeat" not in out.columns:
        out["is_repeat"] = False
    else:
        out["is_repeat"] = [_as_bool(v) for v in out["is_repeat"]]
    for dim in ("arousal", "valence"):
        if dim not in out.columns:
            out[dim] = np.nan
        else:
            out[dim] = pd.to_numeric(out[dim], errors="coerce")
    if "room" not in out.columns:
        out["room"] = ""
    if "date" not in out.columns:
        out["date"] = ""
    out["room_day"] = [f"{r}|{d}" if (r or d) else str(w) for r, d, w in zip(out["room"], out["date"], out["window_id"])]
    return out


def usable_mask(df: pd.DataFrame) -> pd.Series:
    return ~(df["not_patient"].astype(bool) | df["unusable"].astype(bool))


def intra_rater(df: pd.DataFrame) -> dict:
    """Quadratic weighted kappa, Spearman and CCC between a primary row and its hidden repeat."""
    from sklearn.metrics import cohen_kappa_score

    prim, rep = _pairs(df)
    result = {"n_pairs": int(len(prim)), "arousal": {}, "valence": {}, "flags": {}}
    for dim in ("arousal", "valence"):
        a = prim[dim].to_numpy(dtype=np.float64) if len(prim) else np.array([])
        b = rep[dim].to_numpy(dtype=np.float64) if len(rep) else np.array([])
        result[dim] = {
            "ccc": concordance_ccc(a, b) if a.size else None,
            "spearman": spearman(a, b) if a.size else None,
            "quadratic_kappa": _kappa(a, b, cohen_kappa_score) if a.size else None,
            "exact_agreement": _exact(a, b),
        }
    for flag in FLAG_TARGETS:
        if not len(prim):
            result["flags"][flag] = {"agreement": None, "n": 0}
            continue
        aa = prim[flag].to_numpy(dtype=bool)
        bb = rep[flag].to_numpy(dtype=bool)
        result["flags"][flag] = {"agreement": float(np.mean(aa == bb)), "n": int(aa.size)}
    return result


def dimension_scores(gold_a, gold_v, pred_a, pred_v) -> dict:
    """CCC and Spearman. 0–1 model outputs are affinely mapped to 1–5 before CCC only."""
    pa = np.asarray(pred_a, dtype=np.float64).reshape(-1)
    pv = np.asarray(pred_v, dtype=np.float64).reshape(-1)
    scale = "raw"
    pa_ccc, pv_ccc = pa, pv
    if _looks_unit_interval(pa) and _looks_unit_interval(pv):
        pa_ccc, pv_ccc = 1.0 + 4.0 * pa, 1.0 + 4.0 * pv
        scale = "affine_0_1_to_1_5"
    return {
        "scale": scale,
        "n": int(np.sum(np.isfinite(gold_a) & np.isfinite(pa))),
        "arousal_ccc": concordance_ccc(gold_a, pa_ccc),
        "valence_ccc": concordance_ccc(gold_v, pv_ccc),
        "arousal_ccc_raw": concordance_ccc(gold_a, pa),
        "valence_ccc_raw": concordance_ccc(gold_v, pv),
        "arousal_spearman": spearman(gold_a, pa),
        "valence_spearman": spearman(gold_v, pv),
    }


def grouped_oof(X, y, groups, *, task: str, alpha: float = 1.0) -> np.ndarray:
    """Out-of-fold predictions. ``task`` is ``ridge`` or ``logistic``. NaN where a fold could not fit.

    ``alpha`` is the ridge penalty (standardised features). The logistic head ignores it.
    """
    from sklearn.linear_model import LogisticRegression, Ridge
    from sklearn.model_selection import GroupKFold
    from sklearn.preprocessing import StandardScaler

    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64).reshape(-1)
    groups = np.asarray(groups)
    if X.ndim != 2 or X.shape[0] != y.shape[0] or groups.shape[0] != y.shape[0]:
        raise EvalError("X, y and groups must share the row count")
    oof = np.full(y.shape[0], np.nan)
    finite_x = np.all(np.isfinite(X), axis=1)
    usable = finite_x & np.isfinite(y)
    idx = np.flatnonzero(usable)
    if idx.size < 4:
        return oof
    Xu, yu, gu = X[idx], y[idx], groups[idx]
    n_groups = int(pd.unique(gu).size)
    n_splits = min(5, n_groups)
    if n_splits < 2:
        return oof
    splitter = GroupKFold(n_splits=n_splits)
    local = np.full(idx.size, np.nan)
    for train, test in splitter.split(Xu, yu, gu):
        scaler = StandardScaler()
        Xtr = scaler.fit_transform(Xu[train])
        Xte = scaler.transform(Xu[test])
        if task == "logistic":
            if np.unique(yu[train]).size < 2:
                continue
            clf = LogisticRegression(max_iter=500, class_weight="balanced", random_state=0, solver="lbfgs")
            clf.fit(Xtr, yu[train].astype(int))
            local[test] = clf.predict(Xte).astype(np.float64)
        elif task == "ridge":
            reg = Ridge(alpha=float(alpha), random_state=0)
            reg.fit(Xtr, yu[train])
            local[test] = reg.predict(Xte)
        else:
            raise EvalError(f"unknown task {task}")
    oof[idx] = local
    return oof


def flag_macro_f1(X, flags: dict[str, np.ndarray], groups) -> dict:
    """Macro-F1 of a grouped-CV logistic head. One binary head per flag, pooled out of fold."""
    from sklearn.metrics import f1_score

    per = {}
    f1s = []
    for name, y in flags.items():
        pred = grouped_oof(X, np.asarray(y, dtype=np.float64), groups, task="logistic")
        m = np.isfinite(pred)
        if int(m.sum()) < 2 or np.unique(np.asarray(y)[m]).size < 2:
            per[name] = None
            continue
        score = float(f1_score(np.asarray(y)[m].astype(int), pred[m].astype(int), average="binary", zero_division=0))
        per[name] = score
        f1s.append(score)
    return {
        "macro_f1": float(np.mean(f1s)) if f1s else None,
        "per_flag": per,
        "n": int(np.asarray(next(iter(flags.values()))).shape[0]) if flags else 0,
    }


def outcome_linkage(labels: pd.DataFrame, outcomes: pd.DataFrame) -> dict:
    """Join on ``window_id``. Counts only, plus AUROC when scores are supplied."""
    from sklearn.metrics import roc_auc_score

    if "window_id" not in outcomes.columns or "decision" not in outcomes.columns:
        raise EvalError("outcomes CSV needs window_id and decision")
    lab = labels.copy()
    if "is_repeat" in lab.columns:
        lab = lab.loc[~lab["is_repeat"].astype(bool)].copy()
    out = outcomes.copy()
    out["decision_norm"] = out["decision"].astype(str).str.strip().str.lower()
    bad = ~out["decision_norm"].isin(["accept", "defer", ""])
    if bad.any():
        raise EvalError("decision must be accept or defer")
    merged = lab.merge(out, on="window_id", how="inner", suffixes=("", "_outcome"))
    decided = merged[merged["decision_norm"].isin(["accept", "defer"])]
    y = (decided["decision_norm"] == "accept").to_numpy(dtype=int)
    unresolved = None
    if "unresolved_doubts" in decided.columns:
        u = pd.to_numeric(decided["unresolved_doubts"], errors="coerce")
        unresolved = int(np.nansum(u.to_numpy(dtype=np.float64) > 0))
    report = {
        "n_labels": int(len(lab)),
        "n_outcomes": int(len(out)),
        "n_joined": int(len(merged)),
        "n_accept": int((decided["decision_norm"] == "accept").sum()),
        "n_defer": int((decided["decision_norm"] == "defer").sum()),
        "n_unresolved_nonzero": unresolved,
        "auroc_text": _auroc(y, decided, "text_score", roc_auc_score),
        "auroc_voice": _auroc(y, decided, "voice_score", roc_auc_score),
        "note": (
            "Descriptive association on supplied scores. Not the pre-registered "
            "T-8 likelihood-ratio test of text+voice against text alone."
        ),
    }
    vt, vv = report["auroc_text"], report["auroc_voice"]
    report["delta_auroc_voice_minus_text"] = None if vt is None or vv is None else float(vv - vt)
    return report


def comparison_table(labels: pd.DataFrame, features: pd.DataFrame, *, scalar_ridge: bool = False) -> pd.DataFrame:
    """One row per model found in ``features`` (columns prefixed by the model name).

    ``scalar_ridge`` adds a grouped-CV ridge head on a model's scalar feature columns when
    it has neither direct arousal/valence nor an embedding (openSMILE eGeMAPS / ComParE).
    """
    usable = labels.loc[usable_mask(labels) & ~labels["is_repeat"].astype(bool)].copy()
    joined = usable.merge(features, on="window_id", how="inner", suffixes=("", "_feat"))
    models = _models_in(features.columns)
    rows = []
    for name in models:
        rows.append(_one_model(name, joined, scalar_ridge=scalar_ridge))
    return pd.DataFrame(rows)


def evaluate(
    labels: pd.DataFrame,
    features: pd.DataFrame,
    outcomes: pd.DataFrame | None = None,
    *,
    scalar_ridge: bool = False,
    fusion_text: pd.DataFrame | None = None,
    voice_cols: list[str] | None = None,
    voice_model: str | None = None,
) -> dict:
    table = comparison_table(labels, features, scalar_ridge=scalar_ridge)
    report = {
        "n_labels": int(len(labels)),
        "n_usable_primary": int((usable_mask(labels) & ~labels["is_repeat"].astype(bool)).sum()),
        "intra_rater": intra_rater(labels),
        "models": table.to_dict(orient="records"),
        "outcomes": None if outcomes is None else outcome_linkage(labels, outcomes),
    }
    if fusion_text is not None:
        report["fusion"] = fusion_comparison(
            labels,
            features,
            fusion_text,
            voice_cols=voice_cols,
            voice_model=voice_model,
        )
    return report


def evaluate_files(
    labels_csv: Path | str,
    features_parquet: Path | str,
    outcomes_csv: Path | str | None = None,
    *,
    scalar_ridge: bool = False,
    text_scores: Path | str | None = None,
    voice_cols: list[str] | None = None,
    voice_model: str | None = None,
) -> dict:
    labels = load_labels(labels_csv)
    features = pd.read_parquet(features_parquet)
    outcomes = pd.read_csv(outcomes_csv, dtype=str, keep_default_na=False) if outcomes_csv else None
    fusion_text = load_text_scores(text_scores) if text_scores else None
    return evaluate(
        labels,
        features,
        outcomes,
        scalar_ridge=scalar_ridge,
        fusion_text=fusion_text,
        voice_cols=voice_cols,
        voice_model=voice_model,
    )


REPORT_NAME = "report.json"


def report_path(path: Path | str) -> Path:
    """Where ``write_report`` puts the JSON.

    ``--out`` may name a file (``results/eval.json``) or a directory. A directory is an
    existing directory, or a path written with a trailing separator; the report then goes
    to ``<dir>/report.json``.
    """
    text = str(path)
    p = Path(text)
    if p.is_dir() or text.endswith(("/", "\\")):
        return p / REPORT_NAME
    return p


def write_report(report: dict, path: Path | str) -> Path:
    """Atomic, strict JSON (NaN and inf become null). Returns the file written."""
    p = report_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    text = json.dumps(_finite(report), indent=2, default=_json_default, allow_nan=False)
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(p)
    return p


def _finite(obj):
    """Recursively replace non-finite floats with None so the report is valid JSON."""
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        val = float(obj)
        return val if np.isfinite(val) else None
    return obj


def _one_model(name: str, joined: pd.DataFrame, *, scalar_ridge: bool = False) -> dict:
    row = {
        "model": name,
        "n": int(len(joined)),
        "arousal_ccc": None,
        "arousal_spearman": None,
        "arousal_source": None,
        "valence_ccc": None,
        "valence_spearman": None,
        "valence_source": None,
        "flag_macro_f1": None,
    }
    a_col, v_col = f"{name}__arousal", f"{name}__valence"
    if a_col in joined.columns and v_col in joined.columns and joined[a_col].notna().any():
        scores = dimension_scores(
            joined["arousal"].to_numpy(dtype=np.float64),
            joined["valence"].to_numpy(dtype=np.float64),
            joined[a_col].to_numpy(dtype=np.float64),
            joined[v_col].to_numpy(dtype=np.float64),
        )
        row.update(
            {
                "arousal_ccc": scores["arousal_ccc"],
                "valence_ccc": scores["valence_ccc"],
                "arousal_spearman": scores["arousal_spearman"],
                "valence_spearman": scores["valence_spearman"],
                "arousal_source": "direct",
                "valence_source": "direct",
                "direct_scale": scores["scale"],
            }
        )
    emb_col = f"{name}__embedding"
    X = _embedding_matrix(joined[emb_col]) if emb_col in joined.columns else None
    groups = joined["room_day"].to_numpy() if "room_day" in joined.columns else joined["window_id"].to_numpy()
    if X is not None and X.size:
        if row["arousal_source"] is None:
            pred_a = grouped_oof(X, joined["arousal"].to_numpy(dtype=np.float64), groups, task="ridge")
            pred_v = grouped_oof(X, joined["valence"].to_numpy(dtype=np.float64), groups, task="ridge")
            row["arousal_ccc"] = concordance_ccc(joined["arousal"], pred_a)
            row["valence_ccc"] = concordance_ccc(joined["valence"], pred_v)
            row["arousal_spearman"] = spearman(joined["arousal"], pred_a)
            row["valence_spearman"] = spearman(joined["valence"], pred_v)
            row["arousal_source"] = "ridge_oof"
            row["valence_source"] = "ridge_oof"
        flags = {f: joined[f].to_numpy(dtype=np.float64) for f in FLAG_TARGETS if f in joined.columns}
        if flags:
            row["flag_macro_f1"] = flag_macro_f1(X, flags, groups)["macro_f1"]
    elif scalar_ridge and row["arousal_source"] is None:
        S = _scalar_matrix(joined, name)
        if S is not None:
            alpha = float(max(1, S.shape[1]))
            pred_a = grouped_oof(S, joined["arousal"].to_numpy(dtype=np.float64), groups, task="ridge", alpha=alpha)
            pred_v = grouped_oof(S, joined["valence"].to_numpy(dtype=np.float64), groups, task="ridge", alpha=alpha)
            row["arousal_ccc"] = concordance_ccc(joined["arousal"], pred_a)
            row["valence_ccc"] = concordance_ccc(joined["valence"], pred_v)
            row["arousal_spearman"] = spearman(joined["arousal"], pred_a)
            row["valence_spearman"] = spearman(joined["valence"], pred_v)
            row["arousal_source"] = "ridge_oof_scalar"
            row["valence_source"] = "ridge_oof_scalar"
            row["n_scalar_features"] = int(S.shape[1])
            row["ridge_alpha"] = alpha
            flags = {f: joined[f].to_numpy(dtype=np.float64) for f in FLAG_TARGETS if f in joined.columns}
            if flags:
                row["flag_macro_f1"] = flag_macro_f1(S, flags, groups)["macro_f1"]
    return row


# Per-model columns that are bookkeeping or derived, not acoustic features.
_NON_FEATURE_SUFFIXES = (
    "status",
    "reason",
    "infer_s",
    "revision",
    "vad",
    "model_id",
    "extractor_version",
    "embedding",
    "arousal",
    "valence",
    "dominance",
)


def _scalar_column_names(joined: pd.DataFrame, name: str) -> list[str]:
    """``<name>__<feature>`` columns that are acoustic scalars, not bookkeeping or deltas."""
    prefix = f"{name}__"
    cols = []
    for c in joined.columns:
        text = str(c)
        if not text.startswith(prefix):
            continue
        feat = text[len(prefix):]
        if "__" in feat or feat in _NON_FEATURE_SUFFIXES:
            continue
        cols.append(c)
    return cols


def _scalar_matrix(joined: pd.DataFrame, name: str, *, min_rows: int = 4) -> np.ndarray | None:
    """Numeric ``<name>__<feature>`` columns as a matrix.

    Skips bookkeeping columns, baseline deltas (``__delta_self`` / ``__rel_doctor``), and any
    column with a non-finite value or no variance. ``None`` when nothing usable is left.
    """
    cols = _scalar_column_names(joined, name)
    if not cols or len(joined) < min_rows:
        return None
    block = joined[cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float64)
    keep = np.all(np.isfinite(block), axis=0)
    if keep.any():
        sd = np.nanstd(np.where(np.isfinite(block), block, np.nan), axis=0)
        keep &= np.nan_to_num(sd) > 0
    if not keep.any():
        return None
    return block[:, keep]


def _embedding_matrix(series: pd.Series) -> np.ndarray | None:
    vecs = []
    width = None
    for v in series.tolist():
        if v is None or (isinstance(v, float) and not np.isfinite(v)):
            vecs.append(None)
            continue
        arr = np.asarray(v, dtype=np.float64).reshape(-1)
        if arr.size == 0 or not np.isfinite(arr).all():
            vecs.append(None)
            continue
        width = arr.size if width is None else width
        if arr.size != width:
            return None
        vecs.append(arr)
    if width is None:
        return None
    out = np.full((len(vecs), width), np.nan)
    for i, v in enumerate(vecs):
        if v is not None:
            out[i] = v
    return out


def _models_in(columns) -> list[str]:
    names = []
    for c in columns:
        text = str(c)
        if "__" not in text:
            continue
        name = text.split("__", 1)[0]
        if name not in names:
            names.append(name)
    return names


def _pairs(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    usable = df.loc[usable_mask(df)]
    primaries = []
    repeats = []
    for wid, sub in usable.groupby("window_id", sort=False):
        primary = sub.loc[~sub["is_repeat"].astype(bool)]
        repeat = sub.loc[sub["is_repeat"].astype(bool)]
        if primary.empty or repeat.empty:
            continue
        primaries.append(primary.iloc[0])
        repeats.append(repeat.iloc[0])
    if not primaries:
        empty = usable.iloc[0:0]
        return empty, empty
    return pd.DataFrame(primaries), pd.DataFrame(repeats)


def _kappa(a, b, fn) -> float | None:
    m = np.isfinite(a) & np.isfinite(b)
    a, b = np.rint(a[m]).astype(int), np.rint(b[m]).astype(int)
    if a.size < 2:
        return None
    try:
        val = float(fn(a, b, weights="quadratic"))
    except ValueError:
        return None
    if not np.isfinite(val):
        return None
    return val


def _exact(a, b) -> float | None:
    m = np.isfinite(a) & np.isfinite(b)
    if int(m.sum()) == 0:
        return None
    return float(np.mean(np.rint(a[m]) == np.rint(b[m])))


def _looks_unit_interval(v: np.ndarray) -> bool:
    finite = v[np.isfinite(v)]
    if finite.size == 0:
        return False
    return float(np.min(finite)) >= -0.05 and float(np.max(finite)) <= 1.05


def _auroc(y, frame, col, fn) -> float | None:
    if col not in frame.columns or len(frame) < 2 or np.unique(y).size < 2:
        return None
    s = pd.to_numeric(frame[col], errors="coerce").to_numpy(dtype=np.float64)
    m = np.isfinite(s)
    if int(m.sum()) < 2 or np.unique(y[m]).size < 2:
        return None
    return float(fn(y[m], s[m]))


def _flag_from_row(rec: dict, aliases: tuple[str, ...]) -> bool:
    for name in aliases:
        if name in rec and str(rec[name]).strip() != "":
            return _as_bool(rec[name])
    return False


def _as_bool(v) -> bool:
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    s = str(v).strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    raise EvalError(f"not a 0/1 flag: {s!r}")


def _json_default(obj):
    if isinstance(obj, float) and not np.isfinite(obj):
        return None
    if isinstance(obj, (np.floating,)):
        val = float(obj)
        return None if not np.isfinite(val) else val
    if isinstance(obj, (np.integer,)):
        return int(obj)
    raise TypeError(type(obj).__name__)


FUSION_TEXT_DIMS = (
    "text_valence",
    "text_arousal",
    "text_engaged",
    "text_resistant",
    "text_unresolved_doubt",
    "text_confidence",
)
_DIRECT_VOICE_DIMS = ("arousal", "valence", "dominance")


def load_text_scores(path: Path | str) -> pd.DataFrame:
    """Jev score JSONL or CSV. Transcript fields are ignored and never copied into the frame."""
    rows = _read_score_rows(path)
    records = []
    for obj in rows:
        window_id = obj.get("window_id")
        if not isinstance(window_id, str) or not window_id.strip():
            raise EvalError("text scores row is missing window_id")
        rec: dict = {"window_id": window_id.strip()}
        if obj.get("status") not in (None, "", "ok"):
            for col in FUSION_TEXT_DIMS:
                rec[col] = np.nan
            records.append(rec)
            continue
        rec["text_valence"] = _dim_number(obj.get("valence"))
        arousal = obj.get("arousal", obj.get("distress"))
        rec["text_arousal"] = _dim_number(arousal)
        rec["text_engaged"] = _dim_number(obj.get("engaged"))
        rec["text_resistant"] = _dim_number(obj.get("resistant"))
        doubt = obj.get("unresolved_doubt")
        if isinstance(doubt, dict):
            rec["text_unresolved_doubt"] = _dim_number(doubt.get("value"))
        else:
            rec["text_unresolved_doubt"] = _dim_number(doubt)
        rec["text_confidence"] = _dim_number(obj.get("confidence"))
        records.append(rec)
    if not records:
        raise EvalError("text scores file is empty")
    frame = pd.DataFrame(records)
    if frame["window_id"].duplicated().any():
        raise EvalError("text scores have a duplicate window_id")
    return frame


def voice_dimension_columns(
    features: pd.DataFrame,
    *,
    model: str | None = None,
    explicit: list[str] | None = None,
) -> list[str]:
    """Voice dimensions for the fusion head.

    An explicit list is used as given. Otherwise a model's direct arousal, valence,
    and dominance columns are the voice dims. Scalar functionals are used only when
    that model has no direct dimensional scores.
    """
    if explicit:
        missing = [c for c in explicit if c not in features.columns]
        if missing:
            raise EvalError("voice columns missing from features")
        return list(explicit)
    names = _models_in(features.columns)
    if model is None:
        if len(names) != 1:
            raise EvalError("fusion needs --voice-model or --voice-cols")
        model = names[0]
    elif not any(str(c).startswith(f"{model}__") for c in features.columns):
        raise EvalError("voice model is not in the features")
    direct = []
    for dim in _DIRECT_VOICE_DIMS:
        col = f"{model}__{dim}"
        if col not in features.columns:
            continue
        arr = pd.to_numeric(features[col], errors="coerce")
        if arr.notna().any():
            direct.append(col)
    if direct:
        return direct
    kept = []
    for col in _scalar_column_names(features, model):
        arr = pd.to_numeric(features[col], errors="coerce").to_numpy(dtype=np.float64)
        finite = arr[np.isfinite(arr)]
        if finite.size >= 4 and float(np.std(finite)) > 0:
            kept.append(col)
    if not kept:
        raise EvalError("no voice dimensions for the selected model")
    return kept


def fusion_comparison(
    labels: pd.DataFrame,
    features: pd.DataFrame,
    text_scores: pd.DataFrame,
    *,
    voice_cols: list[str] | None = None,
    voice_model: str | None = None,
) -> dict:
    """Voice-only vs text-only vs late fusion on one shared room-day GroupKFold cohort.

    Late fusion concatenates the voice dimensions and the text dimensions, then fits
    the same heads: ridge (alpha 1) for arousal and valence, logistic for the flags.
    """
    vcols = voice_dimension_columns(features, model=voice_model, explicit=voice_cols)
    text = text_scores.copy()
    tcols = [c for c in FUSION_TEXT_DIMS if c in text.columns]
    if "text_valence" not in tcols or "text_arousal" not in tcols:
        raise EvalError("text scores are missing valence and arousal")
    usable = labels.loc[usable_mask(labels) & ~labels["is_repeat"].astype(bool)].copy()
    joined = usable.merge(features, on="window_id", how="inner", suffixes=("", "_feat"))
    joined = joined.merge(text, on="window_id", how="inner")
    for col in vcols + tcols:
        joined[col] = pd.to_numeric(joined[col], errors="coerce")
    finite = np.ones(len(joined), dtype=bool)
    for col in vcols + tcols + ["arousal", "valence"]:
        finite &= np.isfinite(pd.to_numeric(joined[col], errors="coerce").to_numpy(dtype=np.float64))
    work = joined.loc[finite].reset_index(drop=True)
    groups = work["room_day"].to_numpy() if len(work) else np.array([])
    gold_a = work["arousal"].to_numpy(dtype=np.float64) if len(work) else np.array([])
    gold_v = work["valence"].to_numpy(dtype=np.float64) if len(work) else np.array([])
    return {
        "n": int(len(work)),
        "n_joined": int(len(joined)),
        "n_dropped_nonfinite": int((~finite).sum()) if len(joined) else 0,
        "n_groups": int(pd.unique(groups).size) if len(work) else 0,
        "group": "room_day",
        "ridge_alpha": 1.0,
        "voice_cols": vcols,
        "text_cols": tcols,
        "conditions": {
            "voice_only": _fusion_condition(work, vcols, gold_a, gold_v, groups),
            "text_only": _fusion_condition(work, tcols, gold_a, gold_v, groups),
            "late_fused": _fusion_condition(work, vcols + tcols, gold_a, gold_v, groups),
        },
    }


def _fusion_condition(work: pd.DataFrame, cols: list[str], gold_a, gold_v, groups) -> dict:
    if len(work) == 0 or not cols:
        return {
            "n_features": int(len(cols)),
            "arousal_spearman": None,
            "arousal_ccc": None,
            "valence_spearman": None,
            "valence_ccc": None,
            "flag_macro_f1": None,
            "per_flag": {},
        }
    X = work[cols].to_numpy(dtype=np.float64)
    pred_a = grouped_oof(X, gold_a, groups, task="ridge")
    pred_v = grouped_oof(X, gold_v, groups, task="ridge")
    flags = {name: work[name].to_numpy(dtype=np.float64) for name in FLAG_TARGETS if name in work.columns}
    f1 = flag_macro_f1(X, flags, groups) if flags else {"macro_f1": None, "per_flag": {}}
    return {
        "n_features": int(len(cols)),
        "arousal_spearman": spearman(gold_a, pred_a),
        "arousal_ccc": concordance_ccc(gold_a, pred_a),
        "valence_spearman": spearman(gold_v, pred_v),
        "valence_ccc": concordance_ccc(gold_v, pred_v),
        "flag_macro_f1": f1["macro_f1"],
        "per_flag": f1["per_flag"],
    }


def _read_score_rows(path: Path | str) -> list[dict]:
    src = Path(path)
    try:
        raw = src.read_text(encoding="utf-8")
    except OSError:
        raise EvalError("text scores file could not be read") from None
    if not raw.strip():
        return []
    head = raw.lstrip()
    try:
        if src.suffix.lower() == ".csv" or head.lower().startswith("window_id"):
            frame = pd.read_csv(src, dtype=str, keep_default_na=False)
            return frame.to_dict(orient="records")
        if head[0] == "[":
            data = json.loads(raw)
            if not isinstance(data, list):
                raise EvalError("text scores file is not valid JSON or JSONL")
            return [row for row in data if isinstance(row, dict)]
        if head[0] == "{" and "\n" not in raw.strip():
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise EvalError("text scores file is not valid JSON or JSONL")
            return [data]
        rows = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
        return rows
    except json.JSONDecodeError:
        raise EvalError("text scores file is not valid JSON or JSONL") from None
    except EvalError:
        raise
    except Exception:
        raise EvalError("text scores file could not be read") from None


def _dim_number(val) -> float:
    if val is None:
        return float("nan")
    if isinstance(val, (bool, np.bool_)):
        return float(val)
    if isinstance(val, (int, float, np.floating, np.integer)):
        return float(val)
    text = str(val).strip()
    if text == "":
        return float("nan")
    lowered = text.lower()
    if lowered in _TRUE or lowered in _FALSE:
        return float(_as_bool(text))
    try:
        return float(text)
    except ValueError:
        return float("nan")


def main(argv: list[str] | None = None) -> None:
    import argparse

    p = argparse.ArgumentParser(prog="python -m tools.timbre.evaluate")
    p.add_argument("--labels", required=True)
    p.add_argument("--features", required=True)
    p.add_argument("--outcomes", default=None)
    p.add_argument("--out", required=True, help="report file, or a directory (writes report.json inside)")
    p.add_argument(
        "--scalar-ridge",
        action="store_true",
        help="fit a grouped-CV ridge head on scalar features (eGeMAPS, ComParE) for models without direct scores or embeddings",
    )
    p.add_argument(
        "--fusion",
        action="store_true",
        help="compare voice-only, text-only, and late-fused heads (requires --text-scores)",
    )
    p.add_argument("--text-scores", default=None, help="Jev text-score JSONL or CSV (with --fusion)")
    p.add_argument("--voice-model", default=None, help="feature prefix whose arousal/valence/dominance are the voice dims")
    p.add_argument("--voice-cols", default=None, help="comma-separated voice dimension columns (overrides --voice-model)")
    args = p.parse_args(argv)
    if args.fusion and not args.text_scores:
        p.error("--fusion requires --text-scores")
    if not args.fusion and (args.text_scores or args.voice_model or args.voice_cols):
        p.error("--text-scores, --voice-model and --voice-cols require --fusion")
    voice_cols = [c.strip() for c in args.voice_cols.split(",") if c.strip()] if args.voice_cols else None
    report = evaluate_files(
        args.labels,
        args.features,
        args.outcomes,
        scalar_ridge=args.scalar_ridge,
        text_scores=args.text_scores if args.fusion else None,
        voice_cols=voice_cols,
        voice_model=args.voice_model,
    )
    out = write_report(report, args.out)
    print(out)


if __name__ == "__main__":
    main()
