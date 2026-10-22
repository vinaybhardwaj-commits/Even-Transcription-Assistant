"""The committed C4 fixture (tests/c4_fixtures/pipeline_artifact.json) is what the pipeline builds today from the synthetic transcript in gen_c4_fixture.py."""
import json

import gen_c4_fixture as G


def test_fixture_is_current_and_holds_no_heard_value_in_completion_required():
    built = G.build()
    assert json.loads(G.OUT.read_text(encoding="utf-8")) == json.loads(json.dumps(built, sort_keys=True, ensure_ascii=False)), "run: python tools/eta2freescript/tests/gen_c4_fixture.py"
    for c in built["completion_required"]:
        assert sorted(c) == ["item_id", "kind", "prompt", "prompt_id"]
        assert not any(h.lower() in str(c["prompt"]).lower() for h in built["heard"])
    blob = json.dumps(built["artifact"], ensure_ascii=False)
    assert G.SENTINELS["prev"] not in blob  # the previous patient's turn is stored nowhere
