import { describe, expect, it } from "vitest";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  COMPOSER_IMAGE_MAX_COUNT,
  COMPOSER_IMAGE_MAX_TOTAL_BYTES,
  composerImageAccept,
  composerImagesBytes,
  imageBatchError,
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

  // The id is the pending list's own identity, the preview is a local data URL and the
  // byte count is what the ceilings are counted in: none of the three is anything Teams
  // is told about.
  it("removes display-only fields from the send payload", () => {
    const image: ComposerImage = {
      id: 7,
      name: "capture.png",
      contentType: "image/png",
      width: 80,
      height: 40,
      bytes: 3,
      dataBase64: "AAAA",
      previewUrl: "data:image/png;base64,AAAA",
    };

    expect(sendImage(image)).toEqual({
      name: "capture.png",
      contentType: "image/png",
      width: 80,
      height: 40,
      dataBase64: "AAAA",
    });
  });
});

// The third ceiling, and the reason it is stated on this side at all: the other two admit
// a batch whose request is a frame the socket refuses to READ, which drops the connection
// instead of answering — and a dropped connection is reported as an unreachable backend,
// which is both wrong and unactionable.
describe("what a message's pictures may weigh together", () => {
  const staged = (bytes: number) => [{ bytes }];

  it("refuses the file that would take the batch over the ceiling", () => {
    expect(imageBatchError(0, { size: COMPOSER_IMAGE_MAX_TOTAL_BYTES })).toBeNull();
    expect(imageBatchError(0, { size: COMPOSER_IMAGE_MAX_TOTAL_BYTES + 1 })).toContain(
      "add up to more than 30 MiB",
    );
    // Each one legal on its own, and the pair is not.
    const half = COMPOSER_IMAGE_MAX_TOTAL_BYTES / 2 + 1;
    expect(imageBatchError(0, { size: half })).toBeNull();
    expect(imageBatchError(half, { size: half })).toContain("Remove one");
  });

  it("counts what is already staged", () => {
    expect(composerImagesBytes([])).toBe(0);
    expect(composerImagesBytes([{ bytes: 3 }, { bytes: 4 }])).toBe(7);
    expect(imageBatchError(composerImagesBytes(staged(1024)), { size: 1024 })).toBeNull();
  });

  // The three ceilings have to CLOSE: the largest batch the count and the per-file size
  // admit must not be able to build a frame the socket will not read. That is
  // `MAX_REQUEST_BYTES` (128 MiB) in src/bin/server.rs, mirrored by `MAX_FRAME_BYTES` in
  // web/server.ts — and without this ceiling ten pictures of 10 MiB are 133 MiB of base64,
  // which is over it.
  it("keeps the largest legal batch under the socket's own read limit", () => {
    const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
    const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;

    expect(base64(COMPOSER_IMAGE_MAX_COUNT * COMPOSER_IMAGE_MAX_BYTES)).toBeGreaterThan(
      MAX_REQUEST_BYTES,
    );
    expect(base64(COMPOSER_IMAGE_MAX_TOTAL_BYTES)).toBeLessThan(MAX_REQUEST_BYTES);
  });
});
