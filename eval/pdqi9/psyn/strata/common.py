"""Helpers shared by the stratum modules."""

from .. import lexicon
from ..core import ScriptBuilder
from ..enrolment import N_PSEUDO_DOCTORS, pd_id

PDQI_ITEMS = ("up_to_date", "accurate", "thorough", "useful", "organized", "comprehensible",
              "succinct", "synthesized", "internally_consistent")
LEVELS = (1, 3, 5)


def lang_for(i):
    """Alternate language mode for strata without a language grid: en, cs-hi, en, cs-kn."""
    if i % 2 == 0:
        return "en", None
    return "cs", ("hi" if (i // 2) % 2 == 0 else "kn")


def new_builder(prefix, i, stratum, seed, pool, lang_mode=None, cs_lang=None):
    if lang_mode is None:
        lang_mode, cs_lang = lang_for(i)
    return ScriptBuilder(f"PSYN-{prefix}-{i + 1:03d}", stratum, seed, lang_mode, pool, cs_lang=cs_lang)


def pick_doctor(rng, exclude=()):
    choices = [pd_id(n) for n in range(1, N_PSEUDO_DOCTORS + 1) if pd_id(n) not in exclude]
    return rng.choice(choices)


def scenario(sb, i):
    sc = lexicon.SCENARIOS[(i + sb.rng.randrange(len(lexicon.SCENARIOS))) % len(lexicon.SCENARIOS)]
    sb.scenario = sc["key"]
    return sc


def standard_roster(sb, pd=None, patient_lang=None):
    pd = pd or pick_doctor(sb.rng)
    D = sb.add_speaker("treating_doctor", pseudo_doctor=pd, treating=True)
    P = sb.add_speaker("patient", language=patient_lang or sb.lang)
    return D, P, pd


def wrong_doctor(sb, pd):
    return pick_doctor(sb.rng, exclude=(pd,))
