"""The extraction JSON schema for response_format, built from the vendored description of GPLlmExtraction.

Source: tools/eta2freescript/vendor/freescript-w38/eta-freescript-artifact.schema.json, definitions.GPLlmExtraction.
Non-strict, as the parse is: no required keys anywhere, additionalProperties false, enum names kept, UNKNOWN stripped.
Descriptions, patterns and numeric bounds are dropped: they are ETA's own additions in the vendored file, and range checks
belong to normalisation, which must see out-of-range values to drop them. If the assets give response_schema, that wins.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

VENDORED = Path(__file__).resolve().parents[2] / "vendor" / "freescript-w38" / "eta-freescript-artifact.schema.json"
ROOT_DEF = "GPLlmExtraction"
_DROP = {"description", "pattern", "minimum", "maximum", "maxItems", "minItems", "required", "$schema", "$id", "title", "format"}


def _resolve(node, defs):
    if isinstance(node, list):
        return [_resolve(x, defs) for x in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        return _resolve(copy.deepcopy(defs[node["$ref"].rsplit("/", 1)[-1]]), defs)
    out = {}
    for k, v in node.items():
        if k in _DROP:
            continue
        if k == "enum":
            v = [x for x in v if x != "UNKNOWN"]
        out[k] = _resolve(v, defs)
    if out.get("type") == "object":
        out["additionalProperties"] = False
    return out


def build_schema(assets: dict | None = None, vendored: Path = VENDORED) -> dict:
    if assets is not None and assets.get("response_schema") is not None:
        return copy.deepcopy(assets["response_schema"])
    defs = json.loads(Path(vendored).read_text(encoding="utf-8"))["definitions"]
    return _resolve(copy.deepcopy(defs[ROOT_DEF]), defs)


def relaxed(schema: dict) -> dict:
    """The same schema with enums removed, for checking a reply's structure and types only (unit values are normalisation's)."""
    def walk(n):
        if isinstance(n, dict):
            return {k: walk(v) for k, v in n.items() if k != "enum"}
        if isinstance(n, list):
            return [walk(x) for x in n]
        return n
    return walk(schema)


def field_paths(schema: dict, prefix: str = "") -> list[str]:
    """Dotted field paths the schema covers (arrays shown as name[])."""
    out: list[str] = []
    for k, v in (schema.get("properties") or {}).items():
        p = f"{prefix}{k}"
        if v.get("type") == "array" and isinstance(v.get("items"), dict) and v["items"].get("type") == "object":
            out.append(p + "[]")
            out += field_paths(v["items"], p + "[].")
        elif v.get("type") == "object":
            out.append(p)
            out += field_paths(v, p + ".")
        else:
            out.append(p)
    return out


if __name__ == "__main__":
    for p in field_paths(build_schema()):
        print(p)
