import { useMemo } from "react";
import {
  chatRows,
  organizeChats,
  type ChatRow,
  type ChatSection,
  type ChatSectionId,
  type Conversation,
} from "~/lib/protocol";
import { useAppState } from "./controller-context";

/** The store key one chat-list group folds under. Namespaced, because the channel
 *  tree already owns a section called `"pinned"` and the two fold apart. */
export function chatSectionKey(id: ChatSectionId): string {
  return `chats:${id}`;
}

/** How a chat-list group OPENS, before the user has folded it here: Pinned and
 *  Recent open, and the chats that are put away stay put away — exactly like the
 *  channel tree's "Hidden channels" entry. */
function collapsedByDefault(id: ChatSectionId): boolean {
  return id === "hidden";
}

/**
 * The chat list as it is rendered: its sections, the flat row model the virtualizer
 * walks, and the chats currently on screen in that same order.
 *
 * One hook, used by both the sidebar and the app shell, because the keyboard
 * selection is an INDEX into this order: computing it twice from two different
 * places is how ArrowDown ends up opening a chat other than the highlighted row.
 * A chat inside a folded section is in neither list, so the keyboard skips what the
 * eye cannot see.
 */
export function useChatSections(): {
  sections: ChatSection[];
  rows: ChatRow[];
  chats: Conversation[];
  /** Whether each section is folded, defaults resolved — the header reads it back,
   *  so the chevron and the rows can never disagree. */
  collapsed: Record<ChatSectionId, boolean>;
} {
  const conversations = useAppState((s) => s.conversations);
  const prefs = useAppState((s) => s.chatPrefs);
  const collapsedSections = useAppState((s) => s.collapsedSections);

  return useMemo(() => {
    const sections = organizeChats(conversations, prefs);
    const collapsed = {} as Record<ChatSectionId, boolean>;
    for (const section of sections) {
      const stored = collapsedSections[chatSectionKey(section.id)];
      collapsed[section.id] = stored === undefined ? collapsedByDefault(section.id) : stored;
    }
    const rows = chatRows(sections, collapsed);
    const chats = rows.flatMap((row) => (row.kind === "chat" ? [row.chat] : []));
    return { sections, rows, chats, collapsed };
  }, [conversations, prefs, collapsedSections]);
}
