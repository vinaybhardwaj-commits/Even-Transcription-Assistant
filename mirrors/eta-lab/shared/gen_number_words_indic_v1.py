#!/usr/bin/env python3
"""Generator for shared/number-words-indic-v1.json (ta te ml mr bn gu), native script only.

The collapse matcher in the web app and the router is SINGLE-TOKEN (text split on whitespace, then on - and /),
so a spaced compound ("ఇరవై ఒకటి") is protected by its components; fused compounds are added where the
script writes them fused. Over-inclusion is the safe direction: it only leaves a loop in place.

Run:  python3 gen_number_words_indic_v1.py > number-words-indic-v1.json
"""
import json
import re
import sys
import unicodedata

NFC = lambda s: unicodedata.normalize("NFC", s)


def words(s):
    return s.split()


# ───────────────────────────── Tamil ─────────────────────────────
def tamil():
    e = []
    e += words("பூஜ்ஜியம் பூஜ்யம் சுழியம்")
    # 1-10 written + colloquial
    e += words("ஒன்று ஒண்ணு ஒன்னு இரண்டு ரெண்டு மூன்று மூணு நான்கு நாலு ஐந்து அஞ்சு ஆறு ஏழு எட்டு ஒன்பது ஒம்பது பத்து")
    # adjectival one / two
    e += words("ஒரு இரு")
    # 11-19 written + colloquial
    e += words("பதினொன்று பதினொண்ணு பன்னிரண்டு பன்னெண்டு பதின்மூன்று பதிமூணு பதினான்கு பதினாலு "
               "பதினைந்து பதினஞ்சு பதினாறு பதினேழு பதினெட்டு பத்தொன்பது பத்தொம்பது")
    tens = words("இருபது முப்பது நாற்பது ஐம்பது அறுபது எழுபது எண்பது தொண்ணூறு")
    e += tens
    e += words("இருவது நாப்பது அம்பது அறுவது எழுவது எம்பது தொண்ணூறு")  # colloquial tens
    units = {1: "ஒன்று", 2: "இரண்டு", 3: "மூன்று", 4: "நான்கு", 5: "ஐந்து", 6: "ஆறு", 7: "ஏழு", 8: "எட்டு", 9: "ஒன்பது"}
    sign = {"ஒ": "ொ", "இ": "ி", "ஐ": "ை", "ஆ": "ா", "ஏ": "ே", "எ": "ெ"}
    for t in tens:
        if t.endswith("று"):
            stem_u = t[:-2] + "ற்று"
        else:
            stem_u = t[:-2] + "த்து"
        stem_i = stem_u[:-1] + "ி"            # colloquial -தி stem (இருபத்தி)
        e += [stem_u, stem_i]
        for u in units.values():
            if u[0] in sign:
                e.append(stem_u[:-1] + sign[u[0]] + u[1:])      # இருபத்தொன்று, இருபத்திரண்டு ...
            else:
                e.append(stem_u + u)                            # இருபத்துமூன்று, இருபத்துநான்கு
    # hundreds / thousands
    e += words("நூறு இருநூறு முந்நூறு நானூறு ஐந்நூறு அறுநூறு எழுநூறு எண்ணூறு தொள்ளாயிரம் ஆயிரம் இலட்சம் லட்சம் கோடி")
    e += words("நூற்று நூற்றி ஆயிரத்து")
    # fractions
    e += words("அரை கால் முக்கால் ஒன்றரை இரண்டரை மூன்றரை நான்கரை ஐந்தரை ஒன்றேகால் இரண்டேகால் ஒண்ணரை ரெண்டரை")
    # digits (U+0BE6-0BEF) and the three non-decimal numerals ten/hundred/thousand
    e += [chr(c) for c in range(0x0BE6, 0x0BF0)] + [chr(0x0BF0), chr(0x0BF1), chr(0x0BF2)]
    return e


# ───────────────────────────── Telugu ─────────────────────────────
def telugu():
    e = []
    e += words("సున్న సున్నా")
    e += words("ఒకటి ఒక్కటి ఒక ఒక్క రెండు మూడు నాలుగు ఐదు అయిదు ఆరు ఏడు ఎనిమిది తొమ్మిది పది")
    e += words("పదకొండు పన్నెండు పదమూడు పధ్నాలుగు పద్నాలుగు పదిహేను పదహారు పదారు పదిహేడు పద్దెనిమిది "
               "పద్ధెనిమిది పదెనిమిది పంతొమ్మిది పందొమ్మిది")
    tens = words("ఇరవై ముప్పై నలభై నలబై యాభై ఏభై అరవై డెబ్బై ఎనభై ఎనబై తొంభై తొంబై")
    e += tens
    # Telugu writes 21-99 as two tokens ("ఇరవై ఒకటి"), so the components above already carry every compound;
    # no fused forms are generated (they are not how the language is written).
    # hundreds and above
    e += words("వంద నూరు వందలు వందల వెయ్యి వేలు వేల లక్ష లక్షలు కోటి కోట్లు")
    e += words("రెండొందలు మూడొందలు నాలుగొందలు ఐదొందలు అయిదొందలు ఆరొందలు ఏడొందలు ఎనిమిదొందలు తొమ్మిదొందలు")
    # fractions
    e += words("అర సగం పావు ముప్పావు ఒకటిన్నర రెండున్నర మూడున్నర నాలుగున్నర ఐదున్నర")
    e += [chr(c) for c in range(0x0C66, 0x0C70)]
    return e


# ───────────────────────────── Malayalam ─────────────────────────────
def malayalam():
    e = []
    e += words("പൂജ്യം ശൂന്യം")
    base = words("ഒന്ന് രണ്ട് മൂന്ന് നാല് അഞ്ച് ആറ് ഏഴ് എട്ട് ഒമ്പത് ഒൻപത് പത്ത്")
    e += base
    e += words("ഒരു")
    e += words("പതിനൊന്ന് പന്ത്രണ്ട് പതിമൂന്ന് പതിനാല് പതിനഞ്ച് പതിനാറ് പതിനേഴ് പതിനെട്ട് പത്തൊമ്പത് പത്തൊൻപത്")
    tens = words("ഇരുപത് മുപ്പത് നാൽപ്പത് നാല്പത് അമ്പത് അറുപത് എഴുപത് എൺപത് തൊണ്ണൂറ്")
    e += tens
    units = words("ഒന്ന് രണ്ട് മൂന്ന് നാല് അഞ്ച് ആറ് ഏഴ് എട്ട് ഒമ്പത് ഒൻപത്")
    vsign = {"ഒ": "ൊ", "അ": "", "ആ": "ാ", "ഏ": "േ", "എ": "െ"}
    VIRAMA = "്"
    for t in tens:
        c = t[-2]                      # the consonant that doubles: ത or റ
        stem_i = t + c + "ി"            # ഇരുപത്തി
        e.append(stem_i)
        for u in units:
            if u[0] in vsign:
                e.append(stem_i + "യ" + vsign[u[0]] + u[1:])     # ഇരുപത്തിയൊന്ന്
                e.append(t + c + vsign[u[0]] + u[1:])            # ഇരുപത്തൊന്ന്
            else:
                e.append(stem_i + u)                              # ഇരുപത്തിരണ്ട്
    e += words("നൂറ് ഇരുന്നൂറ് മുന്നൂറ് നാനൂറ് അഞ്ഞൂറ് അറുനൂറ് എഴുനൂറ് എണ്ണൂറ് തൊള്ളായിരം ആയിരം ലക്ഷം കോടി നൂറ്റി ആയിരത്തി")
    e += words("അര കാൽ മുക്കാൽ ഒന്നര രണ്ടര മൂന്നര നാലര അഞ്ചര ഒന്നേകാൽ രണ്ടേകാൽ ഒന്നേമുക്കാൽ പകുതി")
    e += [chr(c) for c in range(0x0D66, 0x0D70)]
    # v1.1 (Refuter omissions): 700 spelling, 40 without the doubled consonant, and the joined hundreds (നൂറ്റി-style stems)
    e += words("എഴുന്നൂറ് നാൽപത് ഇരുന്നൂറ്റി മുന്നൂറ്റി നാനൂറ്റി അഞ്ഞൂറ്റി അറുനൂറ്റി എഴുനൂറ്റി എണ്ണൂറ്റി തൊള്ളായിരത്തി")
    # the -ു ending ("ഒന്നു", "രണ്ടു") for every form ending in a bare virama: the virama is replaced by ു
    e += [w[:-1] + "ു" for w in list(e) if w.endswith(VIRAMA)]
    # legacy (pre-Unicode-5.1) chillu spelling: consonant + virama + ZWJ in place of the atomic chillu
    legacy = {"ൻ": "ന്‍", "ൺ": "ണ്‍", "ൽ": "ല്‍", "ൾ": "ള്‍", "ർ": "ര്‍"}
    for w in list(e):
        if any(ch in w for ch in legacy):
            v = w
            for k, r in legacy.items():
                v = v.replace(k, r)
            e.append(v)
    return e


# ───────────────────────────── Marathi ─────────────────────────────
def marathi():
    e = []
    e += words("शून्य")
    e += words("एक दोन तीन चार पाच सहा सात आठ नऊ दहा")
    e += words("अकरा बारा तेरा चौदा पंधरा सोळा सतरा अठरा एकोणीस एकोनीस एकोणिस")
    e += words("वीस एकवीस बावीस तेवीस चोवीस पंचवीस सव्वीस सत्तावीस अठ्ठावीस अठ्ठावीस एकोणतीस")
    e += words("तीस एकतीस बत्तीस तेहतीस तेहेतीस चौतीस पस्तीस छत्तीस सदतीस अडतीस एकोणचाळीस")
    e += words("चाळीस एक्केचाळीस एकेचाळीस बेचाळीस त्रेचाळीस चव्वेचाळीस पंचेचाळीस सेहेचाळीस शेहेचाळीस सत्तेचाळीस अठ्ठेचाळीस एकोणपन्नास")
    e += words("पन्नास एक्कावन्न बावन्न त्रेपन्न चौपन्न पंचावन्न छप्पन्न छपन्न सत्तावन्न अठ्ठावन्न एकोणसाठ")
    e += words("साठ एकसष्ट एकसष्ठ बासष्ट त्रेसष्ट चौसष्ट पासष्ट सहासष्ट सदुसष्ट अडुसष्ट एकोणसत्तर")
    e += words("सत्तर एक्काहत्तर एकाहत्तर बाहत्तर त्र्याहत्तर चौऱ्याहत्तर पंच्याहत्तर शहात्तर सत्त्याहत्तर अठ्ठ्याहत्तर एकोणऐंशी")
    e += words("ऐंशी ऐशी एक्क्याऐंशी एक्याऐंशी ब्याऐंशी त्र्याऐंशी चौऱ्याऐंशी पंच्याऐंशी शहाऐंशी सत्त्याऐंशी अठ्ठ्याऐंशी एकोणनव्वद")
    e += words("नव्वद एक्क्याण्णव एक्याण्णव ब्याण्णव त्र्याण्णव चौऱ्याण्णव पंच्याण्णव शहाण्णव सत्त्याण्णव अठ्ठ्याण्णव नव्व्याण्णव नव्याण्णव")
    e += words("शंभर दोनशे तीनशे चारशे पाचशे सहाशे सातशे आठशे नऊशे हजार लाख कोटी")
    e += words("अर्धा अर्धी अर्धे अर्ध निम्मा निम्मे निम्मी पाव पाऊण सव्वा दीड अडीच साडे पावणे")
    tail = words("तीन चार पाच सहा सात आठ नऊ दहा")
    e += ["साडे" + t for t in tail]
    e += ["पावणे" + t for t in words("दोन तीन चार पाच सहा सात आठ नऊ दहा")]
    e += ["सव्वा" + t for t in words("दोन तीन चार पाच सहा सात आठ नऊ दहा")]
    e += [chr(c) for c in range(0x0966, 0x0970)]
    return e


# ───────────────────────────── Bengali ─────────────────────────────
def bengali():
    e = []
    e += words("শূন্য")
    e += words("এক দুই তিন চার পাঁচ ছয় সাত আট নয় দশ")
    e += words("এগারো এগার বারো বার তেরো তের চোদ্দ চৌদ্দ পনেরো পনের ষোলো ষোল সতেরো সতের আঠারো আঠার উনিশ ঊনিশ")
    e += words("বিশ একুশ বাইশ তেইশ চব্বিশ পঁচিশ ছাব্বিশ সাতাশ আঠাশ ঊনত্রিশ উনত্রিশ")
    e += words("ত্রিশ তিরিশ একত্রিশ বত্রিশ তেত্রিশ চৌত্রিশ পঁয়ত্রিশ ছত্রিশ সাঁইত্রিশ আটত্রিশ ঊনচল্লিশ উনচল্লিশ")
    e += words("চল্লিশ একচল্লিশ বিয়াল্লিশ তেতাল্লিশ চুয়াল্লিশ পঁয়তাল্লিশ ছেচল্লিশ সাতচল্লিশ আটচল্লিশ ঊনপঞ্চাশ উনপঞ্চাশ")
    e += words("পঞ্চাশ একান্ন বাহান্ন তিপ্পান্ন চুয়ান্ন পঞ্চান্ন ছাপ্পান্ন সাতান্ন আটান্ন ঊনষাট উনষাট")
    e += words("ষাট একষট্টি বাষট্টি তেষট্টি চৌষট্টি পঁয়ষট্টি ছেষট্টি সাতষট্টি আটষট্টি ঊনসত্তর উনসত্তর")
    e += words("সত্তর একাত্তর বাহাত্তর তিয়াত্তর চুয়াত্তর পঁচাত্তর ছিয়াত্তর সাতাত্তর আটাত্তর ঊনআশি উনআশি")
    e += words("আশি একাশি বিরাশি তিরাশি চুরাশি পঁচাশি ছিয়াশি সাতাশি আটাশি ঊননব্বই উননব্বই")
    e += words("নব্বই একানব্বই বিরানব্বই তিরানব্বই চুরানব্বই পঁচানব্বই ছিয়ানব্বই সাতানব্বই আটানব্বই নিরানব্বই")
    # hundreds: stem x {শো, শ, শত}
    stems = words("এক দুই দু তিন চার পাঁচ ছয় ছ সাত আট নয় ন")
    for s in stems:
        for suf in ("শো", "শ", "শত"):
            e.append(s + suf)
    e += words("শত শো হাজার লাখ লক্ষ কোটি")
    # fractions
    e += words("আধা আধ আধো অর্ধেক অর্ধ পোয়া সোয়া পৌনে দেড় আড়াই সাড়ে")
    # counter forms, very common for tablets ("দুটো ট্যাবলেট")
    e += words("একটা একটি দুটো দুটি তিনটে তিনটি তিনটা চারটে চারটি চারটা পাঁচটা পাঁচটি ছটা ছয়টা ছয়টি "
               "সাতটা সাতটি আটটা আটটি নয়টা নয়টি দশটা দশটি")
    e += [chr(c) for c in range(0x09E6, 0x09F0)]
    return e


# ───────────────────────────── Gujarati ─────────────────────────────
def gujarati():
    e = []
    e += words("શૂન્ય")
    e += words("એક બે ત્રણ ચાર પાંચ છ સાત આઠ નવ દસ")
    e += words("અગિયાર બાર તેર ચૌદ પંદર સોળ સત્તર અઢાર ઓગણીસ")
    e += words("વીસ એકવીસ બાવીસ ત્રેવીસ ચોવીસ પચ્ચીસ છવ્વીસ સત્તાવીસ અઠ્ઠાવીસ ઓગણત્રીસ")
    e += words("ત્રીસ એકત્રીસ બત્રીસ તેત્રીસ ચોત્રીસ પાંત્રીસ છત્રીસ સાડત્રીસ આડત્રીસ ઓગણચાલીસ")
    e += words("ચાલીસ એકતાલીસ બેતાલીસ ત્રેતાલીસ ચુંમાલીસ પિસ્તાલીસ છેતાલીસ સુડતાલીસ અડતાલીસ ઓગણપચાસ")
    e += words("પચાસ એકાવન બાવન ત્રેપન ચોપન પંચાવન છપ્પન સત્તાવન અઠ્ઠાવન ઓગણસાઠ")
    e += words("સાઠ એકસઠ બાસઠ ત્રેસઠ ચોસઠ પાંસઠ છાસઠ સડસઠ અડસઠ ઓગણસિત્તેર અગણોસિત્તેર")
    e += words("સિત્તેર એકોતેર બોતેર તોતેર ચુમોતેર પંચોતેર છોતેર સિત્યોતેર ઇઠ્યોતેર ઓગણએંસી")
    e += words("એંસી એક્યાસી બ્યાસી ત્યાસી ચોર્યાસી પંચાસી છ્યાસી સિત્યાસી ઈઠ્યાસી નેવ્યાસી")
    e += words("નેવું એકાણું બાણું ત્રાણું ચોરાણું પંચાણું છન્નું સત્તાણું અઠ્ઠાણું નવ્વાણું")
    e += words("સો બસો ત્રણસો ચારસો પાંચસો છસો સાતસો આઠસો નવસો હજાર લાખ કરોડ")
    e += words("અડધો અડધી અડધું અડધા અર્ધો પા પાવ પોણો પોણી પોણા સવા દોઢ અઢી સાડા")
    e += [chr(c) for c in range(0x0AE6, 0x0AF0)]
    return e


# v1.1 (Refuter omissions). Single tokens only: Telugu "నూట ముప్ఫై" is carried by its two components.
EXTRA = {
    "ta": "பாதி முன்னூறு ஐநூறு இருநூற்று முன்னூற்று நானூற்று ஐநூற்று அறுநூற்று எழுநூற்று எண்ணூற்று தொள்ளாயிரத்து",
    "te": "నూట ముప్ఫై",
    "mr": "दीडशे अडीचशे साडेसहाशे एकशे",
    "bn": "দেড়শো আড়াইশো কুড়ি",
    "gu": "એકસો દોઢસો અઢીસો",
}

LANGS = [("ta", tamil), ("te", telugu), ("ml", malayalam), ("mr", marathi), ("bn", bengali), ("gu", gujarati)]
LATIN = re.compile(r"[A-Za-z]")


def build():
    entries = {}
    for code, fn in LANGS:
        seen = set()
        out = []
        for w in fn() + words(EXTRA.get(code, "")):
            w = NFC(w).strip()
            assert w, (code, "empty")
            assert not LATIN.search(w), (code, w)
            if w not in seen:
                seen.add(w)
                out.append(w)
        entries[code] = sorted(out)
    return {
        "version": "1.1",
        "languages": [c for c, _ in LANGS],
        "entries": entries,
        "notes": (
            "Native-script number words for Tamil, Telugu, Malayalam, Marathi, Bengali, Gujarati; no romanised forms "
            "(follow-up). Cardinals 0-100, hundreds, thousand, lakh, crore, spoken fractions, digit characters. "
            "Matcher is SINGLE-TOKEN: spaced compounds (Telugu ఇరవై ఒకటి, Gujarati સાડા ત્રણ, Bengali সাড়ে তিন) are protected "
            "by their components; fused forms are added only where the script writes them fused (Tamil, Malayalam, Marathi, Bengali hundreds). Every entry is NFC "
            "(Bengali ড় ঢ় য় and Devanagari nukta letters are therefore stored decomposed, matching how the base "
            "lexicon stores Hindi डेढ़ and हज़ार). Malayalam carries the atomic-chillu spelling and the legacy "
            "consonant+virama+ZWJ spelling, and the written -ു ending variants. v1.1 adds joined hundreds (Tamil/Malayalam), half/one-and-half hundreds (Marathi/Bengali/Gujarati), Tamil பாதி, Bengali কুড়ি, Telugu నూట ముప్ఫై (as components). Generated by "
            "gen_number_words_indic_v1.py in this directory."
        ),
    }


if __name__ == "__main__":
    json.dump(build(), sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
