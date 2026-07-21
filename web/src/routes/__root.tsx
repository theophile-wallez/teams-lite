/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";
import { DEFAULT_THEME_ID } from "~/lib/theme-list.gen";

// Applied before hydration so the persisted theme paints with the first frame
// (no flash). Kept tiny and dependency-free; it only touches the data-theme
// attribute the whole palette keys off.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("teams-theme");if(t){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "color-scheme", content: "dark" },
      { title: "teams-lite" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME_ID} className="h-full">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <HeadContent />
      </head>
      <body className="h-full bg-background text-foreground antialiased">
        <div id="app" className="h-full">
          {children}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
