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
      {
        name: "viewport",
        // `viewport-fit=cover` lets the app paint into the safe-area insets (the
        // iOS notch / home indicator) which the composer then pads around.
        // `interactive-widget=resizes-content` makes the on-screen keyboard shrink
        // the layout viewport (and thus 100dvh) instead of just overlaying it, so
        // the composer rides above the keyboard on mobile Chrome rather than being
        // hidden behind it.
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { name: "color-scheme", content: "light dark" },
      // The status-bar band of an installed app takes its colour from here, so it
      // is declared per scheme — one value would leave a black strip above a light
      // app, or a white one above a dark app.
      { name: "theme-color", content: "#fbfbfc", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#171717", media: "(prefers-color-scheme: dark)" },
      // Installed-app hints. `display: standalone` in the manifest is what current
      // iOS reads; these keep an older iOS opening the Home Screen icon without
      // Safari's chrome, and name the app under the icon.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "teams-lite" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { title: "teams-lite" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      // Add to Home Screen reads these two: the manifest makes the page an
      // installable web app (which is what unlocks Web Push on iOS), and the
      // apple-touch-icon is the icon itself — iOS will not take an SVG, and without
      // a PNG it uses a screenshot of the page.
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon-180.png", sizes: "180x180" },
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
