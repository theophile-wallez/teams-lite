import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SquareLock02Icon } from "@hugeicons/core-free-icons";
import { convLabel, type SealedConversation } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { SealKeyList } from "./seal-dialog";

/**
 * Every chat this machine holds a passphrase for — and the one place a passphrase set months
 * ago can still be read out or dropped.
 *
 * Sealing a chat is done in the chat, which is right: it is the surface that says who is in the
 * conversation, and that is what the reader is deciding about. But a conversation has to be
 * FOUND — a colleague who moved teams, a group chat 400 rows down the sidebar, a thread this app
 * no longer lists at all — and the passphrase outlives every one of those. So the LIST belongs
 * here, exactly as the renamed people's and the recordings' do, and for the same reason.
 *
 * Two things are deliberately NOT here:
 *
 *  - **Turning sealing off**, which stays in the chat's own dialog. It changes what happens to
 *    the next message somebody sends into a thread, so it belongs where the reader can see who
 *    reads that thread — the rule the agent's own consent switch already follows.
 *  - **A second spelling of anything.** The rows are the dialog's own `SealKeyList`, so "Show"
 *    and "Forget" behave identically wherever they are pressed, and forgetting asks twice in one
 *    place rather than in two.
 */
export function SealSettings() {
  const sealStatus = useAppState((s) => s.sealStatus);

  // NOTHING is drawn until the backend has answered. `null` is both "not asked yet" and "this
  // build has no seal at all", and a section about encryption on a machine that has none would
  // be a claim about a feature that is not there — while the answer for every other machine is
  // one round trip away, on connect. It is the reading every decision in lib/seal.ts takes.
  if (!sealStatus) return null;

  const sealed = sealStatus.conversations;

  return (
    <section className="flex flex-col gap-4" data-testid="seal-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary shadow-chip">
          <HugeiconsIcon icon={SquareLock02Icon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Encrypted chats</h3>
          <p className="text-[13px] text-text-faint">
            The chats whose messages this app encrypts before they reach Microsoft, and the
            passphrases it holds for them. A passphrase is kept on this machine only, so it is not
            on your other devices — show one here to give it to somebody. Encrypt a chat from the
            conversation&apos;s own menu.
          </p>
        </div>
      </div>

      <SealedPushWordsSwitch />

      {sealed.length === 0 ? (
        <p
          data-testid="seal-settings-empty"
          className="rounded-xl bg-card p-4 text-[13px] text-text-faint shadow-chip"
        >
          No chat on this machine is encrypted yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sealed.map((conversation) => (
            <li key={conversation.conversation}>
              <SealedConversationRow conversation={conversation} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One sealed chat: which one it is, whether it is still sealing, and its passphrases. */
function SealedConversationRow(props: { conversation: SealedConversation }) {
  const { conversation } = props;
  const conversations = useAppState((s) => s.conversations);

  // Named from the lists the app already has — never resolved again. A chat this app no longer
  // holds still belongs in this list, because its passphrase is still on this machine and
  // dropping it is exactly what somebody comes here to do.
  const known = conversations.find((c) => c.id === conversation.conversation);
  const name = known ? convLabel(known) : "A conversation this app no longer holds";

  const keys = conversation.keys.length;
  return (
    <div
      data-testid="seal-conversation-row"
      data-conversation-id={conversation.conversation}
      data-sealing={conversation.sealing ? "true" : "false"}
      className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-chip"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="text-[11px] text-text-faint">
          {conversation.sealing
            ? "Encrypting new messages"
            : "Not encrypting new messages — every passphrase kept, so what is already there still opens"}
          {" · "}
          {keys === 1 ? "1 passphrase" : `${keys} passphrases`}
        </span>
      </div>
      <SealKeyList conversationId={conversation.conversation} keys={conversation.keys} />
    </div>
  );
}

/**
 * Whether a notification about a sealed chat carries the WORDS.
 *
 * OFF by default, and the reverse of every other switch in this pane: the backend holds the key
 * and could publish the words either way — the payload is encrypted to the device, so no push
 * service reads them — and what the setting decides is whether the words of a chat the user
 * deliberately sealed appear on a locked screen. A sealed chat still notifies with it off: the
 * notification says who wrote and not what they said, because silence would leave the reader
 * wondering, which is worse than a preview that says nothing.
 *
 * It lives in this section rather than beside the other notification switches because it is a
 * fact about THIS list: what it decides is what happens to a message in one of the chats above.
 */
function SealedPushWordsSwitch() {
  const controller = useController();
  const enabled = useAppState((s) => s.settings.sealed_push_words);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await controller.saveSettings({ sealedPushWords: !enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 shadow-chip">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-foreground">
            Show the words in a notification
          </span>
          <span className="text-[11px] text-text-faint">
            {enabled
              ? "On — a notification about an encrypted chat carries the message, so anybody who can see this device's lock screen reads it"
              : "Off — a notification about an encrypted chat says who wrote, and not what they said"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Show the words of an encrypted chat in a notification"
          data-testid="sealed-push-words-toggle"
          disabled={busy}
          onClick={() => void toggle()}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            busy && "opacity-60",
            enabled ? "bg-primary" : "bg-element",
          )}
        >
          <span
            className={cn(
              "inline-block size-5 transform rounded-full bg-white shadow-sm transition-transform",
              enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {error && (
        <span data-testid="sealed-push-words-error" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </>
  );
}
