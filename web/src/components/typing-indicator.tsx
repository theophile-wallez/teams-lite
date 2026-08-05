import { cn } from "~/lib/utils";
import { typingLabel, typingPeople } from "~/lib/protocol";
import { Avatar, firstAvatarInitial, type AvatarPhoto } from "./avatar";
import { useAppState } from "./controller-context";

/** How many faces the row draws. The label already counts the people beyond the
 *  two it names ("… and 2 more are typing"), so a fourth face would only cost the
 *  words their room. */
const MAX_TYPING_FACES = 3;

/**
 * A calm, transient "… is typing" hint shown just above the composer while other
 * people are composing in the open conversation. Driven by the store's live
 * `typing` slice (see {@link TeamsController} typing presence); renders nothing
 * when nobody is typing. The three dots animate with a gentle staggered bounce
 * (disabled under prefers-reduced-motion by the global rule in app.css).
 *
 * The row is laid out on the COMPOSER's own reading column, not the pane's edge:
 * the hint belongs to the box under it, and a line that started where the window
 * did read as a second, unrelated strip on a wide screen.
 *
 * It leads with the typists' faces, because a name is what the label already says
 * and a face is what a reader recognises without reading. They are the people the
 * label names ({@link typingPeople}), so the pictures and the words agree.
 */
export function TypingIndicator() {
  const typing = useAppState((s) => (s.openId ? s.typingByConversation[s.openId] : undefined));
  if (!typing || typing.length === 0) return null;
  const people = typingPeople(typing).slice(0, MAX_TYPING_FACES);
  const label = typingLabel(typing.map((t) => t.name));
  return (
    <div
      data-testid="typing-indicator"
      role="status"
      aria-live="polite"
      // `relative z-10` keeps the line above the composer's fade overlay, which
      // hangs up over this row from the bar below. The horizontal padding is the
      // composer's own outer `px-4` (see composer.tsx).
      className="relative z-10 px-4 pb-1.5 duration-200 animate-in fade-in slide-in-from-bottom-1"
    >
      {/* The composer's reading column, and inside it the box's own `px-3` plus the
          field's `px-1` (COMPOSER_FIELD_CLASS) — so the faces begin exactly where the
          words the user types do, rather than 4px to their left. */}
      <div className="mx-auto flex w-full max-w-composer items-center gap-2 px-4 text-xs text-text-faint">
        <span className="flex items-center" aria-hidden="true">
          {people.map((person, i) => {
            // A live signal carries an MRI, so the real photo is what shows; the
            // Avatar falls back to that person's tinted initials on its own.
            const photo: AvatarPhoto | undefined = person.mri
              ? { kind: "user", id: person.mri }
              : undefined;
            return (
              <span
                key={person.mri}
                data-testid="typing-avatar"
                // The stack overlaps left over right, so the first person named is
                // the face on top — the ring is what separates one from the next.
                className={cn("relative rounded-full ring-2 ring-background", i > 0 && "-ml-1.5")}
                style={{ zIndex: people.length - i }}
              >
                <Avatar
                  seed={person.mri || person.name}
                  label={person.name}
                  // One typist is one face with room for both initials; a stack
                  // clips the left one, so it shows a single letter instead.
                  initials={people.length > 1 ? firstAvatarInitial(person.name) : undefined}
                  fallback="person"
                  photo={photo}
                  className="size-5 text-[9px]"
                />
              </span>
            );
          })}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <span className="typing-dots" aria-hidden="true">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </span>
      </div>
    </div>
  );
}
