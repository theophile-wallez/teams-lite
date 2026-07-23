import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";

/**
 * A single, app-wide image lightbox. Any `MediaImage` can call `openImage(...)`
 * to blow the picture up over a dimmed backdrop with a soft zoom, so a chat
 * image can be inspected without leaving the conversation.
 *
 * Only one overlay is ever mounted (at the app shell), driven by context, which
 * keeps leaf images free of modal plumbing and avoids N overlays in the tree.
 * The overlay owns modal behaviour a screen reader / keyboard user expects:
 * focus moves to the close button on open and is restored on close, Escape and
 * backdrop clicks dismiss, background scroll is locked, and focus is trapped.
 *
 * The enter/exit motion is driven by Motion (not CSS), so the global
 * `prefers-reduced-motion` rule in app.css — which only neutralises CSS
 * transitions — does not reach it; we honour that preference here with
 * `useReducedMotion` instead.
 */

type LightboxImage = { src: string; alt: string };

type ImageLightboxContextValue = {
  openImage: (src: string, alt?: string) => void;
};

const ImageLightboxContext = createContext<ImageLightboxContextValue | null>(null);

export function useImageLightbox(): ImageLightboxContextValue {
  const ctx = useContext(ImageLightboxContext);
  if (!ctx) {
    throw new Error("useImageLightbox must be used within an ImageLightboxProvider");
  }
  return ctx;
}

// User-initiated, entering/exiting the screen → ease-out. A soft "settle" curve
// (ease-out-expo-ish) reads premium without overshoot. The exit is ~25% quicker
// than the entrance, per motion-design convention.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const ENTER_SECONDS = 0.24;
const EXIT_SECONDS = 0.18;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ImageLightboxProvider(props: { children: ReactNode }) {
  const [image, setImage] = useState<LightboxImage | null>(null);
  const [mounted, setMounted] = useState(false);
  const reduceMotion = useReducedMotion();

  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Portalling needs a DOM; defer until after hydration so SSR stays clean.
  useEffect(() => {
    setMounted(true);
  }, []);

  const openImage = useCallback((src: string, alt = "") => {
    if (!src) return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    setImage({ src, alt });
  }, []);

  const close = useCallback(() => setImage(null), []);

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

  const overlay = (
    <AnimatePresence>
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
          exit={{ opacity: 0, transition: { duration: EXIT_SECONDS, ease: EASE_OUT } }}
          transition={{ duration: ENTER_SECONDS, ease: EASE_OUT }}
        >
          <motion.img
            data-testid="lightbox-image"
            src={image.src}
            alt={image.alt}
            draggable={false}
            className="max-h-full max-w-full rounded-2xl object-contain shadow-pop"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{
              opacity: 0,
              scale: reduceMotion ? 1 : 0.98,
              transition: { duration: EXIT_SECONDS, ease: EASE_OUT },
            }}
            transition={{ duration: ENTER_SECONDS, ease: EASE_OUT }}
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
  );

  return (
    <ImageLightboxContext.Provider value={{ openImage }}>
      {props.children}
      {mounted ? createPortal(overlay, document.body) : null}
    </ImageLightboxContext.Provider>
  );
}
