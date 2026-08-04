import { describe, expect, it } from "vitest";
import { hasPersonOverride, type PersonOverride } from "./protocol";
import {
  MAX_PERSON_NAME_LENGTH,
  PERSON_AVATAR_MAX_BYTES,
  personAvatarAccept,
  personAvatarError,
} from "./person-override";

/** A `person_override` answer with the given halves set. */
function override(patch: Partial<PersonOverride> = {}): PersonOverride {
  return {
    mri: "8:orgid:rob",
    display_name: "",
    has_avatar: false,
    teams_name: "Robert Smith",
    ...patch,
  };
}

describe("hasPersonOverride", () => {
  it("is true when either half is set, and false for neither", () => {
    expect(hasPersonOverride(override({ display_name: "Bob" }))).toBe(true);
    expect(hasPersonOverride(override({ has_avatar: true }))).toBe(true);
    expect(hasPersonOverride(override({ display_name: "Bob", has_avatar: true }))).toBe(true);
    expect(hasPersonOverride(override())).toBe(false);
  });

  it("treats a blank name as no name, and no answer as no override", () => {
    // The backend never stores a blank name — it deletes the row instead — but a
    // caller must not be made to know that to ask the question.
    expect(hasPersonOverride(override({ display_name: "   " }))).toBe(false);
    expect(hasPersonOverride(null)).toBe(false);
    expect(hasPersonOverride(undefined)).toBe(false);
  });
});

describe("personAvatarError", () => {
  it("accepts the four raster formats the backend accepts", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(personAvatarError({ size: 1024, type })).toBeNull();
    }
  });

  it("refuses a format the backend would refuse, SVG included", () => {
    // SVG is a document, not a bitmap. It is absent from the backend's allowlist
    // (`PERSON_AVATAR_TYPES` in src/bin/server.rs), so it must be refused here — the
    // point of checking is that the user reads one sentence about their own file.
    for (const type of ["image/svg+xml", "text/html", "application/pdf", "image/bmp", ""]) {
      expect(personAvatarError({ size: 1024, type })).toMatch(/PNG, JPEG, GIF, or WebP/);
    }
  });

  it("refuses a picture larger than the backend's cap", () => {
    expect(personAvatarError({ size: PERSON_AVATAR_MAX_BYTES, type: "image/png" })).toBeNull();
    expect(personAvatarError({ size: PERSON_AVATAR_MAX_BYTES + 1, type: "image/png" })).toMatch(
      /2 MiB or smaller/,
    );
  });

  it("names the same types in the accept attribute as it validates", () => {
    const accepted = personAvatarAccept().split(",");
    for (const type of accepted) expect(personAvatarError({ size: 1, type })).toBeNull();
  });
});

describe("the limits mirror the backend", () => {
  it("caps a nickname and a picture where src/bin/server.rs caps them", () => {
    // Both are pinned so a change on one side is a failing test rather than a
    // refusal the user meets only after typing or picking.
    expect(MAX_PERSON_NAME_LENGTH).toBe(120); // MAX_PERSON_NAME_BYTES
    expect(PERSON_AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024); // MAX_PERSON_AVATAR_BYTES
  });
});
