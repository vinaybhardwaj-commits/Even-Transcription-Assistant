"""Script detection on invented strings."""

from tools.timbre.lang import detect_language


def test_clinic_scripts_and_code_mix():
    assert detect_language("ನಿದ್ದೆ ಬರುತ್ತಿಲ್ಲ").language == "kn"
    assert detect_language("नींद नहीं आ रही").language == "hi"
    assert detect_language("தூக்கம் வரலை").language == "ta"
    assert detect_language("నిద్ర పట్టడం లేదు").language == "te"
    assert detect_language("sleep is poor").language == "en"
    mixed = detect_language("ನಿದ್ದೆ is poor")
    assert mixed.language == "code_mixed"
    assert mixed.code_mixed is True
    assert detect_language("").language == "unknown"


def test_romanised_marker_without_calling_ji_a_language():
    assert detect_language("nange ide").language == "kn"
    assert detect_language("nange pain ide").code_mixed is True
    assert detect_language("naku undi").language == "te"
    # "ji" is an honorific, not evidence of Hindi.
    assert detect_language("yes ji").language == "en"
