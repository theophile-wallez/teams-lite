import { createFileRoute } from "@tanstack/react-router";

// The merge request itself: `/mr/<project>!<iid>`. Its header, description, pipeline,
// approvals, actions, the Changes summary and its comments — drawn by the shell in `_app`,
// which is why this renders nothing.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/")({
  component: () => null,
});
