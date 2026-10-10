"""openSMILE eGeMAPSv02 and ComParE_2016 functionals."""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram


class OpenSmileExtractor(Extractor):
    def __init__(self, spec, device: str, feature_set: str):
        super().__init__(spec, device)
        self.feature_set = feature_set
        self._smile = None

    def _extract(self, audio: np.ndarray, sr: int):
        smile = self._load()
        frame = smile.process_signal(audio, sr)
        row = frame.iloc[0]
        features = {str(k): float(v) for k, v in row.items()}
        self.scalar_names = tuple(features)
        try:
            import opensmile

            self.revision = getattr(opensmile, "__version__", None)
        except Exception:
            self.revision = None
        return features, None, self.revision

    def _load(self):
        if self._smile is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            import opensmile

            feature_set = getattr(opensmile.FeatureSet, self.feature_set)
            self._smile = opensmile.Smile(
                feature_set=feature_set,
                feature_level=opensmile.FeatureLevel.Functionals,
            )
        return self._smile

    def close(self) -> None:
        self._smile = None
        super().close()
