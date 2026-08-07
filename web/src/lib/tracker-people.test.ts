import { describe, expect, it } from "vitest";
import { personFace, samePerson } from "./tracker-people";

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

// Whether two tracker people are one person, which is what lets a surface say once what it
// would otherwise say twice.
describe("whether two tracker people are one person", () => {
  it("the handle is what proves it", () => {
    expect(samePerson({ name: "Ada", username: "ada" }, { name: "A. Lovelace", username: "ada" })).toBe(
      true,
    );
    expect(samePerson({ name: "Ada", username: "ada" }, { name: "Ada", username: "ada2" })).toBe(false);
  });

  it("a NAME proves nothing, because two colleagues may share one", () => {
    expect(samePerson({ name: "Ada", username: "" }, { name: "Ada", username: "" })).toBe(false);
    // Not even beside a handle one of them lacks.
    expect(samePerson({ name: "Ada", username: "ada" }, { name: "Ada", username: "" })).toBe(false);
  });

  it("falls back to the colleague they resolve to when a handle is missing", () => {
    const teams = { mri: "8:orgid:ada", name: "Ada" };
    expect(
      samePerson({ name: "Ada", username: "", teams }, { name: "A. Lovelace", username: "", teams }),
    ).toBe(true);
    // An empty identity resolves nobody, so it can prove nothing either.
    expect(
      samePerson(
        { name: "Ada", username: "", teams: { mri: "", name: "Ada" } },
        { name: "Ada", username: "", teams: { mri: "", name: "Ada" } },
      ),
    ).toBe(false);
  });
});
