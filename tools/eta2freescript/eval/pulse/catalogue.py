"""Local catalogue export and search.

APPROXIMATION: the replayed system searches its own index with its own ranking, popularity counters and availability
flags, none of which are reproducible here. This module scores a query against entity names with BM25 over lowercase
word tokens, max-normalised per query. Medicines need a normalised score of at least the assets' threshold; the other
kinds have none. A usage counter, when present, multiplies the score by 1 + weight * ln(1 + usage). Ranking and
recall will differ from the real index; every result is an approximation.

File: JSONL, one entity per line: {kind, uid, name, brand_name?, generic?, strength?, aliases?, icd?, usage?,
included_tests?, disabled?}. kind is medicine|diagnosis|comorbidity|surgery|investigation|specialist.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

KINDS = ("medicine", "diagnosis", "comorbidity", "surgery", "investigation", "specialist")
_WORD = re.compile(r"[a-z0-9]+")
_K1, _B = 1.5, 0.75
MAX_TESTS_SHOWN = 8


def tokens(s: str) -> list[str]:
    return _WORD.findall((s or "").lower())


def norm_name(s: str) -> str:
    return " ".join(tokens(s))


@dataclass
class SearchParams:
    top_k: int = 5
    max_candidates: int = 25
    medicine_score_threshold: float = 0.3
    popularity_weight: float = 0.3

    @classmethod
    def from_assets(cls, assets: dict) -> "SearchParams":
        return cls(**{k: assets["search"][k] for k in ("top_k", "max_candidates", "medicine_score_threshold", "popularity_weight")})


def describe(e: dict) -> str:
    k = e["kind"]
    if k == "medicine":
        brand = e.get("brand_name") or e["name"]
        strength = e.get("strength") or ""
        if strength and strength.lower() not in brand.lower():
            brand = f"{brand} {strength}"
        out = brand
        if e.get("generic"):
            out += f" (generic: {e['generic']})"
        return out
    if k == "diagnosis":
        return f"{e['name']} (ICD: {e['icd']})" if e.get("icd") else e["name"]
    if k == "investigation":
        tests = [str(t).strip() for t in (e.get("included_tests") or []) if str(t).strip()]
        if not tests:
            return e["name"]
        shown = ", ".join(tests[:MAX_TESTS_SHOWN]) + (", ..." if len(tests) > MAX_TESTS_SHOWN else "")
        return f"{e['name']} [package including: {shown}]"
    return e["name"]


def exact_names(e: dict) -> list[str]:
    """Names an extraction's name/raw_name may exactly match. Catalogue aliases are searched but never exact-matched."""
    names = [e["name"]]
    if e["kind"] == "medicine":
        if e.get("brand_name"):
            names += [e["brand_name"], f"{e['brand_name']} {e.get('strength') or ''}".strip()]
        if e.get("generic"):
            names += [e["generic"], f"{e['generic']} {e.get('strength') or ''}".strip()]
    return [n for n in {norm_name(x) for x in names} if n]


class _Index:
    def __init__(self, ents: list[dict]):
        self.ents = ents
        self.docs = []
        for e in ents:
            text = " ".join(str(x) for x in [e["name"], e.get("brand_name"), e.get("generic"), *(e.get("aliases") or [])] if x)
            self.docs.append(Counter(tokens(text)))
        self.lens = [sum(d.values()) for d in self.docs]
        self.avg = (sum(self.lens) / len(self.lens)) if self.lens else 0.0
        df: Counter = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query: str) -> list[float]:
        q = set(tokens(query))
        out = []
        for d, ln in zip(self.docs, self.lens):
            s = 0.0
            for t in q:
                f = d.get(t, 0)
                if f:
                    s += self.idf[t] * f * (_K1 + 1) / (f + _K1 * (1 - _B + _B * ln / (self.avg or 1.0)))
            out.append(s)
        return out


class Catalogue:
    def __init__(self, entities: list[dict]):
        self.entities = []
        for i, e in enumerate(entities):
            if not isinstance(e, dict) or e.get("kind") not in KINDS or not e.get("uid") or not e.get("name"):
                raise ValueError(f"catalogue entity {i}: needs kind, uid, name")
            if not e.get("disabled"):
                self.entities.append(e)
        self._idx = {k: _Index([e for e in self.entities if e["kind"] == k]) for k in KINDS}

    @classmethod
    def load(cls, path) -> "Catalogue":
        ents = []
        for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                try:
                    ents.append(json.loads(line))
                except ValueError:
                    raise ValueError(f"catalogue line {n}: not JSON") from None
        return cls(ents)

    def search(self, kind: str, query: str, params: SearchParams) -> list[tuple[dict, float]]:
        idx = self._idx[kind]
        sc = idx.scores(query)
        top = max(sc, default=0.0)
        if top <= 0:
            return []
        hits = []
        for e, s in zip(idx.ents, sc):
            if s <= 0:
                continue
            n = s / top
            if kind == "medicine" and n < params.medicine_score_threshold:
                continue
            if e.get("usage"):
                n *= 1 + params.popularity_weight * math.log(1 + max(float(e["usage"]), 0.0))
            hits.append((e, n))
        hits.sort(key=lambda h: (-h[1], h[0]["uid"]))
        return hits[: params.top_k]

    def candidates(self, kind: str, queries: list[str], params: SearchParams) -> list[dict]:
        """Top-k per query, interleaved round-robin, deduped by uid, capped."""
        lists = [[e for e, _ in self.search(kind, q, params)] for q in queries]
        out, seen = [], set()
        for rank in range(params.top_k):
            for lst in lists:
                if rank < len(lst) and lst[rank]["uid"] not in seen:
                    seen.add(lst[rank]["uid"])
                    out.append(lst[rank])
        return out[: params.max_candidates]
