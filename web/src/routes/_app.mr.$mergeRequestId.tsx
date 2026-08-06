import { createFileRoute } from "@tanstack/react-router";

// One open merge request, addressed by the pair the backend takes: its project path and
// its iid, as `/mr/<project>!<iid>` with the path percent-encoded (see `mergeRequestId` in
// lib/gitlab-mr.ts). Both halves travel because both are needed — GitLab's numeric project
// id appears nowhere the sidebar shows, so an id-only URL could not survive a reload.
//
// Like the conversation and mail routes this renders nothing itself: the persistent shell
// in `_app` reads `mergeRequestId` from the URL and opens it through the controller, so
// moving between merge requests never tears down the page or the sidebar's scroll position.
export const Route = createFileRoute("/_app/mr/$mergeRequestId")({
  component: () => null,
});
