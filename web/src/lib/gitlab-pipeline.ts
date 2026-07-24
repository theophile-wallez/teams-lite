// GitLab CI/CD pipeline status helpers, shared by the message list (which polls a
// running pipeline live) and kept pure so the "is it still running?" decision can
// be unit-tested without a DOM. The status strings mirror GitLab's pipeline
// `status` field. See `pipeline_status` in src/gitlab.rs (backend) and the badge
// rendering in components/gitlab-link-card.tsx.

/** Pipeline states that are still in flight. While a merge request sits in any of
 *  these, its card is re-polled so the status badge follows the running CI. Every
 *  other state — success, failed, canceled, skipped, manual — is terminal and
 *  needs no polling (a manual pipeline is blocked on human action, not time). */
export const ACTIVE_PIPELINE_STATES: ReadonlySet<string> = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

/** True while a pipeline status is non-terminal (worth re-polling); false for a
 *  terminal state, an unknown status, or no status at all. */
export function isPipelineActive(status: string | null | undefined): boolean {
  return status != null && ACTIVE_PIPELINE_STATES.has(status);
}

/** True when a resolved link is a merge request whose pipeline is still running,
 *  i.e. the one case the message list keeps polling. Issues and projects never
 *  carry a pipeline, so they are always false. */
export function hasActivePipeline(
  meta: { kind: string; pipeline_status?: string } | null | undefined,
): boolean {
  return meta?.kind === "merge_request" && isPipelineActive(meta.pipeline_status);
}
