import { describe, it, expect } from "vitest";
import { slugifyName, buildDoctorSlug, parseDoctorSlug } from "../../lib/doctor-slug";
import { makeFakeClinician } from "../support/fake-identity";

describe("slugifyName", () => {
  it("lowercases and hyphenates, stripping punctuation", () => {
    const c = makeFakeClinician(1);
    expect(slugifyName(`Dr. ${c.full_name}`)).toContain("fake-clinician-0001");
  });
});

describe("buildDoctorSlug / parseDoctorSlug roundtrip", () => {
  it("parses back the token from a built slug", () => {
    const { full, token } = buildDoctorSlug(makeFakeClinician(2).full_name);
    const parsed = parseDoctorSlug(full);
    expect(parsed).not.toBeNull();
    expect(parsed!.token).toBe(token);
  });
  it("returns null for a slug with no token", () => {
    expect(parseDoctorSlug("justaname")).toBeNull();
  });
});
