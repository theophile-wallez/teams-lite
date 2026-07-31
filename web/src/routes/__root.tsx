/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { THEME_COLORS } from "~/lib/appearance";
import appCss from "~/styles/app.css?url";

// Applied before hydration so the resolved theme paints with the first frame
// (no flash). Reads the stored preference ("system" | "light" | "dark") and, for
// System, consults the OS media query. Dependency-free; it sets the data-theme
// attribute the whole palette keys off, plus the `theme-color` meta an INSTALLED
// app paints its status-bar band from.
//
// That meta is created HERE rather than declared in `head` below, and it is the only
// place that owns it (the controller keeps it in step when the theme changes, see
// `paintTheme`). Two declarative metas with `media` queries would be the tidier
// spelling, but React keeps one element per `name` — the second silently replaced
// the first, and an installed light-theme app got a dark strip above it.
const THEME_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("teams-theme");if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var dark=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",dark?"dark":"light");var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.setAttribute("name","theme-color");document.head.appendChild(m);}m.setAttribute("content",dark?${JSON.stringify(THEME_COLORS.dark)}:${JSON.stringify(THEME_COLORS.light)});}catch(e){}})();`;

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
      // `theme-color` is deliberately absent here: THEME_BOOTSTRAP owns it, because
      // it is the only code that knows which theme resolved. See the note above it.
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
