import { describe, it, expect } from "vitest";
import { slugifyName, buildDoctorSlug, parseDoctorSlug } from "../../lib/doctor-slug";

describe("slugifyName", () => {
  it("lowercases and hyphenates, stripping punctuation", () => {
    expect(slugifyName("Dr. Vinay Bhardwaj")).toContain("vinay-bhardwaj");
  });
});

describe("buildDoctorSlug / parseDoctorSlug roundtrip", () => {
  it("parses back the token from a built slug", () => {
    const { full, token } = buildDoctorSlug("Ankit Bhojani");
    const parsed = parseDoctorSlug(full);
    expect(parsed).not.toBeNull();
    expect(parsed!.token).toBe(token);
  });
  it("returns null for a slug with no token", () => {
    expect(parseDoctorSlug("justaname")).toBeNull();
  });
});
