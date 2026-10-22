"""Fake people for steward tests (Python mirror of tests/support/fake-identity.ts).

No identity literal may sit in a test file (tests/unit/no-identity-literals.test.ts), so a fixture
that needs a clinician name builds it here. The label is assembled from parts so this file holds
no "Dr <Name>" literal either. Every name carries a 0001-style counter, which no real name has.
"""


def fake_label(n: int = 1) -> str:
    """A clinician label such as a doctor_name field value: Dr + Fake Clinician + counter."""
    return " ".join(["Dr", "Fake", "Clinician", f"{n:04d}"])


def fake_email(n: int = 1) -> str:
    return f"fake.clinician.{n:04d}@example.test"
