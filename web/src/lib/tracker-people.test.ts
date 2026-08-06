import { describe, expect, it } from "vitest";
import { personFace } from "./tracker-people";

// How a colleague is DRAWN, which is the one decision both the merge-request page and the two
// preview cards read — so a person cannot be drawn one way on a card and another on a page.
describe("who a tracker user is drawn as", () => {
  it("draws a colleague the app knows as that colleague", () => {
    const face = personFace({
      name: "Lucas Silva",
      username: "lucas.silva",
      // What the backend resolved: the person, under the name this app calls them — which is
      // the user's own nickname for them when they set one.
      teams: { mri: "8:orgid:lucas-silva", name: "Luca" },
    });
    expect(face.label).toBe("Luca");
    // Their real photo, addressed the way every other avatar in this app is.
    expect(face.photo).toEqual({ kind: "user", id: "8:orgid:lucas-silva" });
    // Seeded on the identity, so one person is one colour across every surface.
    expect(face.seed).toBe("8:orgid:lucas-silva");
  });

  it("leaves somebody only GitLab knows exactly as GitLab named them", () => {
    const face = personFace({ name: "Ada Lovelace", username: "ada" });
    expect(face).toEqual({ seed: "ada", label: "Ada Lovelace" });
    // Nothing to fetch: GitLab's own avatar URL is never requested.
    expect(face.photo).toBeUndefined();
  });

  it("asks for no picture when the identity is empty, and never shows a blank name", () => {
    // A backend that answered with a person carrying no MRI has resolved nobody.
    expect(personFace({ name: "Ada", username: "ada", teams: { mri: "", name: "x" } })).toEqual({
      seed: "ada",
      label: "Ada",
    });
    // A bot GitLab redacts has a handle and no name; a name is what the row shows.
    expect(personFace({ name: "", username: "project_17_bot" }).label).toBe("project_17_bot");
    // And a resolved person whose name did not travel keeps GitLab's.
    expect(
      personFace({ name: "Lucas Silva", username: "lucas", teams: { mri: "8:orgid:l", name: "" } })
        .label,
    ).toBe("Lucas Silva");
  });
});
