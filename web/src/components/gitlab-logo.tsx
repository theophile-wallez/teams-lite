import { cn } from "~/lib/utils";

/**
 * GitLab's own logomark — the tanuki — as GitLab draws it: four paths in three fills
 * (`#e24329`, `#fc6d26`, `#fca326`). The geometry and the group transform below are
 * `GitLab_icon.svg` verbatim, so the mark is theirs rather than a redrawing of it.
 *
 * It is NOT a hugeicons glyph, and that is deliberate: the icon library is the app's own
 * voice (see lib/icon-library.test.ts), while a vendor's mark says which service a row
 * acts on. The same reason `AgentLogo` wears each CLI's artwork and `LinearLogo` wears
 * Linear's — a menu row that writes to GitLab under the user's name must say GitLab, not
 * "a generic tick".
 *
 * The three fills live in app.css (`.gitlab-logo-1/2/3`) beside Linear's, because they
 * are a third party's brand colours: never themed, never recoloured, one spelling for
 * both light and dark.
 *
 * Pass `title` where the mark is the only thing naming the service — it then reads as an
 * image called "GitLab" — and omit it where the word is already on screen, so a screen
 * reader does not say "GitLab" twice.
 */
export function GitLabLogo(props: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 1000 963.197"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="gitlab-logo"
      className={cn("gitlab-logo", props.className)}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {props.title && <title>{props.title}</title>}
      <g transform="matrix(5.2068817,0,0,5.2068817,-489.30756,-507.76085)">
        <path
          className="gitlab-logo-1"
          d="m 282.83,170.73 -0.27,-0.69 -26.14,-68.22 a 6.81,6.81 0 0 0 -2.69,-3.24 7,7 0 0 0 -8,0.43 7,7 0 0 0 -2.32,3.52 l -17.65,54 h -71.47 l -17.65,-54 a 6.86,6.86 0 0 0 -2.32,-3.53 7,7 0 0 0 -8,-0.43 6.87,6.87 0 0 0 -2.69,3.24 L 97.44,170 l -0.26,0.69 a 48.54,48.54 0 0 0 16.1,56.1 l 0.09,0.07 0.24,0.17 39.82,29.82 19.7,14.91 12,9.06 a 8.07,8.07 0 0 0 9.76,0 l 12,-9.06 19.7,-14.91 40.06,-30 0.1,-0.08 a 48.56,48.56 0 0 0 16.08,-56.04 z"
        />
        <path
          className="gitlab-logo-2"
          d="m 282.83,170.73 -0.27,-0.69 a 88.3,88.3 0 0 0 -35.15,15.8 L 190,229.25 c 19.55,14.79 36.57,27.64 36.57,27.64 l 40.06,-30 0.1,-0.08 a 48.56,48.56 0 0 0 16.1,-56.08 z"
        />
        <path
          className="gitlab-logo-3"
          d="m 153.43,256.89 19.7,14.91 12,9.06 a 8.07,8.07 0 0 0 9.76,0 l 12,-9.06 19.7,-14.91 c 0,0 -17.04,-12.89 -36.59,-27.64 -19.55,14.75 -36.57,27.64 -36.57,27.64 z"
        />
        <path
          className="gitlab-logo-2"
          d="M 132.58,185.84 A 88.19,88.19 0 0 0 97.44,170 l -0.26,0.69 a 48.54,48.54 0 0 0 16.1,56.1 l 0.09,0.07 0.24,0.17 39.82,29.82 c 0,0 17,-12.85 36.57,-27.64 z"
        />
      </g>
    </svg>
  );
}
