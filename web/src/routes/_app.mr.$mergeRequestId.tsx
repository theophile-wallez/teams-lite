import { createFileRoute, Outlet } from "@tanstack/react-router";

// One open merge request, addressed by the pair the backend takes: its project path and
// its iid, as `/mr/<project>!<iid>` with the path percent-encoded (see `mergeRequestId` in
// lib/gitlab-mr.ts). Both halves travel because both are needed — GitLab's numeric project
// id appears nowhere the sidebar shows, so an id-only URL could not survive a reload.
//
// This is a LAYOUT route with two children, because the merge request has two surfaces: the
// page itself (`index`) and its DIFF (`diff`), which takes the whole screen. Splitting them
// by URL rather than by a piece of state is what makes the diff a place the reader can be —
// reloadable, linkable, and behind the browser's own Back.
//
// Like the conversation and mail routes neither child renders anything itself: the persistent
// shell in `_app` reads `mergeRequestId` from the URL and opens it through the controller, so
// moving between merge requests never tears down the page or the sidebar's scroll position.
// The Outlet is still rendered, because a layout that swallows its children would leave the
// matched child unmounted and its URL no longer authoritative.
export const Route = createFileRoute("/_app/mr/$mergeRequestId")({
  component: Outlet,
});
