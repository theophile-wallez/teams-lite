import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import {
  anchorTransform,
  clampPan,
  fitRect,
  viewTransform,
  wheelZoomFactor,
  zoomAround,
  FIT_VIEW,
  SWIPE_CLOSE_DISTANCE,
  type Point,
  type Rect,
  type Size,
  type View,
} from "~/lib/image-zoom";

/** How long the open/close travel and every programmatic view change take, ms. */
const TRAVEL_MS = 300;
/** A pointer that moved less than this is a tap, not a drag. */
const TAP_SLOP = 6;

type Phase = "opening" | "open" | "closing";

const rectOf = (el: Element | null): Rect | null => {
  if (el === null) return null;
  const { left, top, width, height } = el.getBoundingClientRect();
  return { left, top, width, height };
};

const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

const naturalOf = (img: HTMLImageElement | null): Size => ({
  width: img?.naturalWidth ?? 0,
  height: img?.naturalHeight ?? 0,
});

/**
 * The open picture: a viewer for one chat image.
 *
 * It is a native `<dialog>` opened with `showModal()` and portaled to `<body>`,
 * so the picture is drawn in the browser's top layer — never clipped by, nor
 * drawn under, the message scroller, which is the failure every in-flow overlay
 * hit here. Mounting it opens it; it stays mounted through its own closing
 * travel and calls `onClosed` when the picture has landed back on its thumbnail.
 *
 * What it answers, and why each one is here rather than in a library:
 * - The picture opens at {@link fitRect}, which GROWS a small picture. A preview
 *   that is the same size as the thumbnail it came from reads as a dead click.
 * - The wheel zooms, around the pointer. Scrolling is the gesture every other
 *   picture viewer zooms with, so scrolling to DISMISS surprises everybody once.
 * - A click on the dim area closes, a click on the picture closes at fit and
 *   returns to fit when zoomed in, and Escape closes.
 * - Two fingers pinch and one finger pans; at fit, a drag down closes. The app is
 *   used from a phone, so touch is not an afterthought.
 * - The picture can be SAVED from here, which is the only place it can be: the
 *   browser's own "Save image" never reaches a chat image (the message behind the
 *   thumbnail takes the right-click and the long press, and the gestures in here
 *   capture every pointer).
 */
export function ImageLightbox(props: {
  src: string;
  alt: string;
  /** The thumbnail in the message: the picture flies out of it and back into it. */
  anchor: RefObject<HTMLImageElement | null>;
  onClosed: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [phase, setPhase] = useState<Phase>("opening");
  const [viewport, setViewport] = useState<Size>(viewportSize);
  const [natural, setNatural] = useState<Size>(() => naturalOf(props.anchor.current));
  const [view, setView] = useState<View>(FIT_VIEW);
  /** The live one-finger drag that closes on release; outside `view`, since it is
   *  deliberately not pan-clamped (the picture must be able to leave). */
  const [drag, setDrag] = useState<Point>({ x: 0, y: 0 });
  /** Off while a gesture drives the picture directly, so it tracks the finger. */
  const [animated, setAnimated] = useState(true);

  const fit = fitRect(natural, viewport);
  const pan = clampPan(view.pan, view.zoom, fit, viewport);
  const anchorRect = rectOf(props.anchor.current);
  // The wheel listener is registered once (see below) but needs today's geometry
  // and phase, so both are mirrored into a ref rather than made dependencies.
  const geometry = useRef({ fit, viewport, phase });
  geometry.current = { fit, viewport, phase };

  // ---- open / close -------------------------------------------------------

  const close = useCallback(() => {
    setPhase((current) => (current === "closing" ? current : "closing"));
    setAnimated(true);
  }, []);

  useLayoutEffect(() => {
    dialogRef.current?.showModal();
    // The first paint has to land on the thumbnail before the transform flips to
    // the fit box, or there is no travel to see — hence the second frame.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPhase("open"));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // The picture is gone once it has landed back on its thumbnail. A transform
  // that does not actually change fires no transitionend (a thumbnail scrolled
  // out of the list, say), so the timer is the one that must not be dropped.
  useEffect(() => {
    if (phase !== "closing") return;
    const done = () => {
      dialogRef.current?.close();
      props.onClosed();
    };
    const timer = window.setTimeout(done, TRAVEL_MS + 60);
    const image = imageRef.current;
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "transform") return;
      window.clearTimeout(timer);
      done();
    };
    image?.addEventListener("transitionend", onEnd);
    return () => {
      window.clearTimeout(timer);
      image?.removeEventListener("transitionend", onEnd);
    };
  }, [phase, props.onClosed]);

  // Escape closes the picture and stops there: the app leaves the conversation on
  // Escape (see components/app.tsx), and the picture is what the user is looking
  // at, so nothing below may see the key.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [close]);

  useEffect(() => {
    const onResize = () => setViewport(viewportSize());
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- the wheel ---------------------------------------------------------

  // Attached by hand rather than with onWheel, because React registers its wheel
  // listener as passive: preventDefault there is ignored, and the page (or the
  // browser's own zoom) would move under the picture.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const onWheel = (e: WheelEvent) => {
      // The wheel never reaches the thread underneath, travel or not.
      e.preventDefault();
      if (geometry.current.phase === "closing") return;
      setAnimated(false);
      setView((current) =>
        zoomAround(
          current,
          current.zoom * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey),
          { x: e.clientX, y: e.clientY },
          geometry.current.fit,
          geometry.current.viewport,
        ),
      );
    };
    dialog.addEventListener("wheel", onWheel, { passive: false });
    return () => dialog.removeEventListener("wheel", onWheel);
  }, []);

  // ---- pointers: pan, pinch, swipe to close, tap -------------------------

  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    kind: "pan" | "pinch" | "swipe";
    startView: View;
    startDistance: number;
    startCentre: Point;
    /** What the gesture started on. A tap is judged on this rather than on the
     *  pointerup target, because a captured pointer reports the dialog itself. */
    startTarget: EventTarget | null;
    moved: boolean;
  } | null>(null);

  const centreOf = (points: Point[]): Point => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  });
  const distanceOf = (points: Point[]): number =>
    points.length < 2
      ? 0
      : Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);

  const beginGesture = (target: EventTarget | null) => {
    const points = [...pointers.current.values()];
    const pinching = points.length > 1;
    gesture.current = {
      kind: pinching ? "pinch" : view.zoom > 1 ? "pan" : "swipe",
      startView: { zoom: view.zoom, pan },
      startDistance: distanceOf(points),
      startCentre: centreOf(points),
      startTarget: target ?? gesture.current?.startTarget ?? null,
      moved: gesture.current?.moved ?? false,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A picture on its way home takes no more gestures. One still arriving does:
    // a click during the travel is somebody who already changed their mind.
    if (phase === "closing") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    setAnimated(false);
    beginGesture(e.target);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const active = gesture.current;
    if (active === null) return;

    const points = [...pointers.current.values()];
    const centre = centreOf(points);
    if (Math.hypot(centre.x - active.startCentre.x, centre.y - active.startCentre.y) > TAP_SLOP) {
      active.moved = true;
    }

    if (active.kind === "pinch") {
      const distance = distanceOf(points);
      if (active.startDistance === 0) return;
      const zoomed = zoomAround(
        active.startView,
        active.startView.zoom * (distance / active.startDistance),
        active.startCentre,
        fit,
        viewport,
      );
      // The fingers' own travel pans on top of the magnification.
      const dragged: Point = {
        x: zoomed.pan.x + (centre.x - active.startCentre.x),
        y: zoomed.pan.y + (centre.y - active.startCentre.y),
      };
      setView({ zoom: zoomed.zoom, pan: clampPan(dragged, zoomed.zoom, fit, viewport) });
      return;
    }

    const delta: Point = { x: centre.x - active.startCentre.x, y: centre.y - active.startCentre.y };
    if (active.kind === "pan") {
      setView({
        zoom: active.startView.zoom,
        pan: clampPan(
          { x: active.startView.pan.x + delta.x, y: active.startView.pan.y + delta.y },
          active.startView.zoom,
          fit,
          viewport,
        ),
      });
    } else {
      setDrag(delta);
    }
  };

  const endGesture = (e: React.PointerEvent<HTMLDialogElement>) => {
    pointers.current.delete(e.pointerId);
    const active = gesture.current;
    if (active === null) return;

    // A finger lifted out of a pinch leaves the other one panning.
    if (pointers.current.size > 0) {
      beginGesture(null);
      return;
    }
    gesture.current = null;

    if (active.kind === "swipe" && Math.abs(drag.y) > SWIPE_CLOSE_DISTANCE) {
      close();
      return;
    }
    setAnimated(true);
    setDrag({ x: 0, y: 0 });
    if (active.moved) return;

    // A tap. On the picture it returns to fit, or closes when already there; on
    // the dim area around it, it always closes — that void is the way out.
    const onPicture = active.startTarget === imageRef.current;
    if (onPicture && view.zoom > 1) {
      setView(FIT_VIEW);
      return;
    }
    close();
  };

  // ---- render ------------------------------------------------------------

  const travelling = phase !== "open";
  const transform =
    travelling && anchorRect !== null
      ? anchorTransform(fit, anchorRect)
      : viewTransform({ zoom: view.zoom, pan }, drag);
  // A drag towards the edge thins the scrim, so the thread shows through and the
  // gesture reads as "putting the picture back" before it completes.
  const scrimOpacity = travelling
    ? 0
    : Math.max(0.25, 1 - Math.abs(drag.y) / (SWIPE_CLOSE_DISTANCE * 2));

  return createPortal(
    <dialog
      ref={dialogRef}
      className="image-lightbox"
      data-testid="image-lightbox"
      data-phase={phase}
      data-zoom={view.zoom.toFixed(2)}
      aria-label={props.alt}
      onCancel={(e) => {
        // Reached by a platform gesture (Android's back), since the Escape key is
        // taken above. Cancel the native close so the picture travels home.
        e.preventDefault();
        close();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      <div
        data-testid="image-lightbox-scrim"
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        style={{ opacity: scrimOpacity, transition: `opacity ${TRAVEL_MS}ms ease-out` }}
      />
      <img
        ref={imageRef}
        data-testid="image-lightbox-image"
        src={props.src}
        alt={props.alt}
        draggable={false}
        onLoad={() => setNatural(naturalOf(imageRef.current))}
        style={{
          position: "absolute",
          left: fit.left,
          top: fit.top,
          width: fit.width,
          height: fit.height,
          transform,
          transformOrigin: "center",
          transition: animated ? `transform ${TRAVEL_MS}ms cubic-bezier(0.2, 0, 0.2, 1)` : "none",
          cursor: view.zoom > 1 ? "grab" : "zoom-out",
        }}
      />
      {/* Saving the picture. The browser's own "Save image" is out of reach here: on
          the thumbnail the message behind it takes the right-click and the long press
          (its actions menu), and in here every pointer is captured for the pan and
          pinch gestures. The bytes are already a local blob, so this is a plain
          download link — no fetch, no proxy call. */}
      <a
        href={props.src}
        // ponytail: the alt is the attachment's own filename for a shared image and a
        // description for a pasted one; either way a name with no extension gets one
        // from the blob's MIME type, which is the browser's job and not ours.
        download={props.alt}
        aria-label={`Save image: ${props.alt}`}
        data-testid="image-lightbox-save"
        // The dialog captures every pointer it sees, and a captured pointer's click is
        // retargeted to it — which would close the picture instead of saving it.
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute right-16 top-4 flex size-10 items-center justify-center rounded-full bg-black/60 text-white shadow-card transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        style={{ opacity: travelling ? 0 : 1, transition: `opacity ${TRAVEL_MS}ms ease-out` }}
      >
        <HugeiconsIcon icon={Download04Icon} className="size-5" strokeWidth={1.8} />
      </a>
      <button
        type="button"
        aria-label="Close image preview"
        data-testid="image-lightbox-close"
        onClick={close}
        className="absolute right-4 top-4 flex size-10 items-center justify-center rounded-full bg-black/60 text-white shadow-card transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        style={{ opacity: travelling ? 0 : 1, transition: `opacity ${TRAVEL_MS}ms ease-out` }}
      >
        <HugeiconsIcon icon={Cancel01Icon} className="size-5" strokeWidth={1.8} />
      </button>
    </dialog>,
    document.body,
  );
}
