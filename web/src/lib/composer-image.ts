export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** How many pictures one message carries. The same ceiling as the backend's
 *  `teams_send::MAX_IMAGES`, which is what actually refuses an eleventh — this is the
 *  half that says so before the user presses Send. */
export const COMPOSER_IMAGE_MAX_COUNT = 10;

/** What all the pictures of one message may weigh together — `MAX_IMAGES_TOTAL_BYTES`.
 *
 *  It is mirrored HERE and not only at the backend because the three ceilings have to
 *  close: ten pictures of just under 10 MiB each pass the other two, and the request
 *  they build is ~133 MiB of base64 — over the socket's own read limit
 *  (`MAX_REQUEST_BYTES`), which is a protocol error rather than a refusal. The
 *  connection drops, and the composer then says the backend is unreachable, which is
 *  both wrong and unactionable. Stated here, the batch is refused with a sentence that
 *  names what to do, and no frame this app builds can reach that limit. */
export const COMPOSER_IMAGE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export const COMPOSER_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ComposerImageType = (typeof COMPOSER_IMAGE_TYPES)[number];

export type ComposerImage = {
  /** Identity for the pending list: two pastes of one screenshot are two pictures, so
   *  neither the name nor the bytes can tell them apart. */
  id: number;
  name: string;
  contentType: ComposerImageType;
  width: number;
  height: number;
  /** The file's own size, which is what the ceilings are counted in — the backend adds
   *  up the same decoded bytes (`parse_images`), so both sides refuse the same batch. */
  bytes: number;
  dataBase64: string;
  previewUrl: string;
};

export type SendImage = Omit<ComposerImage, "previewUrl" | "id" | "bytes">;

const ACCEPTED_TYPES = new Set<string>(COMPOSER_IMAGE_TYPES);

export function composerImageAccept(): string {
  return COMPOSER_IMAGE_TYPES.join(",");
}

export function imageFileError(file: Pick<File, "size" | "type">): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) {
    return "Select a PNG, JPEG, GIF, or WebP image.";
  }
  if (file.size > COMPOSER_IMAGE_MAX_BYTES) {
    return "Select an image that is 10 MiB or smaller.";
  }
  return null;
}

const MIB = 1024 * 1024;

/** Why `file` cannot join pictures already weighing `stagedBytes`, or null when it can.
 *
 *  Checked on the file rather than on the decoded picture, so the batch is refused before
 *  anything is read — and the sentence names the one thing left to do, because a message
 *  that cannot get smaller by waiting has to say so. */
export function imageBatchError(
  stagedBytes: number,
  file: Pick<File, "size">,
): string | null {
  if (stagedBytes + file.size > COMPOSER_IMAGE_MAX_TOTAL_BYTES) {
    return `Those images add up to more than ${COMPOSER_IMAGE_MAX_TOTAL_BYTES / MIB} MiB. Remove one and try again.`;
  }
  return null;
}

/** What the pending pictures weigh together. */
export function composerImagesBytes(images: Pick<ComposerImage, "bytes">[]): number {
  return images.reduce((total, image) => total + image.bytes, 0);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the image."));
    };
    reader.readAsDataURL(file);
  });
}

function readDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Could not decode the image."));
    image.onload = () => {
      if (image.naturalWidth < 1 || image.naturalHeight < 1) {
        reject(new Error("Could not read the image dimensions."));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = url;
  });
}

let nextImageId = 0;

export async function loadComposerImage(file: File): Promise<ComposerImage> {
  const validation = imageFileError(file);
  if (validation) throw new Error(validation);

  const previewUrl = await readAsDataUrl(file);
  const dimensions = await readDimensions(previewUrl);
  const marker = ";base64,";
  const markerIndex = previewUrl.indexOf(marker);
  if (markerIndex < 0) throw new Error("Could not encode the image.");

  return {
    id: ++nextImageId,
    name: file.name || "Pasted image",
    contentType: file.type as ComposerImageType,
    width: dimensions.width,
    height: dimensions.height,
    bytes: file.size,
    dataBase64: previewUrl.slice(markerIndex + marker.length),
    previewUrl,
  };
}

export function sendImage(image: ComposerImage): SendImage {
  return {
    name: image.name,
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    dataBase64: image.dataBase64,
  };
}
