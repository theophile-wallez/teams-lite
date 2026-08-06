import { createFileRoute } from "@tanstack/react-router";

// The PIPELINES of one merge request: `/mr/<project>!<iid>/pipelines`.
//
// One of the four pages a merge request has (see lib/gitlab-mr-pages.ts), reached from the
// sub-header the pane draws. It holds nothing yet — and what it says points at the Overview,
// which already follows the pipeline in flight, so a reader after a running job is never sent
// to a page that cannot answer them.
//
// A URL of its own rather than a piece of state, for the reason the diff already has one: it
// survives a reload, it can be sent to a colleague, and the browser's own Back leaves it.
// Like every other route here it renders nothing itself.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/pipelines")({
  component: () => null,
});
