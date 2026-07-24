import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";

/**
 * A single, app-wide image lightbox. Any `MediaImage` can call `openImage(...)`
 * to blow the picture up over a dimmed backdrop, so a chat image can be
 * inspected without leaving the conversation.
 *
 * The picture doesn't just fade in at the center: it is a shared-layout
 * transition. The thumbnail and the blown-up image carry the same Motion
 * `layoutId`, so Motion animates one continuous element — it grows AND travels
 * from its spot in the message list to the center of the screen, then flies
 * back on close. The message list isn't virtualized and the page scroll is
 * locked while open, so the thumbnail stays mounted as the morph target.
 *
 * Only one overlay is ever mounted (at the app shell), driven by context, which
 * keeps leaf images free of modal plumbing. It is rendered inline (no portal):
 * no ancestor establishes a containing block for `position: fixed`, and staying
 * in the same subtree keeps Motion's layout measurements reliable. The overlay
 * still owns the modal behaviour a keyboard / screen-reader user expects: focus
 * moves to the close button on open and is restored on close, focus is trapped,
 * Escape and backdrop clicks dismiss, and background scroll is locked.
 *
 * Motion is JS-driven, so the global `prefers-reduced-motion` rule in app.css —
 * which only neutralises CSS transitions — does not reach it; we honour that
 * preference here with `useReducedMotion` by dropping the morph entirely.
 */

type LightboxImage = { src: string; alt: string; layoutId?: string };

type ImageLightboxContextValue = {
  openImage: (image: LightboxImage) => void;
  /**
   * The `layoutId` of the image whose lightbox is *currently closing* — set when
   * `close()` fires and cleared once the exit animation finishes. The matching
   * {@link MediaImage} watches this and, for that window only, drops its
   * shared-layout id (via a key-forced remount, so Motion actually releases it
   * rather than keeping the persistent node in the group). That leaves the
   * exiting overlay copy as the sole holder of the id, so it fades/shrinks in
   * place in the fixed, top-most layer.
   *
   * Why only on close: on open the thumbnail must stay in the group so the
   * grow-morph has a start box — and there the *entering* overlay is the lead,
   * which already renders on top. The bug is exit-only: when the overlay
   * unmounts, Motion promotes the remaining in-list thumbnail as the lead and
   * renders the shrink there — but the thumbnail sits inside the message
   * scroller (`overflow` clip, lower stacking context), so it draws *under* the
   * messages. Pulling the thumbnail out of the group for the close prevents
   * that handoff.
   */
  closingLayoutId: string | null;
};

const ImageLightboxContext = createContext<ImageLightboxContextValue | null>(null);

export function useImageLightbox(): ImageLightboxContextValue {
  const ctx = useContext(ImageLightboxContext);
  if (!ctx) {
    throw new Error("useImageLightbox must be used within an ImageLightboxProvider");
  }
  return ctx;
}

// The backdrop fade: user-initiated, entering/exiting → ease-out.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const BACKDROP_TRANSITION = { duration: 0.3, ease: EASE_OUT };
// The morph travels a distance and changes size, so a gentle spring reads more
// natural than a tween; a tiny bounce gives a premium "settle" without rubber.
const MORPH_TRANSITION = { type: "spring", duration: 0.4, bounce: 0.14 } as const;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ImageLightboxProvider(props: { children: ReactNode }) {
  const [image, setImage] = useState<LightboxImage | null>(null);
  // The id of the image whose close animation is in flight: set when `close()`
  // fires and cleared on `onExitComplete`. During that window the matching
  // thumbnail leaves the shared-layout group so the exiting overlay owns the
  // morph (see the `closingLayoutId` doc on the context type).
  const [closingLayoutId, setClosingLayoutId] = useState<string | null>(null);
  // Phase-1 flag of a morph close: set while the overlay is re-rendered *without*
  // its shared-layout id but still mounted, before it is actually unmounted a
  // frame later (see `close` and the effect below).
  const [closing, setClosing] = useState(false);
  const reduceMotion = useReducedMotion();

  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  // Latest image, read by the stable `close` callback without re-creating it.
  const imageRef = useRef<LightboxImage | null>(null);
  imageRef.current = image;

  const openImage = useCallback((next: LightboxImage) => {
    if (!next.src) return;
    setClosing(false);
    setClosingLayoutId(null);
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    setImage(next);
  }, []);

  // Close a morphed lightbox in two phases so that *no* element holds the shared
  // layout id at the moment the overlay unmounts. If the overlay still carried
  // the id as it exited, Motion would treat the id as changing hands — snapping
  // the picture to the thumbnail's slot (a visible teleport) and morphing from
  // there — the very handoff we're avoiding. So phase 1 drops the id from both
  // the overlay (`closing`) and the thumbnail (`closingLayoutId`) while keeping
  // the overlay mounted and centred (its box is unchanged, so nothing moves);
  // phase 2 (the effect below) unmounts it a frame later, leaving AnimatePresence
  // to fade/shrink it in place. Non-morph closes (reduced motion, inline images
  // with no layout id) just unmount straight away.
  const close = useCallback(() => {
    const layoutId = imageRef.current?.layoutId;
    if (layoutId && !reduceMotion) {
      setClosingLayoutId(layoutId);
      setClosing(true);
    } else {
      setImage(null);
    }
  }, [reduceMotion]);

  // Phase 2 of a morph close: once the overlay has committed a render without its
  // layout id, unmount it on the next frame(s) so Motion has processed the id
  // removal first and the exit is a plain in-place fade/shrink, not a morph.
  useEffect(() => {
    if (!closing) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setImage(null));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [closing]);

  // While open: lock scroll, move focus in, trap Tab, and swallow Escape before
  // the app's global key handler can also act on it (open conversation, etc.).
  useEffect(() => {
    if (!image) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase: run — and stop — before the window-level bubble handler.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      lastFocusedRef.current?.focus?.();
    };
  }, [image, close]);

  // During phase 1 of a close the overlay is still mounted but must render
  // *without* its layout id, so `closing` drops out of the morph too.
  const morphing = !!image?.layoutId && !closing;

  return (
    <ImageLightboxContext.Provider value={{ openImage, closingLayoutId }}>
      <LayoutGroup>
        {props.children}
        <AnimatePresence
          onExitComplete={() => {
            setClosingLayoutId(null);
            setClosing(false);
          }}
        >
          {image ? (
            <motion.div
              ref={containerRef}
              data-testid="image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={image.alt || "Image preview"}
              className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-8"
              onClick={(event) => {
                if (event.target === event.currentTarget) close();
              }}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={BACKDROP_TRANSITION}
            >
              <motion.img
                {...(morphing ? { layoutId: image.layoutId } : {})}
                data-testid="lightbox-image"
                src={image.src}
                alt={image.alt}
                draggable={false}
                className="max-h-full max-w-full rounded-2xl object-contain shadow-pop"
                initial={morphing ? undefined : reduceMotion ? false : { opacity: 0, scale: 0.96 }}
                animate={morphing ? undefined : { opacity: 1, scale: 1 }}
                // The overlay always exits by fading + shrinking in place: by the
                // time it unmounts, its layout id has already been dropped (see
                // `close`), so it never morphs back down into the clipped message
                // list. Reduced-motion / inline (non-morph) images exit the same
                // way, just without the preceding two-phase dance.
                exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.24, ease: EASE_OUT } }}
                transition={morphing ? MORPH_TRANSITION : { duration: 0.2, ease: EASE_OUT }}
              />
              <button
                ref={closeButtonRef}
                type="button"
                onClick={close}
                aria-label="Close image preview"
                className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-white/10 text-white/90 backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X className="size-5" strokeWidth={1.8} />
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </LayoutGroup>
    </ImageLightboxContext.Provider>
  );
}
