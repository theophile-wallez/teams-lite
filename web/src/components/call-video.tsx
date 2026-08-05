import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerScreenShareIcon, Video01Icon } from "@hugeicons/core-free-icons";
import type { LocalVideo, RemoteVideo } from "~/lib/call-media";
import { useAppState } from "./controller-context";

/**
 * The picture arriving on the call: somebody's shared screen, somebody's camera.
 *
 * It sits above the call bar and is drawn only when there is something to draw, which is
 * most of the point — a black rectangle waiting for a stream nobody started is worse than no
 * rectangle, and this app has always preferred the absence (see the agent transcript in
 * AGENTS.md: "the disclosure exists exactly when there is something behind it").
 *
 * Three things about it are deliberate:
 *
 * - **A SCREEN is large and a CAMERA is a tile.** Somebody shares a screen because they want
 *   it read, and a screen is text; a camera is a face and a face reads at any size. So a
 *   share takes the stage and cameras sit under it in a row.
 * - **The element is bound by REF, never by a `src` attribute.** A `MediaStream` is an object
 *   and not a URL, so `srcObject` is the only way to attach one — and it is re-attached only
 *   when the stream's identity changes, because assigning the same stream again restarts the
 *   picture.
 * - **It is muted.** The AUDIO of a call arrives on its own elements, which
 *   `web/src/lib/call-media.ts` owns; a `<video>` playing the same voices would double every
 *   one of them.
 */
export function CallVideoStage() {
  const videos = useAppState((s) => s.callVideo);
  const mine = useAppState((s) => s.callLocalVideo);
  const names = useAppState((s) => s.callVideoNames);
  const reduce = useReducedMotion();

  const shared = videos.filter((video) => video.sharing);
  const cameras = videos.filter((video) => !video.sharing);

  return (
    <AnimatePresence>
      {(videos.length > 0 || mine.length > 0) && (
        <motion.div
          key="call-video"
          data-testid="call-video"
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="pointer-events-auto flex w-full flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-card p-2 shadow-pop sm:w-[28rem]"
        >
          {shared.map((video) => (
            <VideoFrame
              key={video.mid}
              video={video}
              name={names[video.mid]}
              className="aspect-video w-full"
            />
          ))}
          {cameras.length > 0 && (
            // A camera is a TILE, at a size a face reads at and no larger — even when it is
            // the only thing on screen. A single camera stretched to the stage's width would
            // make the picture the subject of a call whose subject is the conversation, and
            // the tiles have to stay the same size as each other however many there are.
            <div className="flex flex-wrap gap-2">
              {cameras.map((video) => (
                <VideoFrame
                  key={video.mid}
                  video={video}
                  name={names[video.mid]}
                  className={
                    shared.length > 0
                      ? "aspect-video w-32 shrink-0"
                      : // With no screen to sit under, the cameras ARE the stage and share
                        // the width between them.
                        "aspect-video min-w-0 flex-1 basis-40"
                  }
                />
              ))}
            </div>
          )}
          {/* WHAT THE USER IS SENDING, last and smallest.
              A preview is not vanity: a screen share shows whatever else is on that screen,
              and the only way somebody can tell what the meeting is seeing is to see it too.
              It is mirrored for a camera and never for a screen — a mirrored face is what a
              person expects of themselves, and a mirrored screen is unreadable. */}
          {mine.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {mine.map((video) => (
                <LocalFrame key={video.kind} video={video} />
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function LocalFrame(props: { video: LocalVideo }) {
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
      className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-xl bg-element ring-1 ring-primary/40"
    >
      <video
        ref={element}
        className={`size-full object-cover ${video.kind === "camera" ? "-scale-x-100" : ""}`}
        autoPlay
        playsInline
        // Always muted, and this one for a second reason: playing a capture of the user's own
        // machine back through their speakers is a feedback loop.
        muted
      />
      <p className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] font-medium text-white">
        <HugeiconsIcon
          icon={video.kind === "screen" ? ComputerScreenShareIcon : Video01Icon}
          className="size-3 shrink-0"
          strokeWidth={2}
        />
        <span className="truncate">{video.kind === "screen" ? "Your screen" : "You"}</span>
      </p>
    </div>
  );
}

function VideoFrame(props: { video: RemoteVideo; name?: string; className: string }) {
  const { video, name } = props;
  const element = useRef<HTMLVideoElement | null>(null);

  // Attach the stream itself. Guarded on identity: React re-runs an effect whenever its
  // deps change, and re-assigning the same `MediaStream` makes the browser tear the
  // rendering down and start it again — a visible black flash mid-call.
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
      className={`relative overflow-hidden rounded-xl bg-element ${props.className}`}
    >
      <video
        ref={element}
        // A shared screen is fitted whole — cropping a screen cuts off the thing being
        // pointed at. A face may be cropped, which is what fills a tile.
        className={`size-full ${video.sharing ? "object-contain" : "object-cover"}`}
        autoPlay
        playsInline
        // The voices arrive on their own elements. See the module comment.
        muted
      />
      <p className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] font-medium text-white">
        <HugeiconsIcon
          icon={video.sharing ? ComputerScreenShareIcon : Video01Icon}
          className="size-3 shrink-0"
          strokeWidth={2}
        />
        {/* A name when the subscription recorded one, and the plain fact when it did not:
            the section never says whose picture it carries. */}
        <span className="truncate">
          {name ? (video.sharing ? `${name} is sharing` : name) : video.sharing ? "Shared screen" : "Camera"}
        </span>
      </p>
    </div>
  );
}
