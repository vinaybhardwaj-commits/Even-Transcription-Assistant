import "server-only";
import { del, get, put } from "@vercel/blob";

export interface StoredBlob {
  url: string;
  pathname: string;
}

/**
 * Private blob: the returned URL is not anonymously readable.
 * Staff bytes go through the authenticated image proxy, which calls get().
 */
export async function storeCaptureBlob(
  pathname: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoredBlob> {
  const result = await put(pathname, Buffer.from(bytes), {
    access: "private",
    contentType,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
  });
  return { url: result.url, pathname: result.pathname };
}

export async function readCaptureBlob(pathname: string) {
  return get(pathname, { access: "private", useCache: false });
}

export async function deleteCaptureBlob(urlOrPathname: string): Promise<void> {
  await del(urlOrPathname);
}
