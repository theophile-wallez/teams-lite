import { createFileRoute } from "@tanstack/react-router";

// The DIFF of one merge request: `/mr/<project>!<iid>/diff`.
//
// A URL of its own rather than a panel on the page above, because reviewing code is a place
// the reader stays in rather than a section they scroll past. What follows from the URL is
// what makes it worth having: it survives a reload, it can be sent to somebody, and the
// browser's own Back leaves it — none of which a piece of component state gives.
//
// The shell in `_app` draws it FULL SCREEN, over the sidebar as well as the pane: it is a
// two-column surface of its own (the changed files on the left, one of them on the right),
// and a third column of chat rows beside it would leave neither of its own two enough room.
// Like every other route here it renders nothing itself.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/diff")({
  component: () => null,
});
