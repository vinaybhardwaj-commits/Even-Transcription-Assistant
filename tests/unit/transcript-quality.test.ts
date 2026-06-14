import { describe, it, expect } from "vitest";
import { assessTranscriptQuality } from "../../lib/transcript-quality";

const VARIED = `The patient is a forty year old presenting with intermittent abdominal pain
radiating to the back since three days, associated with nausea but no vomiting or fever.
On examination the abdomen is soft, mild tenderness in the epigastrium, bowel sounds present.
We discussed differentials including gastritis and early pancreatitis, advised an ultrasound,
started pantoprazole twice daily and a short course of antispasmodics, with review in one week
or sooner if pain worsens, jaundice appears, or vomiting becomes persistent. Family counselled.`;

describe("assessTranscriptQuality — patient-safety guardrail", () => {
  it("empty transcript → empty", () => {
    expect(assessTranscriptQuality("", 300).flag).toBe("empty");
    expect(assessTranscriptQuality(null, 300).flag).toBe("empty");
  });
  it("hallucination loop → low_quality", () => {
    expect(assessTranscriptQuality("I am pregnant. ".repeat(25), 480).flag).toBe("low_quality");
  });
  it("implausibly short for long audio → short", () => {
    expect(assessTranscriptQuality("Patient has a cough.", 480).flag).toBe("short");
  });
  it("a normal, varied consult transcript → no flag", () => {
    const good = (VARIED + " ").repeat(4); // realistic length + vocabulary
    expect(assessTranscriptQuality(good, 300).flag).toBeNull();
  });
  it("repetitive-but-legitimate medical text is NOT over-flagged as low_quality", () => {
    // lots of 'no' negatives — common in real notes; should not trip the loop check
    const negs = "No fever. No cough. No chest pain. No shortness of breath. No vomiting. "
      + VARIED;
    const q = assessTranscriptQuality((negs + " ").repeat(3), 300);
    expect(q.flag).not.toBe("low_quality");
  });
  it("short clip judged leniently under 45s", () => {
    expect(["short", null]).toContain(assessTranscriptQuality("Follow up in two weeks.", 20).flag);
  });
});
