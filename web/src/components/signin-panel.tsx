import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Loading02Icon, SecurityIcon } from "@hugeicons/core-free-icons";
import {
  FRAME_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  keyFromKeydown,
  keysFromInsertedText,
  pointInWindow,
  signinIsOpen,
  signinView,
} from "~/lib/signin";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * Signing in again, without leaving the app.
 *
 * WHY IT EXISTS. When the identity broker cannot mint a token from this machine's own
 * Primary Refresh Token, it asks a human — and it asks by drawing its own window on an X
 * display, which no API redirects elsewhere (SIGN-IN.md § 3). Until now that meant SSH to the
 * machine, an `Xvfb`, `x11vnc`, `websockify`, noVNC, a window manager and `xdotool`; measured
 * once, about forty minutes, and it did not finish. This panel is that window, in the browser
 * the app is already being read in — usually a phone, over the tailnet.
 *
 * FOUR THINGS ABOUT IT ARE DELIBERATE, and each one is a rule rather than a detail:
 *
 *  - **There is no password field.** The reader types into Microsoft's own page, and each
 *    keystroke goes to it as a key press. Nothing in this app — or in the backend — ever holds
 *    a password, assembles one or logs one. A field here would be the easy shape and the
 *    wrong one.
 *  - **The picture is one WINDOW, never the screen.** The backend finds it by the broker's own
 *    `WM_CLASS` and refuses to serve anything when no sign-in it started is running.
 *  - **The common case shows no page at all.** Most sign-ins end in `starting`, because the
 *    broker could do it from the machine's own token; the panel then says so and closes. So
 *    this surface must not read as "type your password" from the first frame.
 *  - **It is a DIALOG, and it owns Escape.** The app's own Escape leaves the open pane, and
 *    the shell stands aside while a modal is up (`aModalIsOpen`) — the same arrangement the
 *    custom-agent form needed.
 */
export function SigninPanel() {
  const signin = useAppState((s) => s.signin);
  const dismissed = useAppState((s) => s.signinDismissed);
  const controller = useController();
  const view = signinView(signin);
  // A dismissal outlives the phase it was made in: the flow keeps going and keeps reporting, and
  // without this the panel came back by itself when it settled — ten minutes later, over
  // whatever the reader had moved on to.
  const open = signinIsOpen(signin.phase) && !dismissed;

  const [frame, setFrame] = useState<
    { width: number; height: number; png: string; stale: boolean } | null
  >(null);
  const [inputError, setInputError] = useState("");
  const pictureRef = useRef<HTMLImageElement | null>(null);
  const keyboardRef = useRef<HTMLInputElement | null>(null);

  // While no window is up, ask how it is going: the broker publishes no "I am asking a human"
  // signal, so the backend only notices its window when something asks (see `Signin::phase`).
  useEffect(() => {
    if (!open || view.settled) return;
    const every = view.showsWindow ? FRAME_INTERVAL_MS : STATUS_INTERVAL_MS;
    const timer = setInterval(() => void controller.refreshSignin(), every);
    return () => clearInterval(timer);
  }, [open, view.settled, view.showsWindow, controller]);

  // The frames themselves, only while there is a window to read. They stay in this component
  // on purpose: a PNG a second has no business in the whole app's state.
  useEffect(() => {
    if (!view.showsWindow) {
      setFrame(null);
      return;
    }
    let live = true;
    const pull = async () => {
      try {
        const next = await controller.signinFrame();
        if (live && next?.png) setFrame({ ...next, stale: false });
      } catch {
        // A frame that could not be read is not a failure of the sign-in: the broker REPLACES
        // its window between steps (the password page and the number-matching one are not the
        // same window), and the next tick finds the new one. The PHASE is what says whether
        // anything is wrong.
        //
        // But the picture on screen is now of a window that may be gone, and a tap on it would
        // be scaled by the OLD geometry and pressed somewhere the reader never aimed — in a form
        // where a stray click dismisses the number prompt. So it is marked stale, which dims it
        // and refuses presses until a fresh one lands.
        if (live) setFrame((held) => (held ? { ...held, stale: true } : held));
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), FRAME_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [view.showsWindow, controller]);

  // A keyboard has to be raised on a phone, and only a focused field does that. Focused as
  // soon as there is a window, in the effect that draws it, so the reader can type at once.
  useEffect(() => {
    if (view.showsWindow) keyboardRef.current?.focus();
  }, [view.showsWindow]);

  // Every keystroke and click goes out on ONE chain, in the order it was made.
  //
  // A phone's keyboard — or a password manager's paste — inserts a whole word at once, and this
  // used to fan that out as N un-awaited requests. The backend serves requests concurrently, so
  // `Hunter2!` could reach Microsoft's page as `Hnu2te!r` and be refused, with nothing in the app
  // able to say why. A queue is the whole fix: a password is a sequence, so it has to travel as
  // one.
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const send = useCallback(
    (input: { char: string } | { key: string } | { x: number; y: number }) => {
      tail.current = tail.current
        .then(() => controller.signinInput(input))
        .then(
          () => setInputError(""),
          (e: unknown) => {
            // Said at the window rather than swallowed: a keystroke that did not land looks
            // exactly like a page ignoring the reader.
            setInputError(e instanceof Error ? e.message : String(e));
          },
        );
      return tail.current;
    },
    [controller],
  );

  const onPress = (event: React.MouseEvent<HTMLImageElement>) => {
    const picture = pictureRef.current;
    // A stale picture is one whose window may already be gone: pressing it would map the tap
    // through geometry that no longer describes anything.
    if (!picture || !frame || frame.stale) return;
    const box = picture.getBoundingClientRect();
    // The picture is drawn at whatever width the layout gives it, so the tap has to be scaled
    // back into the window's own pixels — see `pointInWindow`, which is where that arithmetic
    // is tested. Getting it wrong presses a point 40 px from the button the reader aimed at.
    const at = pointInWindow(
      { x: event.clientX, y: event.clientY },
      { left: box.left, top: box.top, width: box.width, height: box.height },
      { width: frame.width, height: frame.height },
    );
    if (at) void send(at);
    keyboardRef.current?.focus();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing the dialog is not cancelling the sign-in: the reader may want the app back
        // while the broker still holds their window. Dismissing only puts this panel away, and
        // the banner offers it again — Cancel is the control that ends the flow.
        if (!next) controller.dismissSignin();
      }}
    >
      <DialogContent
        data-testid="signin-panel"
        data-phase={signin.phase}
        // Bounded and scrolling, because the content is a picture 675 px tall: without this the
        // Cancel button sits below the fold on a laptop and off the screen on a phone. The spec
        // caught it by not being able to click it, which is exactly what a reader would hit.
        className="max-h-[92vh] max-w-[38rem] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={view.settled && signin.phase === "done" ? CheckmarkCircle02Icon : SecurityIcon}
              className={
                signin.phase === "done" ? "size-5 text-emerald-500" : "size-5 text-destructive"
              }
              strokeWidth={1.8}
            />
            <span data-testid="signin-title">{view.title}</span>
          </DialogTitle>
          <DialogDescription data-testid="signin-detail">{view.detail}</DialogDescription>
        </DialogHeader>

        {view.busy && (
          <div className="flex items-center gap-2 text-xs text-text-dim">
            <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
            Waiting for Microsoft…
          </div>
        )}

        {view.showsWindow && (
          <div className="flex flex-col gap-2">
            {/* The broker's own window. `alt` names whose page it is rather than describing a
                picture: a screen reader cannot read pixels, and what matters is that this is
                Microsoft's page and not this app's. */}
            {frame ? (
              <img
                ref={pictureRef}
                data-testid="signin-frame"
                data-window-width={frame.width}
                data-window-height={frame.height}
                src={`data:image/png;base64,${frame.png}`}
                alt="Microsoft's sign-in page, running on this machine"
                onClick={onPress}
                data-stale={frame.stale ? "true" : undefined}
                // Height-capped with an automatic width, never `object-contain`: the click
                // mapping reads this element's own box, and a letterboxed picture would make
                // that box bigger than the pixels in it — every tap then lands short.
                className={cn(
                  "mx-auto block max-h-[55vh] w-auto max-w-full rounded-lg border border-border bg-white",
                  frame.stale ? "cursor-wait opacity-60" : "cursor-pointer",
                )}
              />
            ) : (
              <div
                data-testid="signin-frame-loading"
                // The window's own shape, so the box does not resize when the first frame
                // lands — the rule a picture in a message already follows.
                // The window's own shape at the same cap, so the box does not resize when the
                // first frame lands — the rule a picture in a message already follows. A
                // definite height plus an aspect ratio is what makes the width derive.
                style={{ aspectRatio: `${signin.window?.width ?? 550} / ${signin.window?.height ?? 675}` }}
                className="mx-auto h-[55vh] max-w-full animate-pulse rounded-lg border border-border bg-surface-2"
              />
            )}

            {/* Where the keystrokes come from. Deliberately NOT a password field: it is never
                read, it is cleared after every character, and what it forwards is one key
                press at a time. It has to exist because a phone raises its keyboard only for
                a focused input, and mobile keyboards report inserted TEXT rather than key
                presses (Android sends keyCode 229 for every letter). */}
            <input
              ref={keyboardRef}
              data-testid="signin-keyboard"
              aria-label="Type into Microsoft's sign-in page"
              // It is always empty — every character is forwarded and the field cleared — so
              // the placeholder is permanent, and that is what makes it read as a strip that
              // catches keys rather than as a text box that has swallowed the password. The
              // capture showed it as a blank bordered field, which reads as broken.
              placeholder="Type here — your keys go into the page above"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-transparent caret-transparent placeholder:text-text-faint selection:bg-transparent"
              value=""
              onChange={(event) => {
                // Whatever the keyboard inserted, one keystroke per character, then emptied.
                for (const key of keysFromInsertedText(event.target.value)) void send(key);
              }}
              onKeyDown={(event) => {
                const key = keyFromKeydown(event);
                if (!key) return;
                // A character arrives through onChange as well on a desktop browser, so only
                // the NAMED keys are taken here — otherwise every letter would be typed twice.
                if ("key" in key) {
                  event.preventDefault();
                  void send(key);
                }
              }}
            />
            <p className="text-[11px] leading-snug text-text-faint">
              Tap the page to move the cursor, then type. Your password goes straight into
              Microsoft's page — this app never holds it.
            </p>
          </div>
        )}

        {inputError && (
          <p data-testid="signin-input-error" className="text-[11px] leading-snug text-destructive">
            {inputError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {view.canCancel ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="signin-cancel"
              onClick={() => void controller.cancelSignin()}
            >
              Cancel
            </Button>
          ) : (
            <Button size="sm" data-testid="signin-close" onClick={() => controller.dismissSignin()}>
              Close
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
