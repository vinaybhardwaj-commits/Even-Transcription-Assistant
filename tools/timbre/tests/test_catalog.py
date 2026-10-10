"""The model catalogue is the stable name list. It must not import torch."""

from __future__ import annotations

from tools.timbre.catalog import SPECS, UnknownModel, resolve_model_names
import pytest


def test_names_are_unique_and_licensed():
    names = [s.name for s in SPECS]
    assert len(names) == len(set(names)) == 8
    for spec in SPECS:
        assert spec.licence
        assert spec.commercial_note
        assert spec.extractor_version == "v1"
        assert spec.name.endswith(".v1")


def test_resolve_aliases_and_all():
    assert resolve_model_names("all") == [s.name for s in SPECS]
    assert resolve_model_names("wavlm,egemaps") == ["wavlm_aniemore.v1", "egemaps_v02.v1"]
    assert resolve_model_names("odyssey") == ["odyssey_wavlm_dim.v1"]
    with pytest.raises(UnknownModel):
        resolve_model_names("not-a-model")
