import { useEffect, useState } from "react";
import { agentPersonaNamed } from "~/lib/agent-persona";
import { cn } from "~/lib/utils";
import { AgentLogo } from "./agent-logo";
import { useOptionalAppState, useOptionalController } from "./controller-context";

/**
 * The mark of one AGENT: a custom agent's own face when it has one, and otherwise the
 * artwork of the provider behind it.
 *
 * That fallback is the whole rule, and it is why this is one component rather than an
 * `<img>` at each of the four call sites (the composer's chip, a sent message's chip, the
 * "@" list, the Settings row). A persona always has a mark: the user gave it one, or it wears
 * the mark of the CLI it runs on — never a blank square, and never a letter in a circle,
 * because a persona is a program answering and not a person in the thread.
 *
 * Two things it deliberately does NOT do:
 *
 * - **It never asks for bytes that are not there.** `has_avatar` decides, so a persona with
 *   no face costs no request; and a persona this machine no longer holds a record of — one
 *   read back out of an old reply's signature — draws the provider's mark, which is exactly
 *   what it should say. That message really was answered by that CLI.
 * - **It resolves the face through the ONE cache.** `controller.agentPersonaAvatarUrl` is
 *   the same shape `PackEmoji` uses for pack art: one blob URL per name, de-duplicated, so a
 *   history of forty bubbles from one persona costs one request. A `useState` + effect per
 *   call site is what that helper exists to prevent — four of them had already drifted for
 *   the emoji pack.
 */
export function AgentMark(props: {
  /** The provider behind it — the fallback artwork and the palette. */
  backend: string;
  /** The custom agent, by address, or null/undefined for a plain provider run. */
  persona?: string | null;
  className?: string;
  title?: string;
}) {
  const url = usePersonaAvatar(props.persona);
  if (!url) return <AgentLogo backend={props.backend} className={props.className} title={props.title} />;
  return (
    <img
      src={url}
      alt=""
      title={props.title}
      draggable={false}
      // Which custom agent this is, for a spec: the chip around it carries the provider, and
      // the face is the only place the persona's own identity is drawn.
      data-persona={props.persona ?? undefined}
      // A face is somebody's picture at whatever shape they gave it, so it is cropped to the
      // box rather than letterboxed inside it — `object-contain` would leave a 4:3 photo
      // floating in a square with two empty bands, which reads as a broken image at 20px.
      className={cn("shrink-0 rounded-[0.25em] object-cover", props.className)}
    />
  );
}

/**
 * One custom agent's face as a local blob URL, or null when there is nothing to draw —
 * because it has none, because this machine holds no record of it, or because the read
 * failed.
 *
 * Null for all three on purpose: every one of them means the same thing to a caller (draw the
 * provider's mark), and a hook that distinguished them would push a decision into four call
 * sites that all want the same answer.
 */
export function usePersonaAvatar(name: string | null | undefined): string | null {
  // Both are OPTIONAL: a message body is rendered where there is no store (`RichContent` is
  // pure given its props, which is what lets it be server-rendered and tested with no DOM).
  // With no record there is no face to ask for, and the provider's mark is the right answer —
  // the same one a deleted persona gets.
  const controller = useOptionalController();
  const agent = useOptionalAppState((s) => s.agent, null);
  const persona = agentPersonaNamed(agent, name);
  const [url, setUrl] = useState<string | null>(null);
  // The face is keyed by BOTH the name and when the row last changed, so replacing a picture
  // redraws it: the blob cache is keyed by name alone, and without the timestamp a saved
  // face would only appear after a reload.
  const version = persona?.updated_ms ?? 0;
  const has = persona?.has_avatar === true;

  useEffect(() => {
    if (!controller || !name || !has) {
      setUrl(null);
      return;
    }
    let alive = true;
    // `agentPersonaAvatarUrl` REJECTS when its RPC fails, so this catch is not optional.
    controller
      .agentPersonaAvatarUrl(name, version)
      .then((resolved) => {
        if (alive) setUrl(resolved);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [controller, name, has, version]);

  return url;
}
