"""FRX-V10 Fix1 H1 (refuted data change): romanised cardinals 0-1000 and fractions for Telugu, Tamil, Marathi, Bengali, Malayalam and Gujarati, added to
data/number_lexicon.v1.json (the S3 lexicon words stay; only additions). Spelling variants are generated (long/short vowels, aspirates, doubled consonants).
A variant that is an ordinary English dictionary word and not already in the lexicon is left out (tin, bar, sol, ...): it would read as a number in plain English.
Run: python -m tools.eta2freescript.v10._build.extend_lexicon   (idempotent)."""
import itertools
import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
BASE = {
    "te": "sunna sonna okati okka rendu randu moodu mudu naalugu nalugu aidu ayidu aaru aru edu yedu enimidi enimidhi tommidi thommidi padi padhi padakondu padakommidi pannendu "
          "pannendu padamoodu padahaaru padihenu padihedu padinalugu padinaalugu paddenimidi pandommidi pandrendu iravai iruvai muppai muppayi nalabhai nalubhai nalabai nalupai "
          "yabhai yaabhai ebhai yabai aravai arvai debbai debhai enabhai enubhai enabai tombhai thombhai tombai vanda nuru noru nooru veyyi veyi vandalu sagam sagamu ardham ardhamu "
          "paava pavu onnara",
    "ta": "poojyam sooniyam onru ondru onnu irandu rendu randu moondru moonu munu naangu nangu naalu ainthu aindhu anju anchu aaru ezhu elu ettu onbathu ombathu pathu patthu paththu "
          "pathinonru padhinonnu pannirendu pathimoondru pathimoonu pathinangu pathinaalu pathinainthu pathinaaru pathinezhu pathinettu pathombathu irupathu irubadhu muppathu muppadhu "
          "naarpathu naalpathu nalubadhu aimbathu aimpathu ambathu aruvathu arubathu ezhuvathu elubathu ezhupathu enbathu embathu thonnooru tonnuru thonnoothu nooru nuru irunooru "
          "munnooru munuru naanooru ainooru aiynooru ainuru aaru-nooru aayiram ayiram arai ara paadhi kaal kal mukkaal onnara ottara",
    "mr": "shunya ek don dohn teen char paach pach saha sahaa saat aath nau daha akra akara bara tera chauda pandhra sola satra athara ekonis ekkonis vis veess tees tis chalis pannas "
          "saath sattar ashi nabbad shambhar shambar donshe pachshe paachshe hazaar ardha ardhe aadha sava savva deed adich adhich",
    "bn": "shunyo ek dui dwi tin char panch chhoy chhoi choy saat shat aat ath noy dosh dos egaro baro tero chouddo ponero sholo shotero atharo unish kuri tirish trish challish chollish "
          "ponchash ponchas shaat sottor ashi nobboi shoto shotok duishoto panchshoto hajar hazar ordha aadha adha derh sharey",
    "ml": "pujyam onnu randu moonnu naalu anchu anju aaru ezhu ettu onpathu ombathu pathu pathinonnu pannirandu pathimoonnu pathinaalu pathinanchu pathinaaru pathinezhu pathinettu "
          "pathompathu irupathu muppathu naalpathu aimpathu arupathu ezhupathu enpathu thonnooru nooru anjnooru anjooru aayiram arai paadhi",
    "gu": "shunya ek be bay tran char panch chha saat aath nav das agiyar bar ter chaud pandar sol satar adhar ogani vis tris chaalis chalis pachas saath sitter eeshi nevu so seyu baso "
          "panchso hajar hazar adhi aadhu ardhu sava dedh",
}
FORCE = {"padi", "vanda", "sunna", "dui", "dos", "noy", "nav", "kuri", "koori", "shat", "sola", "pawa", "thees", "vees", "wees", "wis"}  # Indic number words that are also in the SCOWL list
# Fix2: number words that are also ordinary English. They are kept OUT of the unconditional lexicon (they would read as a number in every sentence) and live in
# `collision_extra`; with the lexicon words that are in the English dictionary they count as numbers only beside a drug mention, a dosing word, a drug-class word or a dose unit.
COLLISION_EXTRA = ["do", "be", "so", "don", "ent", "trees", "threes", "bar", "bay", "cha", "sol", "ter", "der", "moor"]
SWAPS = [("oo", "u"), ("aa", "a"), ("ee", "i"), ("th", "t"), ("dh", "d"), ("bh", "b"), ("kk", "k"), ("tt", "t"), ("nn", "n"), ("ch", "chh"), ("ph", "f"), ("zh", "l"), ("w", "v")]


def variants(w: str) -> set[str]:
    out = {w}
    for _ in range(2):
        for v in list(out):
            for a, b in SWAPS:
                if a in v:
                    out.add(v.replace(a, b))
                if b in v:
                    out.add(v.replace(b, a))
    return out


def main() -> None:
    p = DATA / "number_lexicon.v1.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    have = set(d["words"])
    from tools.eta2freescript.v10 import words
    add, dropped = set(), set()
    for lang, s in BASE.items():
        for w in s.split():
            for v in variants(w.lower()):
                if len(v) < 3 or not re.fullmatch(r"[a-z]+(?:-[a-z]+)?", v) or v in have:
                    continue
                (dropped if words.in_dictionary(v) and v not in FORCE else add).add(v)
    d["words"] = sorted(have | add)
    d["collision_extra"] = COLLISION_EXTRA
    d["count"] = len(d["words"])
    d["version"] = "number-lexicon.v1.2"
    d["note"] = d["note"].split(" FIX1")[0] + (f" FIX1 H1 (22 Oct 2026, refuted data change; FIX2 adds collision_extra): +{len(add)} romanised forms for te ta mr bn ml gu; "
                                               f"{len(dropped)} variants left out because they are English dictionary words.")
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(len(add), "added;", len(dropped), "left out:", " ".join(sorted(dropped)[:60]))


if __name__ == "__main__":
    main()
