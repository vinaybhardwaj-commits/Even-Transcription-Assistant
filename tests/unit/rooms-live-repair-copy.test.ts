/** Sentinel S1: the Rooms Live repair copy follows the room's device (room_install.expected_device_name), not always the webcam. */
import { describe, it, expect } from "vitest";
import { STILL_NOT_WORKING, stepsFor } from "@/lib/rooms-live/present";
import { deviceClass } from "@/lib/steward/device-class";

const WAIT = "Wait 30 seconds. The card clears by itself.";
// the copy as it was at bffc52f7, before the device split: the webcam text must stay byte for byte
const OLD_MUTED = "Check the webcam's USB cable is pushed firmly into the back of the room computer. If it does not clear in 5 minutes, tell IT.";
const OLD_UNPLUGGED = "The computer cannot find the webcam mic. Push the webcam's USB cable firmly into the back of the room computer.";

describe("device class from the expected device name", () => {
  it("TONOR, C270/webcam, and anything else (or nothing) is unknown", () => {
    expect(deviceClass("TONOR TM20 Audio Device")).toBe("tonor");
    expect(deviceClass("C270 HD WEBCAM")).toBe("webcam");
    expect(deviceClass("Logitech Webcam")).toBe("webcam");
    expect(deviceClass("MacBook Air Microphone")).toBe("unknown");
    expect(deviceClass(null)).toBe("unknown");
    expect(deviceClass("")).toBe("unknown");
  });
});

describe("repair copy by device", () => {
  it("TONOR silent", () => {
    expect(stepsFor("muted", deviceClass("TONOR TM20 Audio Device"))).toEqual(["The TONOR mic may be muted. Ask the doctor to press the mute button on the mic. If it stays silent, check its USB cable."]);
  });
  it("TONOR unplugged", () => {
    expect(stepsFor("unplugged", deviceClass("TONOR TM20 Audio Device"))).toEqual(["The TONOR mic is not connected. Check its USB cable at the back of the room computer.", WAIT, STILL_NOT_WORKING]);
  });
  it("C270 silent: byte-identical to the old webcam text", () => {
    expect(stepsFor("muted", deviceClass("C270 HD WEBCAM"))).toEqual([OLD_MUTED]);
    expect(stepsFor("muted", deviceClass("C270 HD WEBCAM"))[0]).toMatchInlineSnapshot(`"Check the webcam's USB cable is pushed firmly into the back of the room computer. If it does not clear in 5 minutes, tell IT."`);
  });
  it("C270 unplugged: byte-identical to the old webcam text", () => {
    expect(stepsFor("unplugged", deviceClass("C270 HD WEBCAM"))).toEqual([OLD_UNPLUGGED, WAIT, STILL_NOT_WORKING]);
    expect(stepsFor("unplugged", deviceClass("C270 HD WEBCAM"))[0]).toMatchInlineSnapshot(`"The computer cannot find the webcam mic. Push the webcam's USB cable firmly into the back of the room computer."`);
  });
  it("unknown silent", () => {
    expect(stepsFor("muted", deviceClass("Some USB Mic"))).toEqual(["The microphone is sending only silence. Check the microphone's USB cable at the back of the room computer."]);
    expect(stepsFor("muted")).toEqual(stepsFor("muted", "unknown"));
  });
  it("unknown unplugged", () => {
    expect(stepsFor("unplugged", deviceClass(null))).toEqual(["The computer cannot find the microphone. Check the microphone's USB cable at the back of the room computer.", WAIT, STILL_NOT_WORKING]);
  });
  it("other states do not depend on the device", () => {
    for (const s of ["notrec", "off", "unknown", "listening", "quiet"] as const) expect(stepsFor(s, "tonor")).toEqual(stepsFor(s, "webcam"));
  });
});
