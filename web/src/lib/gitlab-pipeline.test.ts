import { describe, it, expect } from "vitest";
import { hasActivePipeline, isPipelineActive } from "./gitlab-pipeline";

describe("isPipelineActive", () => {
  it("treats in-flight states as active (worth polling)", () => {
    for (const status of [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "running",
      "scheduled",
    ]) {
      expect(isPipelineActive(status)).toBe(true);
    }
  });

  it("treats terminal states as inactive (no polling)", () => {
    for (const status of ["success", "failed", "canceled", "skipped", "manual"]) {
      expect(isPipelineActive(status)).toBe(false);
    }
  });

  it("is inactive for an unknown status or no status", () => {
    expect(isPipelineActive("garbage")).toBe(false);
    expect(isPipelineActive("")).toBe(false);
    expect(isPipelineActive(undefined)).toBe(false);
    expect(isPipelineActive(null)).toBe(false);
  });
});

describe("hasActivePipeline", () => {
  it("is true only for a merge request with an in-flight pipeline", () => {
    expect(hasActivePipeline({ kind: "merge_request", pipeline_status: "running" })).toBe(true);
    expect(hasActivePipeline({ kind: "merge_request", pipeline_status: "success" })).toBe(false);
    expect(hasActivePipeline({ kind: "merge_request" })).toBe(false);
  });

  it("is false for issues and projects even if they somehow carry a status", () => {
    expect(hasActivePipeline({ kind: "issue", pipeline_status: "running" })).toBe(false);
    expect(hasActivePipeline({ kind: "project", pipeline_status: "running" })).toBe(false);
  });

  it("is false for an unresolved link", () => {
    expect(hasActivePipeline(null)).toBe(false);
    expect(hasActivePipeline(undefined)).toBe(false);
  });
});
