export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const CAPTURE_MAX_FILES = 8;
export const CAPTURE_HOSPITALS = ["EHRC", "EHBR", "EHBO", "EHIN"] as const;
export type HospitalCode = (typeof CAPTURE_HOSPITALS)[number];
export const DEFAULT_HOSPITAL: HospitalCode = "EHRC";

const EXT_BY_TYPE: Record<string, "jpg" | "png" | "webp" | "heic" | "heif"> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export interface ResolvedImageType {
  contentType: string;
  ext: "jpg" | "png" | "webp" | "heic" | "heif";
}

export function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function resolveImageType(contentType: string, filename: string): ResolvedImageType | null {
  const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const fromType = EXT_BY_TYPE[declared];
  if (fromType) {
    return {
      contentType: fromType === "jpg" ? "image/jpeg" : declared === "image/jpg" ? "image/jpeg" : declared,
      ext: fromType,
    };
  }
  const ext = extensionOf(filename);
  const mapped = TYPE_BY_EXT[ext];
  if (!mapped) return null;
  const resolvedExt = ext === "jpeg" ? "jpg" : (ext as ResolvedImageType["ext"]);
  return { contentType: mapped, ext: resolvedExt };
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

/** Reject renamed HTML/PDF. HEIC is an ISO BMFF file with an ftyp box. */
export function looksLikeImage(bytes: Uint8Array, ext: ResolvedImageType["ext"]): boolean {
  if (ext === "jpg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (ext === "png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === "webp") {
    return (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  if (bytes.length < 12) return false;
  const box = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
  return box === "ftyp";
}

export interface IncomingImage {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface PlannedImage {
  filename: string;
  contentType: string;
  ext: ResolvedImageType["ext"];
  bytes: Uint8Array;
}

export function planImages(
  files: IncomingImage[],
): { ok: true; images: PlannedImage[] } | { ok: false; error: string; status: number } {
  if (files.length < 1) {
    return { ok: false, status: 400, error: "Choose at least one image." };
  }
  if (files.length > CAPTURE_MAX_FILES) {
    return { ok: false, status: 400, error: `At most ${CAPTURE_MAX_FILES} images per upload.` };
  }
  const images: PlannedImage[] = [];
  for (const file of files) {
    const name = (file.filename || "ot-sheet").slice(0, 180);
    const resolved = resolveImageType(file.contentType || "", name);
    if (!resolved) {
      return {
        ok: false,
        status: 400,
        error: `${name}: only JPEG, PNG, WEBP, or HEIC images can be stored.`,
      };
    }
    if (file.bytes.byteLength < 1) {
      return { ok: false, status: 400, error: `${name} is empty.` };
    }
    if (file.bytes.byteLength > CAPTURE_MAX_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `${name} is larger than 4 MB. Use the camera shutter, which saves a smaller JPEG.`,
      };
    }
    if (!looksLikeImage(file.bytes, resolved.ext)) {
      return { ok: false, status: 400, error: `${name} is not a valid ${resolved.ext.toUpperCase()} image.` };
    }
    images.push({
      filename: name,
      contentType: resolved.contentType,
      ext: resolved.ext,
      bytes: file.bytes,
    });
  }
  return { ok: true, images };
}

export function normalizeHospital(
  raw: unknown,
): { ok: true; code: HospitalCode } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, code: DEFAULT_HOSPITAL };
  if (typeof raw !== "string") return { ok: false, error: "invalid hospital_code" };
  const code = raw.trim().toUpperCase();
  if (!CAPTURE_HOSPITALS.includes(code as HospitalCode)) {
    return { ok: false, error: "invalid hospital_code" };
  }
  return { ok: true, code: code as HospitalCode };
}

export function isHospitalCode(value: string): value is HospitalCode {
  return CAPTURE_HOSPITALS.includes(value as HospitalCode);
}
