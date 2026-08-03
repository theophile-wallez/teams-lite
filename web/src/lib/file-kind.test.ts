import { describe, expect, it } from "vitest";
import { fileExtension, fileKind } from "./file-kind";

describe("fileExtension", () => {
  it("lowercases the extension and drops the dot", () => {
    expect(fileExtension("Report.PDF")).toBe("pdf");
    expect(fileExtension("deck.pptx")).toBe("pptx");
  });

  it("keeps only the last extension", () => {
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("has none for a bare name, a hidden file or a trailing dot", () => {
    expect(fileExtension("README")).toBe("");
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("notes.")).toBe("");
  });

  it("ignores a version or a date, which is not a type", () => {
    // "Minutes 2026.07.30" is dated, not a `.30` file.
    expect(fileExtension("Minutes 2026.07.30")).toBe("");
    expect(fileExtension("release.2026")).toBe("");
  });

  it("ignores a suffix that is not alphanumeric", () => {
    expect(fileExtension("weird.na me")).toBe("");
  });

  it("reads the extension of a path, not of its folders", () => {
    expect(fileExtension("Shared Documents/Q3.plan/deck.pptx")).toBe("pptx");
  });
});

describe("fileKind", () => {
  it("names the Office families", () => {
    expect(fileKind("Minutes.docx")).toBe("word");
    expect(fileKind("Budget.xlsx")).toBe("excel");
    expect(fileKind("20260730 - Streams Introduction.pptx")).toBe("powerpoint");
    expect(fileKind("quarterly-report.pdf")).toBe("pdf");
  });

  it("counts a CSV as a sheet, because that is what opens it", () => {
    expect(fileKind("export.csv")).toBe("excel");
  });

  it("names the media families", () => {
    expect(fileKind("sunset.png")).toBe("image");
    expect(fileKind("demo.mp4")).toBe("video");
    expect(fileKind("voice-note.m4a")).toBe("audio");
    expect(fileKind("logs.zip")).toBe("archive");
    expect(fileKind("client.tsx")).toBe("code");
    expect(fileKind("notes.md")).toBe("text");
  });

  it("prefers the extension over a vague content type", () => {
    // Teams sends `application/octet-stream` for plenty of ordinary documents.
    expect(fileKind("deck.pptx", "application/octet-stream")).toBe("powerpoint");
  });

  it("falls back to the content type when the name carries no extension", () => {
    expect(fileKind("Scan", "application/pdf")).toBe("pdf");
    expect(fileKind("Sheet", "application/vnd.ms-excel")).toBe("excel");
    expect(fileKind("Screenshot", "image/png")).toBe("image");
    expect(fileKind("Clip", "video/quicktime")).toBe("video");
    expect(fileKind("Recording", "audio/mpeg")).toBe("audio");
    expect(fileKind("Bundle", "application/zip")).toBe("archive");
    expect(fileKind("Readme", "text/plain")).toBe("text");
  });

  it("reads a content type with parameters and odd case", () => {
    expect(fileKind("Body", "TEXT/HTML; charset=utf-8")).toBe("code");
  });

  it("stays generic for an unknown type", () => {
    expect(fileKind("")).toBe("generic");
    expect(fileKind("blob", "application/octet-stream")).toBe("generic");
    expect(fileKind("thing.xyz")).toBe("generic");
  });
});
