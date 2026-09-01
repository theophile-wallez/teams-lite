import { createFileRoute } from "@tanstack/react-router";

// THE READING of one merge request: `/mr/<project>!<iid>/review`.
//
// A URL of its own, and that is a reversal worth knowing about: the reading shipped as a second
// VIEW of the diff — a control in that page's header — on the argument the Pipelines page makes
// for its graph beside its job list. That argument held while the reading was a MAP of the same
// files. It stopped holding once the reading became a DOCUMENT with its own prose, its own code
// and its own conversation, because those are different content read a different way. What the
// URL buys is what every other page here buys: it survives a reload, it can be sent to whoever
// is being asked to review, and the browser's own Back leaves it.
//
// The shell in `_app` draws it FULL SCREEN, over the sidebar as well as the pane, for the diff's
// own reason: it is a long document with patches in it, and a column of chat rows beside it would
// leave the words nowhere near a readable measure. Like every other route here it renders nothing
// itself.
export const Route = createFileRoute("/_app/mr/$mergeRequestId/review")({
  component: () => null,
});
