// Which upload a picture in a merge request is — and, as much as a pure test can say it, that
// nothing else is ever taken for one. The rendering half is pinned by `web/e2e/gitlab.spec.ts`.
import { describe, it, expect } from "vitest";
import { parseCardMarkdown } from "./card-markdown";
import { gitLabMarkdownOptions, parseUploadPath, uploadKey, uploadOf } from "./gitlab-upload";
import type { RichNode } from "./rich-text";

const SECRET = "9f3c1e77a4bd42f0b6e5c8d31a7b04e2";

function find(nodes: RichNode[], tag: string): Extract<RichNode, { type: "element" }>[] {
  const found: Extract<RichNode, { type: "element" }>[] = [];
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tag === tag) found.push(node);
    found.push(...find(node.children, tag));
  }
  return found;
}

describe("parseUploadPath", () => {
  it("reads GitLab's own upload path", () => {
    expect(parseUploadPath(`/uploads/${SECRET}/image.png`, "group/app")).toEqual({
      project: "group/app",
      secret: SECRET,
      filename: "image.png",
    });
  });

  it("names no upload for anything that is not one", () => {
    for (const url of [
      `https://git.example.com/group/app/uploads/${SECRET}/image.png`,
      `/uploads/${SECRET}`,
      `/uploads/${SECRET}/`,
      `/uploads/${SECRET}/a/b.png`,
      "/uploads/short/image.png",
      "/uploads/zzzz1e77a4bd42f0b6e5c8d31a7b04e2/image.png",
      "/docs/image.png",
      "image.png",
      "",
    ]) {
      expect(parseUploadPath(url, "group/app")).toBeNull();
    }
    // Without a project there is nothing to address, whatever the path says.
    expect(parseUploadPath(`/uploads/${SECRET}/image.png`, " ")).toBeNull();
  });
});

describe("uploadKey", () => {
  it("names the upload and nothing about where it was drawn", () => {
    const ref = { project: "group/app", secret: SECRET, filename: "image.png" };
    // So the same screenshot in a description and in a comment is fetched once.
    expect(uploadKey(ref)).toBe(uploadKey({ ...ref }));
    expect(uploadKey(ref)).not.toBe(uploadKey({ ...ref, filename: "other.png" }));
    expect(uploadKey(ref)).not.toBe(uploadKey({ ...ref, project: "group/other" }));
  });
});

describe("uploadOf", () => {
  it("refuses a node missing any part of the address", () => {
    expect(uploadOf({ project: "app", secret: SECRET, filename: "a.png" })).not.toBeNull();
    expect(uploadOf({ project: "app", secret: SECRET })).toBeNull();
    expect(uploadOf({ secret: SECRET, filename: "a.png" })).toBeNull();
    expect(uploadOf({ project: "app", filename: "a.png" })).toBeNull();
  });
});

describe("a card is untouched by any of this", () => {
  it("still renders an image as a link, and an upload as the words it is", () => {
    // A connector card comes from a bot and points at hosts nobody here vouches for, so its
    // images stay links — the promise both markdown surfaces were written under. The GitLab
    // page is the only caller that passes a resolver.
    const card = parseCardMarkdown("![shot](https://example.test/a.png)");
    expect(find(card, "gitlabImage")).toHaveLength(0);
    expect(find(card, "img")).toHaveLength(0);
    expect(find(card, "a")[0]!.attrs.href).toBe("https://example.test/a.png");
    expect(find(parseCardMarkdown(`![shot](/uploads/${SECRET}/a.png)`), "gitlabImage")).toEqual([]);
  });

  it("offers no picture to a page that names no project", () => {
    expect(gitLabMarkdownOptions(undefined).image).toBeUndefined();
  });
});
