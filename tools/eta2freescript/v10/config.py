"""FRX-V10 switch. ACTIVE is the shipped behaviour (pipeline 3.0.0). It is a code constant, not an environment flag: tests that pin the retired
2.5.0 medicine path set it False inside a fixture and put it back. Nothing in production sets it."""
ACTIVE = True
