import {
  COMPOSER_IMAGE_TYPES,
  loadComposerImage,
  type ComposerImageType,
} from "./composer-image";

/**
 * What the USER decided to call somebody, and the face they gave them.
 *
 * Microsoft Teams holds neither — a colleague's display name and photo are theirs to
 * set — so both are LOCAL overrides, stored in this app's own store and never published
 * back (see `person_overrides` in src/store.rs). This module holds the two limits the
 * backend enforces and the reader that turns a picked file into what it accepts, so the
 * user is told about their own file here rather than by a refusal from the socket.
 */

/** Longest nickname accepted, matching `MAX_PERSON_NAME_BYTES` in the backend.
 *
 *  Counted in UTF-16 code units here (what `maxLength` bounds) against the backend's
 *  bytes, so the field is the stricter of the two for a non-ASCII name — a limit that
 *  stops the typing is better than one that rejects the save. */
export const MAX_PERSON_NAME_LENGTH = 120;

/** Largest picture accepted, matching `MAX_PERSON_AVATAR_BYTES` in the backend.
 *
 *  Much tighter than the composer's: an avatar is drawn at 64px at most and lives in
 *  the store for good, so there is nothing to gain from a 10 MiB original. */
export const PERSON_AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** The four raster formats accepted, and for the same reason the composer accepts them:
 *  every browser decodes them, and they are what the backend's own allowlist names
 *  (`PERSON_AVATAR_TYPES` in src/bin/server.rs). SVG is deliberately absent — it is a
 *  document, not a bitmap, and an avatar has no need to be one. */

/** The `accept` attribute for the file input. */
export function personAvatarAccept(): string {
  return COMPOSER_IMAGE_TYPES.join(",");
}

/** Why this file cannot be an avatar, or `null` when it can. Checked here so the user
 *  reads one sentence about their own file instead of a backend refusal. */
export function personAvatarError(file: Pick<File, "size" | "type">): string | null {
  if (!(COMPOSER_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Choose a PNG, JPEG, GIF, or WebP image.";
  }
  if (file.size > PERSON_AVATAR_MAX_BYTES) {
    return "Choose an image that is 2 MiB or smaller.";
  }
  return null;
}

/** A picture the user picked, ready for `set_person_avatar`, plus a data URL to
 *  preview it with before they commit. */
export type PersonAvatarPick = {
  content_type: ComposerImageType;
  data_base64: string;
  previewUrl: string;
};

/** Read a picked file into the shape the backend takes. Throws with a sentence the UI
 *  can show when the file is not a usable image. */
export async function loadPersonAvatar(file: File): Promise<PersonAvatarPick> {
  const problem = personAvatarError(file);
  if (problem) throw new Error(problem);
  // The composer's reader already decodes and base64-encodes exactly this set of
  // formats; its own (looser) size cap can never fire, since ours is checked above.
  const image = await loadComposerImage(file);
  return {
    content_type: image.contentType,
    data_base64: image.dataBase64,
    previewUrl: image.previewUrl,
  };
}
