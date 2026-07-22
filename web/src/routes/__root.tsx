/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";

// Applied before hydration so the resolved theme paints with the first frame
// (no flash). Reads the stored preference ("system" | "light" | "dark") and, for
// System, consults the OS media query. Dependency-free; it only sets the
// data-theme attribute the whole palette keys off.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("teams-theme");if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var dark=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",dark?"dark":"light");}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "color-scheme", content: "light dark" },
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
    <html lang="en" data-theme="light" className="h-full">
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
