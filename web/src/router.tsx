import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { NotFound } from "~/components/not-found";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    // The app is a single realtime surface fed by a WebSocket; SSR renders the
    // shell and the client hydrates and connects. Scroll restoration would fight
    // our own message-history anchoring, so we leave it off.
    scrollRestoration: false,
    defaultNotFoundComponent: () => <NotFound />,
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
