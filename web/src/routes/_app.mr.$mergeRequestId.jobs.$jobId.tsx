import { createFileRoute } from "@tanstack/react-router";

// ONE JOB's LOG: `/mr/<project>!<iid>/jobs/<jobId>`.
//
// Where a job card on the Pipelines page goes. It sits UNDER the pipelines page rather than
// beside it in the strip of four: a job is a detail of a run, so the sub-header keeps Pipelines
// current and Back leaves the log for the run it belongs to.
//
// A URL of its own for the diff's own reasons, and none of the three is available to a piece of
// state: it survives a reload, it can be sent to whoever is asking why CI is red, and the
// browser's own Back leaves it. The job is addressed by its own numeric id, as GitLab addresses
// one — the merge request travels in the path because that is what the reader is inside of.
//
// Like every other route here it renders nothing itself: the shell in `_app` reads both params
// and draws the page FULL SCREEN, because a log is 4 000 lines of monospace and a column of chat
// rows beside it would leave it none of the width it needs.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/jobs/$jobId")({
  component: () => null,
});
