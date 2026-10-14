"use client";

import { useEffect, useRef, useState } from "react";

type Shot = { id: string; file: File; url: string };

const MAX_EDGE = 1600;

async function shrinkRaster(file: File): Promise<File> {
  const heic = /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (heic) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return file;
    const stem = file.name.replace(/\.[^.]+$/, "") || "ot-sheet";
    return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function CaptureClient({ initialHostLabel }: { initialHostLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [hostLabel, setHostLabel] = useState(initialHostLabel);

  useEffect(() => {
    setHostLabel(
      window.location.hostname.startsWith("upload.governance.")
        ? window.location.host
        : `${window.location.host}/capture`,
    );
    fetch("/api/capture/upload")
      .then((response) => response.json())
      .then((json: { enabled?: boolean }) => setEnabled(json.enabled === true))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (sent != null) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraOn(false);
      return;
    }
    let cancelled = false;
    async function open() {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraOn(false);
        setCameraNote("This browser has no camera. Use Gallery.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraOn(true);
        setCameraNote(null);
      } catch {
        if (!cancelled) {
          setCameraOn(false);
          setCameraNote("Camera permission is off. Use Gallery, or allow the camera and tap Flip.");
        }
      }
    }
    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [facing, sent]);

  function addShot(file: File) {
    const shot: Shot = { id: `${Date.now()}-${file.name}-${Math.random()}`, file, url: URL.createObjectURL(file) };
    setShots((current) => [...current, shot].slice(0, 8));
    setError(null);
    setSent(null);
  }

  async function takePhoto() {
    const video = videoRef.current;
    if (!video || !cameraOn || video.videoWidth < 2) {
      setError("Camera is not ready. Use Gallery.");
      return;
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) {
      setError("Could not read a frame from the camera.");
      return;
    }
    addShot(new File([blob], `ot-sheet-${Date.now()}.jpg`, { type: "image/jpeg" }));
  }

  async function onGallery(list: FileList | null) {
    if (!list) return;
    const next: File[] = [];
    for (const file of Array.from(list)) next.push(await shrinkRaster(file));
    next.forEach(addShot);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeShot(id: string) {
    setShots((current) => {
      const shot = current.find((item) => item.id === id);
      if (shot) URL.revokeObjectURL(shot.url);
      return current.filter((item) => item.id !== id);
    });
  }

  async function submit() {
    if (shots.length < 1 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("hospital_code", "EHRC");
      body.set("uploaded_by", name);
      shots.forEach((shot) => body.append("files", shot.file, shot.file.name));
      const response = await fetch("/api/capture/upload", { method: "POST", body });
      const json = (await response.json()) as { ok?: boolean; error?: string; captures?: unknown[] };
      if (!response.ok || !json.ok) {
        setError(json.error || "Upload was rejected.");
        return;
      }
      setSent(Array.isArray(json.captures) ? json.captures.length : shots.length);
    } catch {
      setError("Upload failed. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    shots.forEach((shot) => URL.revokeObjectURL(shot.url));
    setShots([]);
    setSent(null);
    setError(null);
  }

  return (
    <>
      <div className="bg-[#1c1917] px-3 py-[0.45rem] text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-50">
        <span className="text-teal-300">Stage 1</span>
        <span> · OT Sheet Capture · store only</span>
      </div>
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-[420px] flex-col bg-[#0c0a09]">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
          <span className="font-mono text-[11px] text-stone-400">{hostLabel}</span>
          <span className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-bold tracking-wide text-white">EHRC</span>
        </div>

        {sent != null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-full bg-brand-soft text-2xl font-bold text-[#0d5f58]">✓</div>
            <div className="text-xl font-bold">Sent</div>
            <div className="rounded-full bg-indigo-950 px-3 py-1.5 text-xs font-semibold text-indigo-200">
              In queue · OCR soon
            </div>
            <p className="max-w-[280px] text-sm leading-relaxed text-stone-400">
              {sent} photo{sent === 1 ? "" : "s"} stored for Governance review. Status starts{" "}
              <strong className="text-teal-300">queued</strong>. Staff OCR runs when it is switched on.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-2 w-full max-w-[240px] rounded-xl bg-brand py-3 text-sm font-bold text-white"
            >
              Capture another
            </button>
            <p className="mt-3 text-[11px] text-stone-500">Staff queue is on governance.evenos.app · login required</p>
          </div>
        ) : (
          <>
            <div
              className="relative mx-4 flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-2xl border-2 border-stone-700 bg-gradient-to-b from-stone-800 to-[#0c0a09]"
              aria-label="Camera viewfinder"
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={"absolute inset-0 h-full w-full object-cover " + (cameraOn ? "" : "hidden")}
              />
              {!cameraOn && <div className="h-[62%] w-[78%] rounded-lg border-2 border-dashed border-teal-300/40" />}
              <div className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-[13px] text-stone-400">
                {cameraNote || "Align OT Tracking Sheet"}
              </div>
            </div>

            <div className="flex flex-col gap-3 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
              {enabled === false && (
                <p className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-center text-xs text-amber-100">
                  Capture is off on this deployment. Uploads will be rejected until FEATURE_OT_CAPTURE is true.
                </p>
              )}
              <label className="text-[11px] text-stone-400" htmlFor="uploader-name">
                Your name <span className="font-medium">(optional · provenance)</span>
              </label>
              <input
                id="uploader-name"
                value={name}
                maxLength={120}
                autoComplete="name"
                placeholder="e.g. OT coordinator — floor 2"
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-[10px] border border-stone-700 bg-stone-900 px-3 py-2.5 text-sm text-stone-50 outline-none placeholder:text-stone-500 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30"
              />

              <div className="flex min-h-[64px] gap-2 overflow-x-auto py-1" aria-label="Batch photos">
                {shots.map((shot, index) => (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => removeShot(shot.id)}
                    className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-stone-600"
                    title="Remove photo"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={shot.url} alt="" className="h-full w-full object-cover" />
                    <span className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-brand text-[9px] font-bold text-white">
                      {index + 1}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="grid h-12 w-12 place-items-center rounded-xl border border-stone-700 bg-stone-900 text-[11px] font-semibold leading-tight text-stone-200"
                >
                  Gallery
                  <span aria-hidden>📁</span>
                </button>
                <button
                  type="button"
                  onClick={() => void takePhoto()}
                  aria-label="Take photo"
                  className="relative h-[72px] w-[72px] rounded-full border-4 border-stone-200 bg-white shadow-[0_0_0_4px_rgba(255,255,255,0.12)] active:scale-95"
                >
                  <span className="absolute inset-[6px] rounded-full border-2 border-stone-900" />
                </button>
                <button
                  type="button"
                  onClick={() => setFacing((current) => (current === "environment" ? "user" : "environment"))}
                  className="grid h-12 w-12 place-items-center rounded-xl border border-stone-700 bg-stone-900 text-[11px] font-semibold leading-tight text-stone-200"
                >
                  Flip
                  <span aria-hidden>🔄</span>
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
                multiple
                className="hidden"
                onChange={(event) => void onGallery(event.target.files)}
              />

              <button
                type="button"
                disabled={shots.length < 1 || busy}
                onClick={() => void submit()}
                className="w-full rounded-xl bg-brand py-3.5 text-[15px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Sending…" : "Submit to queue"}
              </button>
              {error && <p className="text-center text-xs text-red-300">{error}</p>}
              <p className="text-center text-[11px] leading-relaxed text-stone-500">
                No login · shared staff link · Stage 1 store + queue. OCR lands Stage 2.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}
