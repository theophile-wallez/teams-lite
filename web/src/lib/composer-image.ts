export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const COMPOSER_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ComposerImageType = (typeof COMPOSER_IMAGE_TYPES)[number];

export type ComposerImage = {
  name: string;
  contentType: ComposerImageType;
  width: number;
  height: number;
  dataBase64: string;
  previewUrl: string;
};

export type SendImage = Omit<ComposerImage, "name" | "previewUrl">;

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

export async function loadComposerImage(file: File): Promise<ComposerImage> {
  const validation = imageFileError(file);
  if (validation) throw new Error(validation);

  const previewUrl = await readAsDataUrl(file);
  const dimensions = await readDimensions(previewUrl);
  const marker = ";base64,";
  const markerIndex = previewUrl.indexOf(marker);
  if (markerIndex < 0) throw new Error("Could not encode the image.");

  return {
    name: file.name || "Pasted image",
    contentType: file.type as ComposerImageType,
    width: dimensions.width,
    height: dimensions.height,
    dataBase64: previewUrl.slice(markerIndex + marker.length),
    previewUrl,
  };
}

export function sendImage(image: ComposerImage): SendImage {
  return {
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    dataBase64: image.dataBase64,
  };
}
