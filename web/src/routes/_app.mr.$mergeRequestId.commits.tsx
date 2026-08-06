import { createFileRoute } from "@tanstack/react-router";

// The COMMITS of one merge request: `/mr/<project>!<iid>/commits`.
//
// One of the four pages a merge request has (see lib/gitlab-mr-pages.ts), reached from the
// sub-header the pane draws. It holds nothing yet: the shell says so and offers GitLab's own
// commits, because a page drawn blank reads as a failed read.
//
// A URL of its own rather than a piece of state, for the reason the diff already has one: it
// survives a reload, it can be sent to a colleague, and the browser's own Back leaves it.
// Like every other route here it renders nothing itself — the shell in `_app` reads which
// page the URL asks for and draws it.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/commits")({
  component: () => null,
});
