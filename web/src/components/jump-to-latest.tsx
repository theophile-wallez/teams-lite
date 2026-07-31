import { ArrowDown } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * A small floating control that takes the reader back to the newest message.
 *
 * It hovers over the bottom of the history, immediately above the composer, and
 * only means something once the reader has scrolled away from the bottom — the
 * pane drives that with `visible`.
 *
 * It stays mounted and fades out instead of unmounting, so leaving is as calm as
 * arriving (an unmount can only cut). While it is hidden it takes no pointer and
 * no tab stop, because an invisible button must not be reachable.
 */
export function JumpToLatest(props: { visible: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Jump to the newest message"
      title="Jump to the newest message"
      data-testid="jump-to-latest"
      data-visible={props.visible}
      aria-hidden={!props.visible}
      tabIndex={props.visible ? 0 : -1}
      onClick={props.onClick}
      className={cn(
        // `z-20` keeps it over the composer's fade overlay, which reaches up over
        // this corner from the bar below (the typing line does the same at z-10).
        "absolute bottom-3 right-4 z-20 grid size-9 cursor-pointer place-items-center",
        "rounded-full border border-border-subtle bg-popover text-text-dim shadow-pop",
        "transition-[opacity,transform,color] duration-200 ease-out hover:text-foreground md:right-6",
        props.visible
          ? "pointer-events-auto scale-100 opacity-100"
          : "pointer-events-none translate-y-1 scale-95 opacity-0",
      )}
    >
      <ArrowDown className="size-4" strokeWidth={1.8} />
    </button>
  );
}
