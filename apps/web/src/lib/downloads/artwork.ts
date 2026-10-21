import {
  artworkUrl,
  backdropWidths,
  type ItemDetail,
  posterWidths,
} from "../browse.ts";

// The largest poster, and a backdrop sharp on most screens.
const posterWidth = posterWidths[3];
const landscapeWidth = backdropWidths[2];

/**
 * The artwork a download keeps so its pages draw offline: the Item's and its
 * Show's poster, backdrop, logo and thumb, each saved once at a width every
 * screen can scale down from.
 */
export function offlineArtwork(
  detail: ItemDetail,
): { id: string; url: string }[] {
  const wanted = [
    [detail.posterArtworkId, posterWidth],
    [detail.show?.posterArtworkId, posterWidth],
    [detail.backdropArtworkId, landscapeWidth],
    [detail.thumbArtworkId, landscapeWidth],
    [detail.logoArtworkId, landscapeWidth],
    [detail.show?.backdropArtworkId, landscapeWidth],
    [detail.show?.logoArtworkId, landscapeWidth],
  ] as const;
  const saved = new Map<string, number>();
  for (const [id, width] of wanted)
    if (typeof id === "string" && !saved.has(id)) saved.set(id, width);
  return [...saved].map(([id, width]) => ({ id, url: artworkUrl(id, width) }));
}

/** The folder under `downloads/` that holds saved artwork, one file per artwork id. */
export function artworkFolder(
  downloads: FileSystemDirectoryHandle,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  return downloads.getDirectoryHandle("artwork", { create });
}

/** A download's saved copy of an artwork, which the service worker answers with offline. */
export async function savedArtwork(
  root: FileSystemDirectoryHandle,
  id: string,
): Promise<File | undefined> {
  try {
    const folder = await artworkFolder(
      await root.getDirectoryHandle("downloads"),
    );
    return await (await folder.getFileHandle(id)).getFile();
  } catch {
    return undefined;
  }
}
