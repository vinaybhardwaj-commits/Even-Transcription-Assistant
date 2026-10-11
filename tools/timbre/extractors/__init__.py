"""Feature extractors. Heavy libraries are imported inside ``load()``, not here."""

from tools.timbre.extractors.base import Extractor, build_extractor

__all__ = ["Extractor", "build_extractor"]
