"""PHI masking on invented strings. No real identifiers."""

from __future__ import annotations

from tools.timbre.phi_mask import (
    TAG_ADDRESS,
    TAG_AGE,
    TAG_DOB,
    TAG_EMAIL,
    TAG_ID,
    TAG_PATIENT_NAME,
    TAG_PHONE,
    mask_phi,
    residual_kinds,
)


def test_masks_phone_email_aadhaar_pan_and_labeled_id():
    raw = (
        "Call 9876543210 or +91 98765 43210. "
        "Mail example.person@example.com. "
        "Aadhaar 2345 6789 0123. PAN ABCDE1234F. UHID AB12CD99."
    )
    masked = mask_phi(raw)
    assert "9876543210" not in masked.text
    assert "98765 43210" not in masked.text
    assert "example.com" not in masked.text
    assert "2345 6789 0123" not in masked.text
    assert "ABCDE1234F" not in masked.text
    assert "AB12CD99" not in masked.text
    assert masked.counts[TAG_PHONE] >= 2
    assert masked.counts[TAG_EMAIL] == 1
    assert masked.counts[TAG_ID] >= 3
    assert masked.residual == ()
    assert residual_kinds(raw) == ("email", "aadhaar", "pan", "phone")


def test_masks_name_cues_dob_age_and_address_and_keeps_doctor_and_clinical_words():
    raw = (
        "Mr. Ramesh Kumar said the pain is worse. Dr Shah said rest. "
        "my name is Anita and I slept. DOB: 01/02/1980. He is 92 years old. "
        "age 40. 5 years old. pin code 560001. flat no 12B. 14 MG Road."
    )
    masked = mask_phi(raw)
    assert "Ramesh" not in masked.text
    assert "Anita" not in masked.text
    assert "Dr Shah" in masked.text
    assert "the pain is worse" in masked.text
    assert "age 40" in masked.text
    assert "5 years old" in masked.text
    assert "01/02/1980" not in masked.text
    assert "92" not in masked.text
    assert "560001" not in masked.text
    assert "12B" not in masked.text
    assert TAG_PATIENT_NAME in masked.text
    assert TAG_DOB in masked.text
    assert TAG_AGE in masked.text
    assert TAG_ADDRESS in masked.text
    assert masked.residual == ()


def test_existing_tags_are_not_rewritten():
    raw = "Already [PHONE] and [PATIENT_NAME] in the note."
    masked = mask_phi(raw)
    assert masked.text == raw
    assert masked.counts == {}


def test_counts_do_not_contain_the_source_span():
    raw = "Mr Example Person phone 9123456780"
    masked = mask_phi(raw)
    blob = str(masked.counts)
    assert "Example" not in blob
    assert "9123456780" not in blob
