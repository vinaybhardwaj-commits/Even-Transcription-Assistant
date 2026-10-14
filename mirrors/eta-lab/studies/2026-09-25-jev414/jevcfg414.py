#!/usr/bin/env python3
"""r414.2 FROZEN Jev wording for label200 / ba106 / rate20 (split-speaker, 25 Sep 2026).
Single source of truth; sha256 of this file is posted to eta-refuter BEFORE any Jev run.
Trials: JEV-414-TRIALS.md. No real text here; fixtures only there.
Binding rule (discovered in trials): every question's instructions MUST name the state
entry key it refers to, else answers collapse flat (~0.2 conf, one class dominates).
"""
import json

MODEL = "jev-latest"  # jev-1.13.0 answered the trials
BATCH = 8             # items per jev_ask call

LABEL200 = {
    "version": "lv1.2",  # lv1.1 + eta-refuter #2838 fixes 1 and readable tweak
    "type": "choice",
    "instructions": (
        "One line from a clinical speech-to-text transcription: claimed language, "
        "original text, literal machine English gloss. Judge the LINE ITSELF (not "
        "gloss quality): is it usable as a transcription of real speech in this "
        "corpus? Answer ONLY about the state entry named {K}; ignore every other "
        "entry in the state."
    ),
    "criteria": {
        "readable": (
            "Coherent clinical speech in the claimed language and its usual script; "
            "the line itself reads as a sensible sentence (the gloss may help)."
        ),
        "romanised_readable": (
            "An Indic language written in Latin letters that a fluent reader of that "
            "language can follow; imperfect spelling or spacing is fine."
        ),
        "garbled": (
            "Not coherent in any language: word salad, looped repeats, fragments, or "
            "a gloss that shows nonsense."
        ),
        "wrong_language": (
            "Fluent, coherent text whose language or script is plainly not the "
            "claimed language. Claim 'und' means the engine gave no language; there, "
            "coherent clinical speech in English or in any Indic language is "
            "readable (or romanised_readable). Only a non-clinical register (song "
            "lyrics, verse, video or subtitle phrases, stock lines such as 'thank "
            "you for watching') is wrong_language."
        ),
        "cannot_tell": "Too short or ambiguous to judge either way.",
    },
    "state_entry_fields": ["claimed_lang", "text", "gloss_en"],
}

BA106 = {
    "version": "bv1.2",  # bv1.1 + eta-refuter #2838 fix 2 (no-audio plausibility)
    "type": "choice",
    "instructions": (
        "Two candidate transcriptions A and B of the SAME utterance are given, each "
        "with a literal machine English gloss. You cannot hear the audio. Judge which "
        "candidate is more plausible as a transcription of a real clinical utterance "
        "in the claimed language. Do NOT prefer a candidate for being fluent if it "
        "reads like a generic stock phrase unrelated to a clinical conversation "
        "(greetings to viewers, subscriptions, lyrics, repeated sentences). If you "
        "cannot tell which is closer, answer cannot_tell. Answer ONLY about the "
        "state entry named {K}; ignore every other entry."
    ),
    "criteria": {
        "A_better": "A is clearly more usable as a transcription of the utterance than B.",
        "B_better": "B is clearly more usable as a transcription of the utterance than A.",
        "same": (
            "Both candidates are each readable, coherent transcriptions of the "
            "utterance with no clear edge to either."
        ),
        "neither_readable": (
            "Neither candidate can be read as a transcription of anything: if both "
            "are unusable, choose this and not same."
        ),
        "cannot_tell": "The comparison cannot be decided from the material.",
    },
    "state_entry_fields": ["claimed_lang", "text_A", "text_B", "gloss_A", "gloss_B"],
}

RATE20 = {
    "version": "rv1.1",
    "type": "choice",
    "instructions": (
        "An excerpt of several lines from an ambient room transcription, with its "
        "claimed languages and a literal machine English gloss. Is the excerpt "
        "readable as clinical speech by someone who knows the language? Answer ONLY "
        "about the state entry named {K}; ignore every other entry."
    ),
    "criteria": {
        "yes": (
            "The excerpt reads as coherent clinical speech (native script or "
            "romanised) throughout."
        ),
        "partly": "Only some lines are usable; the rest is filler, loops, or broken.",
        "no": "The excerpt is not usable: incoherent, looped, or nonsense per the gloss.",
        "cannot_tell": "Too short or ambiguous to judge.",
    },
    "state_entry_fields": ["langs", "text", "gloss_en"],
}

SETS = {"label200": LABEL200, "ba106": BA106, "rate20": RATE20}


def questions_for(wording, keys):
    return {
        k: {
            "type": wording["type"],
            "instructions": wording["instructions"].replace("{K}", k),
            "criteria": wording["criteria"],
        }
        for k in keys
    }


def batches(keys, size=BATCH):
    return [keys[i:i + size] for i in range(0, len(keys), size)]


if __name__ == "__main__":
    print(json.dumps({s["version"] for s in SETS.values()}, sort_keys=True))
