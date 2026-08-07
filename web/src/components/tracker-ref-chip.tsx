import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { GitLabLogo } from "./gitlab-logo";
import { LinearLogo } from "./linear-logo";

/**
 * A tracker reference, drawn as the chip a reader can press: the vendor's own mark and the
 * reference the author wrote (`STMN-3439`, `!42`) — or their own label, when they wrote one.
 *
 * The MARK is the whole point of the shape. A reference is a word in the middle of a
 * sentence, so what tells the reader it is a link to a tracked thing — and to WHICH tracker —
 * has to be readable at text size without a word of its own. That is the choice `AgentTagChip`
 * already makes for a CLI and `GitLabLinkCard` for a link: a vendor's artwork says which
 * service a control acts on (see components/gitlab-logo.tsx).
 *
 * The two halves go to different places, and that difference is the feature (see
 * lib/tracker-ref.ts):
 *
 *  - a LINEAR issue leaves the app, because this app has no issue page: it is an ordinary
 *    external link, in a new tab, exactly like a Linear URL somebody pasted;
 *  - a MERGE REQUEST stays here, on this app's own page for it — so it is a ROUTE change
 *    rather than a link out, and it must behave like every other navigation in this app:
 *    the history keeps it, Back leaves it, and the socket is never dropped.
 *
 * Both are anchors, and that is deliberate. The merge-request one carries the real `href` of
 * the page it opens, so the browser's own affordances still work — the status bar shows where
 * it goes, a middle click opens a second window of the app, "copy link" copies something that
 * resolves — and the click itself is intercepted so an ordinary press stays inside the app.
 */
export function TrackerRefChip(props: {
  tracker: "linear" | "gitlab";
  /** The short reference, kept for the title and for what a screen reader is told, even when
   *  the children are the author's own label. */
  reference: string;
  /** Where the chip goes: Linear's own URL, or this app's `/mr/<project>!<iid>`. */
  href: string;
  /** A merge request's project path, which is what makes `!42` mean something out of its
   *  own context — so it is what the title says. */
  project?: string;
  children: ReactNode;
}) {
  return props.tracker === "gitlab" ? (
    <MergeRequestRefChip {...props} />
  ) : (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="tracker-ref"
      data-tracker="linear"
      data-reference={props.reference}
      title={`${props.reference} on Linear`}
      className="tracker-ref"
    >
      <LinearLogo className="tracker-ref-logo" />
      {props.children}
    </a>
  );
}

/** The merge-request half: an anchor to this app's own page, navigated in place.
 *
 *  Its own component so the router hook is only called where a route is really the target —
 *  a Linear chip is drawn by surfaces that have no router at all (a unit test rendering a
 *  message body to a string), and a hook cannot be called conditionally. */
function MergeRequestRefChip(props: {
  reference: string;
  href: string;
  project?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <a
      href={props.href}
      data-testid="tracker-ref"
      data-tracker="gitlab"
      data-reference={props.reference}
      title={
        props.project
          ? `${props.project}${props.reference} — open the merge request here`
          : `${props.reference} — open the merge request here`
      }
      className={cn("tracker-ref")}
      onClick={(event) => {
        // Every modified click is the browser's: a new tab, a new window, a download. Only a
        // plain left press is ours to keep inside the app.
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void navigate({ to: props.href });
      }}
    >
      <GitLabLogo className="tracker-ref-logo" />
      {props.children}
    </a>
  );
}
