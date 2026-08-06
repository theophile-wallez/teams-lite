import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerScreenShareIcon, Video01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { LocalVideo, RemoteVideo } from "~/lib/call-media";
import { cn } from "~/lib/utils";

/**
 * One picture on a call: somebody's shared screen, somebody's camera, or what this
 * machine is sending.
 *
 * The two frames here are the whole of it. WHERE they go is the stage's decision
 * (`lib/call-stage.ts` sorts them, `call-stage.tsx` draws them), because that answer
 * changes with the shape the call is in while the picture itself does not. Three things
 * about a frame are deliberate, and none of them belongs to a layout:
 *
 * - **The element is bound by REF, never by a `src` attribute.** A `MediaStream` is an
 *   object and not a URL, so `srcObject` is the only way to attach one — and it is
 *   re-attached only when the stream's identity changes, because assigning the same stream
 *   again restarts the picture and shows a black flash mid-call.
 * - **It is muted.** The AUDIO of a call arrives on its own elements, which
 *   `web/src/lib/call-media.ts` owns; a `<video>` playing the same voices would double
 *   every one of them.
 * - **A screen is FITTED and a face is CROPPED.** Cropping a screen cuts off the thing
 *   being pointed at, and cropping a face is what fills a tile.
 */
export function RemoteVideoFrame(props: { video: RemoteVideo; name?: string; className?: string }) {
  const { video, name } = props;
  const element = useRef<HTMLVideoElement | null>(null);

  // Attach the stream itself. Guarded on identity: React re-runs an effect whenever its
  // deps change, and re-assigning the same `MediaStream` makes the browser tear the
  // rendering down and start it again.
  useEffect(() => {
    const node = element.current;
    if (!node || node.srcObject === video.stream) return;
    node.srcObject = video.stream;
  }, [video.stream]);

  return (
    <div
      data-testid="call-video-frame"
      data-mid={video.mid}
      data-label={video.label}
      data-sharing={video.sharing ? "true" : "false"}
      className={cn("relative overflow-hidden rounded-xl bg-element", props.className)}
    >
      <video
        ref={element}
        className={cn("size-full", video.sharing ? "object-contain" : "object-cover")}
        autoPlay
        playsInline
        // The voices arrive on their own elements. See the module comment.
        muted
      />
      <FrameLabel
        icon={video.sharing ? ComputerScreenShareIcon : Video01Icon}
        // A name when the subscription recorded one, and the plain fact when it did not:
        // the section never says whose picture it carries.
        text={
          name
            ? video.sharing
              ? `${name} is sharing`
              : name
            : video.sharing
              ? "Shared screen"
              : "Camera"
        }
      />
    </div>
  );
}

/**
 * What the user themselves is sending, drawn for the user themselves.
 *
 * A preview is not vanity: a screen share shows whatever else is on that screen, and the
 * only way somebody can tell what the meeting is seeing is to see it too. It is mirrored
 * for a camera and never for a screen — a mirrored face is what a person expects of
 * themselves, and a mirrored screen is unreadable.
 */
export function LocalVideoFrame(props: { video: LocalVideo; className?: string }) {
  const { video } = props;
  const element = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const node = element.current;
    if (!node || node.srcObject === video.stream) return;
    node.srcObject = video.stream;
  }, [video.stream]);

  return (
    <div
      data-testid="call-video-local"
      data-kind={video.kind}
      className={cn(
        "relative overflow-hidden rounded-xl bg-element ring-1 ring-primary/40",
        props.className,
      )}
    >
      <video
        ref={element}
        className={cn("size-full object-cover", video.kind === "camera" && "-scale-x-100")}
        autoPlay
        playsInline
        // Always muted, and this one for a second reason: playing a capture of the user's own
        // machine back through their speakers is a feedback loop.
        muted
      />
      <FrameLabel
        icon={video.kind === "screen" ? ComputerScreenShareIcon : Video01Icon}
        text={video.kind === "screen" ? "Your screen" : "You"}
      />
    </div>
  );
}

/** The one line over the bottom of a picture: what it is, and whose it is. */
function FrameLabel(props: { icon: IconSvgElement; text: string }) {
  return (
    <p className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] font-medium text-white">
      <HugeiconsIcon icon={props.icon} className="size-3 shrink-0" strokeWidth={2} />
      <span className="truncate">{props.text}</span>
    </p>
  );
}
