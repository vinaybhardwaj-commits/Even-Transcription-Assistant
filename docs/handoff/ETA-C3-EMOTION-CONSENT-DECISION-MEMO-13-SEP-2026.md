# ETA C3 — decision record: emotion is computed for all speakers

**Date:** 13 September 2026
**Decided by:** V
**Status:** DECIDED. Recorded by order of the C3 rulings.

## The question
Speech-emotion inference on room audio produces model output about every person who speaks in a
consultation room, not only clinicians. Computing and storing that output is itself processing of
personal data (India's Digital Personal Data Protection Act), independent of whether anything is
ever shown to anyone. The C3 plan raised this as needing a ruling before `EMOTION_ENABLED`, not only
before anything surfaces.

## The decision, in V's words
> "We already take detailed consent from every patient. This is a non issue. Do it for all speakers."

## The basis named
The existing consent every patient gives before care — described by V as detailed consent taken
from every patient. The decision rests on that consent covering this processing.

## What it permits, and what it does not change
- `emotion_window` scores **every speaker** in a diarized window: speakers matched to an enrolled
  voiceprint and speakers with no match alike.
- It does **not** change ruling G. An unmatched speaker may be a clinician whose match failed, a nurse,
  an attender, or anyone else. No field, name, index or description may imply what kind of person an
  unmatched speaker is. Role comes only from a successful voiceprint match.
- It does **not** change ruling 3. `EMOTION_SURFACE_ENABLED` still gates anything a clinician can see,
  and nothing surfaces until V signs off on validation.
- Both flags ship unset.

## Not verified by the Builder
The content and scope of the existing patient consent were not seen by the Builder. The decision is
recorded as V stated it.
