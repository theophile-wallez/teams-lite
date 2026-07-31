import { describe, expect, it } from "vitest";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  composerImageAccept,
  imageFileError,
  sendImage,
  type ComposerImage,
} from "./composer-image";

describe("composer image validation", () => {
  it("accepts the supported image types", () => {
    expect(composerImageAccept()).toBe("image/png,image/jpeg,image/gif,image/webp");
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(imageFileError({ type, size: COMPOSER_IMAGE_MAX_BYTES })).toBeNull();
    }
  });

  it("rejects unsupported files and files over 10 MiB", () => {
    expect(imageFileError({ type: "image/svg+xml", size: 10 })).toBe(
      "Select a PNG, JPEG, GIF, or WebP image.",
    );
    expect(imageFileError({ type: "image/png", size: COMPOSER_IMAGE_MAX_BYTES + 1 })).toBe(
      "Select an image that is 10 MiB or smaller.",
    );
  });

  it("removes display-only fields from the send payload", () => {
    const image: ComposerImage = {
      name: "capture.png",
      contentType: "image/png",
      width: 80,
      height: 40,
      dataBase64: "AAAA",
      previewUrl: "data:image/png;base64,AAAA",
    };

    expect(sendImage(image)).toEqual({
      contentType: "image/png",
      width: 80,
      height: 40,
      dataBase64: "AAAA",
    });
  });
});
