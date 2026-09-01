import { HugeiconsIcon } from "@hugeicons/react";
import { File01Icon, SparklesIcon } from "@hugeicons/core-free-icons";

import { reviewTagLabel, type ReviewTag } from "~/lib/gitlab-review";
import { cn } from "~/lib/utils";

// A TAGGED THEME OR FILE, drawn as a chip — in the composer while the question is being written, and
// in the bubble once it has been sent.
//
// **ONE COMPONENT FOR BOTH SURFACES, which is the whole reason it is its own file.** A chip that
// looked one way in the box and another way in the message would read as two different things, and
// the reader would not know which of them is what travelled. The two callers differ only in the
// surface behind them (`onAccent`), because the sent question sits in the accent fill — the rule
// § A CHIP IS TINTED FOR THE SURFACE IT LANDS ON already states for an @mention, applied here.
//
// **WHAT IT SHOWS IS NOT WHAT THE QUESTION SPELLS.** The words carry `@tooling/ci/components/blocks/
// kubernetes-agent.gitlab-ci.yaml`, because the path is what travels and what the backend holds the
// diff to; the chip carries `kubernetes-agent.gitlab-ci.yaml`, because a chip the width of the
// composer says where the file lives four times over and what it is once (`reviewTagLabel`). The
// whole path is one hover away, in the `title` — and the line under a sent question names what really
// travelled in full, which is the authority.

/** One tag as a chip.
 *
 *  It is `inline-flex` with `align-middle`, so it sits on the text's own baseline run rather than
 *  becoming a block that breaks the line — a question is a sentence with chips in it, not a list.
 *  `whitespace-nowrap` keeps a two-word theme title from being split across a wrap, which is the rule
 *  `.mention-chip` holds for a person's name and for its reason: half a chip on each line reads as two
 *  chips. */
export function ReviewTagChip(props: {
  tag: ReviewTag;
  /** Whether the chip is drawn ON the app's accent fill, which the sent question's bubble is.
   *
   *  It decides the INK and the wash, and it is a property of the SURFACE rather than of the tag —
   *  the same chip in the composer sits on a card. Getting this from authorship instead is the defect
   *  § A CHIP IS TINTED FOR THE SURFACE IT LANDS ON records: the reader's own @mention was drawn
   *  white-on-white for a year inside a channel thread. */
  onAccent?: boolean;
}) {
  const { tag } = props;
  const label = reviewTagLabel(tag);
  return (
    <span
      data-testid="review-tag-chip"
      data-kind={tag.kind}
      // WHICH tag this is, in full, for a test and for a capture — the path rather than the name, so
      // a selector names the thing that travels.
      data-tag={tag.kind === "theme" ? `theme:${tag.index}` : tag.path}
      // The whole path, or the theme's whole title where the chip had to shorten it. A chip is a
      // shortening, so the thing it shortened has to be reachable.
      title={tag.kind === "theme" ? tag.label : tag.path}
      className={cn(
        "inline-flex max-w-full select-none items-center gap-1 whitespace-nowrap rounded align-middle",
        // A LINE-HEIGHT of 1 with vertical padding of its own, so a chip is the height of the words
        // rather than taller: in a growing composer a chip that added to the line height would make
        // the box jump by a pixel or two on every pick.
        "px-1.5 py-px text-[12px] leading-5",
        props.onAccent
          ? // On the accent: white ink on a wash OF white, which is the one pair that reads on it —
            // the tint `--mention-mine` already uses, spelled here because this chip is not a mention
            // and must not inherit rules that change with one.
            "bg-primary-foreground/20 text-primary-foreground"
          : tag.kind === "theme"
            ? "bg-primary/10 text-primary"
            : "bg-element text-text-dim",
      )}
    >
      <HugeiconsIcon
        icon={tag.kind === "theme" ? SparklesIcon : File01Icon}
        // 12px, which is the size the words are: a glyph taller than its own line is what makes a
        // chip look pasted in.
        className="size-3 shrink-0"
        strokeWidth={1.8}
      />
      {/* The NAME, and a file's is set in the mono face the rest of this page sets a path in — so a
          chip naming a file reads as a file rather than as a word somebody wrote. It TRUNCATES rather
          than growing, because a theme's title is a sentence. */}
      <span className={cn("min-w-0 truncate", tag.kind === "file" && "font-mono text-[11px]")}>
        {label}
      </span>
    </span>
  );
}
