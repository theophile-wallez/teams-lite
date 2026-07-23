import { typingLabel } from "~/lib/protocol";
import { useAppState } from "./controller-context";

/**
 * A calm, transient "… is typing" hint shown just above the composer while other
 * people are composing in the open conversation. Driven by the store's live
 * `typing` slice (see {@link TeamsController} typing presence); renders nothing
 * when nobody is typing. The three dots animate with a gentle staggered bounce
 * (disabled under prefers-reduced-motion by the global rule in app.css).
 */
export function TypingIndicator() {
  const typing = useAppState((s) => (s.openId ? s.typingByConversation[s.openId] : undefined));
  if (!typing || typing.length === 0) return null;
  const label = typingLabel(typing.map((t) => t.name));
  return (
    <div
      data-testid="typing-indicator"
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-5 pb-1.5 text-xs text-text-faint duration-200 animate-in fade-in slide-in-from-bottom-1"
    >
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}
