import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Clock01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { channelLabel, convLabel, copyableMessageText, type ChatMessage } from "~/lib/protocol";
import { scheduledRowLabel } from "~/lib/schedule-send";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** The conversation a queued message is waiting in, named the way the sidebar names it —
 *  from the lists the page ALREADY holds, so nothing about a thread is resolved twice and
 *  the backend answers messages and nothing more. An id the page does not hold (a channel
 *  never synced) keeps the id, which is at least addressable. */
function threadName(
  m: ChatMessage,
  conversations: { id: string }[],
  channels: { id: string }[],
): string {
  const conversation = conversations.find((c) => c.id === m.conversation_id);
  if (conversation) return convLabel(conversation as Parameters<typeof convLabel>[0]);
  const channel = channels.find((c) => c.id === m.conversation_id);
  if (channel) return channelLabel(channel as Parameters<typeof channelLabel>[0]);
  return m.conversation_id;
}

/**
 * Every message Teams is holding for later, and the three things that can be done to one.
 *
 * It is reached from the banner above the composer ("See all scheduled messages"), and it
 * is a DIALOG rather than a route or a Settings pane because it is a short list somebody
 * opens to act on one row and then leaves — the shape Slack's own "Scheduled" view has.
 *
 * The list is ACROSS conversations, which costs nothing: a scheduled send comes back in the
 * ordinary history, so the backend already holds every one of them (see
 * `Store::scheduled_messages`) and there is no read per thread to make.
 *
 * **Three actions, and the set is what the SERVICE allows rather than what a design would
 * like.** Measured against the tenant (`examples/scheduled_send_probe.rs`, 2026-08-18): a
 * `DELETE` cancels a held message, an EDIT releases it — it is delivered at once — and a
 * `properties` PUT of the moment is refused outright. So there is no in-place edit and no
 * reschedule to offer, and the honest third row hands the message back to the composer,
 * where the words and the moment are the reader's again. A pencil that quietly delivered
 * tomorrow's message today is precisely the mistake this shape avoids.
 *
 * None of the three is a new gate: they are `delete`, `send` and `set_draft`, each already
 * gated, and the deletion asks twice exactly as a message's own Delete does.
 */
export function ScheduledMessagesDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const controller = useController();
  const scheduled = useAppState((s) => s.scheduledMessages);
  const conversations = useAppState((s) => s.conversations);
  const channels = useAppState((s) => s.channels);
  // Which row's deletion is armed. One at a time, and it is forgotten whenever the list
  // changes — an armed row that survived a re-read could arm a different message.
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (props.open) void controller.loadScheduledMessages();
  }, [props.open, controller]);

  useEffect(() => setArmed(null), [scheduled]);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    await run();
    setBusy(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="scheduled-messages-dialog">
        <DialogHeader>
          <DialogTitle>Scheduled messages</DialogTitle>
          <DialogDescription>
            Teams holds these and sends them at the moment shown, even with this app closed.
          </DialogDescription>
        </DialogHeader>

        {scheduled.length === 0 ? (
          <p data-testid="scheduled-messages-empty" className="py-6 text-center text-sm text-text-dim">
            Nothing is waiting to go out.
          </p>
        ) : (
          <ul
            // `p-1` is the room the cards' own shadow needs: an overflow scroller clips at
            // its padding edge, so without it every row was drawn with its bottom cut off.
            className="max-h-[60vh] space-y-2 overflow-y-auto p-1"
          >
            {scheduled.map((m) => (
              <li
                key={`${m.conversation_id}/${m.id}`}
                data-testid="scheduled-message-row"
                data-message-id={m.id}
                className="rounded-xl bg-card p-3 shadow-chip"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {threadName(m, conversations, channels)}
                    </div>
                    <div
                      data-testid="scheduled-message-preview"
                      className="truncate text-xs text-text-dim"
                    >
                      {copyableMessageText(m)}
                    </div>
                  </div>
                  <div
                    data-testid="scheduled-message-when"
                    className="flex shrink-0 items-center gap-1 text-xs text-text-faint"
                  >
                    <HugeiconsIcon icon={Clock01Icon} className="size-3.5" strokeWidth={1.6} />
                    {scheduledRowLabel(m.scheduled_time ?? 0)}
                  </div>
                </div>

                {/* LABELLED, and the destructive one is pushed away from the others. Three
                    unlabelled 28px glyphs four pixels apart put "send this to everybody now"
                    next to "delete it" — on a phone that is a mis-tap that posts a message,
                    and neither icon says which is which. */}
                <div className="mt-2 flex items-center gap-2">
                  <RowAction
                    label="Send now"
                    testId="scheduled-send-now"
                    icon={SentIcon}
                    disabled={busy !== null}
                    onClick={() => void act(m.id, () => controller.sendScheduledMessageNow(m))}
                  />
                  <RowAction
                    label="Edit"
                    hint="Cancels it and puts the words back in the composer"
                    testId="scheduled-edit"
                    icon={PencilEdit02Icon}
                    disabled={busy !== null}
                    onClick={() =>
                      void act(m.id, async () => {
                        const moved = await controller.editScheduledMessage(m);
                        if (moved) props.onOpenChange(false);
                      })
                    }
                  />
                  {armed === m.id ? (
                    <button
                      type="button"
                      data-testid="scheduled-delete-confirm"
                      disabled={busy !== null}
                      onClick={() => void act(m.id, () => controller.cancelScheduledMessage(m))}
                      className="ml-auto inline-flex min-h-9 items-center rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                    >
                      Delete for good
                    </button>
                  ) : (
                    <RowAction
                      label="Delete"
                      testId="scheduled-delete"
                      icon={Delete02Icon}
                      destructive
                      disabled={busy !== null}
                      onClick={() => setArmed(m.id)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One action on a row: its glyph AND its word.
 *
 * Always drawn rather than revealed on hover, because this app is read from a phone where
 * there is no hover — the rule the chat row's "…" already follows. And LABELLED, because
 * these three actions are "post this to everybody now", "take it back" and "delete it": a
 * reader must not have to decode a 16px glyph to tell them apart. `destructive` is a
 * DESTRUCTIVE row pushed to the far end (`ml-auto`), so the irreversible one is nowhere near
 * the one that sends.
 */
function RowAction(props: {
  label: string;
  /** What the action really costs, for the pointer that rests on it. The label alone is the
   *  short form; this is where "Edit" says that it cancels the queued message. */
  hint?: string;
  testId: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={props.hint ?? props.label}
      data-testid={props.testId}
      data-cuelume-press=""
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
        props.destructive && "ml-auto hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <HugeiconsIcon icon={props.icon} className="size-4 shrink-0" strokeWidth={1.6} />
      {props.label}
    </button>
  );
}
