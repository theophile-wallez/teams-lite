import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Copy01Icon,
  Delete02Icon,
  Loading02Icon,
  SquareLock02Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { copyText } from "~/lib/clipboard";
import { convLabel, type SealKeyRecord } from "~/lib/protocol";
import {
  SEAL_COMPOSER_HINT,
  SEAL_FORGET_WARNING,
  SEAL_PASSPHRASE_MAX_CHARS,
  SEAL_SHARING_NOTE,
  SEAL_STORAGE_NOTE,
  sealHoldsKey,
  sealIsOn,
  sealOf,
  sealPassphraseGroups,
  sealSetMismatch,
} from "~/lib/seal";
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
import { Input } from "./ui/input";

/**
 * Everything the user does to a chat's ENCRYPTION, in one dialog — reached from the
 * conversation's own menu and from a locked row's "Add the passphrase" (see lib/seal.ts and
 * § A sealed chat).
 *
 * It holds no crypto, because there is none on this side: the BACKEND is the encryption
 * boundary (src/seal.rs), so every button here is a request and the only secret that ever
 * reaches the page is a passphrase the user asked to SEE — `seal_set`'s answer when the backend
 * invented one, and `seal_reveal`. Neither is written into app state: a secret in a reactive
 * store is a secret every subscriber holds and every devtool prints, so both live in this
 * component's own state and go with the dialog (Radix unmounts the content on close).
 *
 * Three states, and which one it opens in is read from the backend's own answer rather than
 * remembered:
 *
 *  - **no passphrase yet** — the field, with the app's own offer to make one. The two facts the
 *    reader decides with are stated BEFORE the press, because handing a passphrase out is the
 *    part of this that cannot be taken back (`SEAL_SHARING_NOTE`, `SEAL_STORAGE_NOTE`).
 *  - **adding one a colleague gave them** — the same field, and the sharpest failure this
 *    feature has is reported at it: a passphrase that does not open what the thread already
 *    holds means the two of them are sealing past each other, and nothing else would tell them
 *    (`sealSetMismatch`).
 *  - **already sealed** — which passphrase is current, the press that shows one so it can be
 *    shared, the press that stops sealing NEW messages while keeping every key, and — behind a
 *    second press — the one act here that nothing takes back.
 *
 * Every failure is reported AT the dialog, in the backend's own words: an outward action that
 * did not happen must never be left looking like it did (§ Sending messages). The app's own
 * Escape stands aside for it with no help from this file, because it is the shared `Dialog`
 * primitive and `aModalIsOpen` asks the DOM for a `role="dialog"` — a hand-rolled overlay here
 * would close the form AND navigate out of the pane behind it (see lib/platform.ts).
 */

/** Every press in here clears the touch floor on a phone, which is where this app is read.
 *  36px is the app's own desktop size for a button; 44px is the floor a menu row, a dialog's
 *  close and a slider's thumb already hold (§ A HOLD is how a phone reaches a menu). It is a
 *  CSS variant rather than `useCoarsePointer` because nothing changes shape — only the height
 *  of the box around the same words, so there is no dead keyboard stop to introduce. */
const TOUCH = "pointer-coarse:h-11";

export function SealDialog(props: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const controller = useController();
  const sealStatus = useAppState((s) => s.sealStatus);
  const conversations = useAppState((s) => s.conversations);

  const record = sealOf(sealStatus, props.conversationId);
  const sealing = sealIsOn(sealStatus, props.conversationId);
  const holdsKey = sealHoldsKey(sealStatus, props.conversationId);
  // Named from the list the app already has, never resolved a second time: this dialog is
  // opened from a header and from a bubble, and a name fetched here would be a second answer
  // to a question the sidebar has already answered.
  const conversation = conversations.find((c) => c.id === props.conversationId);
  const chat = conversation ? convLabel(conversation) : "this chat";

  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last write ANSWERED, and the only place a generated passphrase exists on this
  // side: the one time it crosses the socket is that answer, so this is the whole of the
  // reader's chance to copy it.
  const [outcome, setOutcome] = useState<{
    passphrase?: string;
    mismatch: string | null;
  } | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // Nothing about one visit survives into the next, in EITHER direction. Closing matters as much
  // as opening, because this component is not unmounted with its own dialog: it stays mounted on
  // the header — and on every locked row of the thread — so a passphrase left in state would be
  // back on screen the next time that same control was pressed.
  useEffect(() => {
    setTyped("");
    setBusy(false);
    setError(null);
    setOutcome(null);
  }, [props.open]);

  const passphrase = typed.trim();
  // What the press does, said on the press itself. `seal_set` means four different things here
  // and only the words tell them apart: with a passphrase it starts sealing under one somebody
  // already has, and EMPTY it makes one — which in a chat already sealing REPLACES the current
  // key, and the cost of that lands on the colleague still holding the old one.
  const pressLabel = passphrase
    ? sealing
      ? "Add this passphrase"
      : "Encrypt with this passphrase"
    : sealing
      ? "Replace it with a new passphrase"
      : "Encrypt with a new passphrase";

  async function applyPassphrase(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const answer = await controller.sealSet(
        props.conversationId,
        // ABSENT rather than empty, because that is what the backend reads as "make one": an
        // empty string is a passphrase, and one it refuses.
        passphrase === "" ? undefined : passphrase,
      );
      const mismatch = sealSetMismatch(answer);
      setTyped("");
      // The dialog stays open exactly while the reader still has something to read or to copy
      // — a passphrase only this answer carries, or the warning that their colleague's messages
      // stay shut. With neither, the press is finished and what it changed is already drawn
      // behind this dialog, so holding it open would ask for a second press that says nothing.
      if (answer.passphrase || mismatch) {
        setOutcome({ passphrase: answer.passphrase, mismatch });
      } else {
        props.onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopSealing(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await controller.sealOff(props.conversationId);
      // Kept open, and the outcome of an earlier press dropped: the reader has just changed
      // what happens to their next message, and the line above the keys is where that is said.
      setOutcome(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Whether the reader is looking at a passphrase this app has just invented, with nothing typed
  // beside it. It decides which press carries the accent below, because in that one moment the
  // action is finishing rather than sealing again.
  const justMade = outcome?.passphrase !== undefined && passphrase === "";

  // The three states, as one attribute a spec and a capture can read — the sentinel discipline
  // the composer follows for its conversation. `null` (a backend too old to know the method, or
  // one that has not answered) reads as "no passphrase here", which is what makes this dialog
  // offer the first one rather than claim anything about a seal it has not heard of.
  const state = holdsKey ? (sealing ? "on" : "off") : "new";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-testid="seal-dialog"
        data-seal-state={state}
        className="max-w-md"
        // The dialog is opened from a menu and from a bubble's own row, and neither must keep
        // the focus the field needs — the person card's dialog makes the same correction.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          field.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={SquareLock02Icon}
              className="size-4 shrink-0 text-primary"
              strokeWidth={1.8}
            />
            {state === "on"
              ? "This chat is encrypted"
              : state === "off"
                ? "Encryption is off here"
                : "Encrypt this chat"}
          </DialogTitle>
          {/* What encryption HERE means, said the same way in all three states: where this chat
              stands is the line above the keys, and a description that changed with it would say
              one fact twice — and the two would drift. */}
          <DialogDescription>
            Encryption covers the words of every message this app posts to {chat}: they are
            encrypted before they reach Microsoft, anybody with the passphrase reads them, and
            anybody without it — Microsoft included — does not.
          </DialogDescription>
        </DialogHeader>

        {holdsKey && record && (
          <section className="flex flex-col gap-2" data-testid="seal-current">
            <p className="text-[13px] text-text-dim">
              {sealing
                ? "New messages here are encrypted with the current passphrase."
                : // The way BACK is said out loud, because there is no press for it: the backend
                  // is given a passphrase, never told to resume one, and this app never hands it
                  // a secret the reader has not seen. Show, Copy, paste, press — three presses
                  // and no passphrase invented behind anybody's back.
                  "New messages here are not encrypted. Every passphrase is kept, so the messages already in the thread still open — to start again, show one below and put it back in the field."}
            </p>
            <SealKeyList conversationId={props.conversationId} keys={record.keys} />
            {sealing && (
              <div className="flex flex-col gap-1.5 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="seal-off"
                  className={cn(TOUCH, "self-start")}
                  disabled={busy}
                  onClick={() => void stopSealing()}
                >
                  Stop encrypting new messages
                </Button>
                <p className="text-[11px] text-text-faint">
                  Every passphrase above is kept, so the messages already here stay readable.
                </p>
              </div>
            )}
          </section>
        )}

        <section className="flex flex-col gap-1.5">
          <label
            htmlFor="seal-passphrase-field"
            className="text-[13px] font-medium text-foreground"
          >
            {holdsKey ? "Add a passphrase" : "Passphrase"}
          </label>
          <Input
            ref={field}
            id="seal-passphrase-field"
            data-testid="seal-passphrase-field"
            // Never a password field: the reader has to be able to check what they typed
            // against what a colleague read out to them, and a row of dots is exactly how a
            // mismatch is born — which is the failure this whole surface exists to catch.
            type="text"
            value={typed}
            maxLength={SEAL_PASSPHRASE_MAX_CHARS}
            // A phone's keyboard capitalises the first letter and corrects a word it does not
            // know, and both of those change a passphrase read off another screen.
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              holdsKey ? "The one a colleague gave you" : "Leave it empty and one will be made"
            }
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Enter means "use what I typed", so with an EMPTY field it does nothing wherever
              // the press would replace the current passphrase — the field is focused as the
              // dialog opens, and a stray Enter must not rotate the key of a sealed chat behind
              // a colleague still holding the old one. Making the first passphrase is safe, and
              // it is the one the reader came for.
              if (e.key === "Enter" && !busy && (passphrase !== "" || !sealing)) {
                void applyPassphrase();
              }
            }}
            // 16px so iOS does not zoom the page on focus, and 44px tall so a thumb finds it —
            // the two rules every other field in this app holds.
            className="h-11 text-base"
          />
          <p data-testid="seal-field-hint" className="text-[11px] text-text-faint">
            {holdsKey
              ? "Every passphrase above is kept, so nothing already here stops opening."
              : "A passphrase this app makes is five short groups you can read out. Type your own if you would rather."}
          </p>

          {/* The one part of a sealed message that is NOT covered, stated at the moment the
              reader decides to seal at all. The composer says it again on every message, which
              is not a duplication of the fact but of the WARNING: a chat that looked sealed
              while carrying a readable screenshot would be a lie either way. */}
          {!holdsKey && (
            <p data-testid="seal-picture-note" className="text-[11px] text-text-faint">
              {SEAL_COMPOSER_HINT}
            </p>
          )}
          <p data-testid="seal-sharing-note" className="text-[11px] text-text-faint">
            {SEAL_SHARING_NOTE}
          </p>
          <p data-testid="seal-storage-note" className="text-[11px] text-text-faint">
            {SEAL_STORAGE_NOTE}
          </p>
        </section>

        {/* What the write answered, drawn where the press was made. A generated passphrase is
            the whole reason this dialog stays open, and the mismatch is the whole reason it
            has to be read before the reader writes their next message. */}
        {outcome?.passphrase && (
          <section
            className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-chip"
            data-testid="seal-generated"
          >
            <p className="text-[13px] font-medium text-foreground">
              Give this passphrase to the people in {chat}
            </p>
            <PassphraseReadout passphrase={outcome.passphrase} testid="seal-generated-passphrase" />
          </section>
        )}

        {outcome?.mismatch && (
          <p
            data-testid="seal-mismatch"
            className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-[12px] leading-snug text-destructive"
          >
            <HugeiconsIcon
              icon={Alert02Icon}
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.8}
            />
            {outcome.mismatch}
          </p>
        )}

        {error && (
          <p data-testid="seal-error" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            data-testid="seal-close"
            // The accent moves to this one the moment a passphrase has been MADE: reading it out
            // is what is left to do, and the press beside it would make a second one.
            variant={justMade ? "default" : "ghost"}
            className={TOUCH}
            disabled={busy}
            onClick={() => props.onOpenChange(false)}
          >
            {/* "Done" once a write has landed: by then there is nothing to cancel, and the word
                would say the reader can still take it back. */}
            {outcome ? "Done" : "Cancel"}
          </Button>
          {/* Stood down while a freshly made passphrase is on screen and the field is empty: that
              press generates one and REPLACES the current key, which nobody means a moment after
              being shown the first. Typing a colleague's own brings it straight back. */}
          {!justMade && (
            <Button
              type="button"
              data-testid="seal-apply"
              className={TOUCH}
              disabled={busy}
              onClick={() => void applyPassphrase()}
            >
              {busy && (
                <HugeiconsIcon icon={Loading02Icon} className="animate-spin" strokeWidth={1.8} />
              )}
              {pressLabel}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The passphrases this machine holds for one conversation: which one is current, the press that
 * shows one, and the press that forgets one for good.
 *
 * Exported because Settings lists the same rows for every sealed chat (see
 * components/seal-settings.tsx). One spelling on purpose: a second copy of "forgetting asks
 * twice" is a second chance to get it wrong — the rule `require_own_gitlab_note` states for the
 * two writes that share a check.
 */
export function SealKeyList(props: { conversationId: string; keys: SealKeyRecord[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {/* The order is the backend's own. Sorting here would move a row under the reader between
          two answers, and the row they are aiming at is the one that forgets a passphrase. */}
      {props.keys.map((key) => (
        <li key={key.key_id}>
          <SealKeyRow conversationId={props.conversationId} keyRecord={key} />
        </li>
      ))}
    </ul>
  );
}

/** One passphrase: what it is, whether it is the current one, and the two things that can be
 *  done with it. Both reports live on the ROW rather than at the dialog, because a conversation
 *  holds several keys and a failure drawn once would be read as belonging to all of them — the
 *  rule a diff's own comment boxes already follow. */
function SealKeyRow(props: { conversationId: string; keyRecord: SealKeyRecord }) {
  const controller = useController();
  const { keyRecord } = props;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Straight into this row's own state and no further: it is a secret, so it never reaches
      // the store, and the row unmounts with the surface that asked for it.
      setRevealed(await controller.sealReveal(props.conversationId, keyRecord.key_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await controller.sealForget(props.conversationId, keyRecord.key_id);
      // No cleanup: the row goes with the key it drew, because the answer to every seal write
      // is the fresh status this list is built from.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="seal-key-row"
      data-key-id={keyRecord.key_id}
      data-seal-key-current={keyRecord.is_current ? "true" : "false"}
      className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-chip"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            {/* The key ID, which is NOT the passphrase and never stands in for one: it is what
                says WHICH passphrase a locked message needs, and it is the only half of a key
                this app is willing to draw without a press. */}
            <span className="truncate font-mono text-[13px] text-foreground">
              {keyRecord.key_id}
            </span>
            {keyRecord.is_current && (
              <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                Current
              </span>
            )}
          </span>
          <span className="text-[11px] text-text-faint">
            {keyRecord.added_ms > 0
              ? `Added ${new Date(keyRecord.added_ms).toLocaleDateString()}`
              : "Added at an unknown time"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={TOUCH}
            data-testid="seal-reveal"
            // The words say what the press does; the label says which passphrase it is about,
            // because a chat that has rotated draws several of these rows.
            aria-label={
              revealed === null
                ? `Show the passphrase ${keyRecord.key_id}`
                : `Hide the passphrase ${keyRecord.key_id}`
            }
            disabled={busy}
            onClick={() => (revealed === null ? void reveal() : setRevealed(null))}
          >
            <HugeiconsIcon icon={revealed === null ? ViewIcon : ViewOffIcon} strokeWidth={1.8} />
            {revealed === null ? "Show" : "Hide"}
          </Button>
          {!confirming && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={TOUCH}
              data-testid="seal-forget"
              aria-label={`Forget the passphrase ${keyRecord.key_id}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
              Forget
            </Button>
          )}
        </span>
      </div>

      {revealed !== null && (
        <PassphraseReadout passphrase={revealed} testid="seal-revealed-passphrase" />
      )}

      {/* Forgetting asks twice, the way a message deletion does, and for the sharper version of
          the same reason: the messages this passphrase opened are still in the thread, and no
          later press makes them readable here again. */}
      {confirming && (
        <div className="flex flex-col gap-2">
          <p data-testid="seal-forget-warning" className="text-[12px] leading-snug text-destructive">
            {SEAL_FORGET_WARNING}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className={TOUCH}
              data-testid="seal-forget-confirm"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy && (
                <HugeiconsIcon icon={Loading02Icon} className="animate-spin" strokeWidth={1.8} />
              )}
              Forget it for good
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={TOUCH}
              data-testid="seal-forget-cancel"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p data-testid="seal-key-error" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A passphrase, drawn to be read out and retyped: its own groups (`sealPassphraseGroups`), in a
 * monospace face at 16px, selectable, with one press that copies the whole thing.
 *
 * The hyphens are drawn between the groups rather than dropped, so somebody typing it into
 * another machine writes what they see — the backend canonicalises the separators away, but a
 * reader cannot know that and should not have to.
 */
function PassphraseReadout(props: { passphrase: string; testid: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const groups = sealPassphraseGroups(props.passphrase);

  // The outcome is reported rather than assumed: this app is opened over plain HTTP on a LAN
  // too, where `navigator.clipboard` is simply absent, and a Copy that says nothing while the
  // clipboard kept its old contents is the failure lib/clipboard.ts exists to make visible.
  const copy = async () => {
    setCopied((await copyText(props.passphrase)) ? "yes" : "no");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid={props.testid}
          className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 gap-y-0.5 font-mono text-base tracking-wide text-foreground select-all break-words"
        >
          {groups.map((group, index) => (
            <span key={`${group}-${index}`}>
              {index > 0 && <span className="text-text-faint">-</span>}
              {group}
            </span>
          ))}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(TOUCH, "shrink-0")}
          // Named after the readout it belongs to: a dialog can hold two of these at once — a
          // passphrase just generated, and an older one somebody pressed Show on — and one
          // name for both would leave a spec, and a capture, aiming at whichever came first.
          data-testid={`${props.testid}-copy`}
          onClick={() => void copy()}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={1.8} />
          Copy
        </Button>
      </div>
      {copied && (
        <span
          data-testid={`${props.testid}-copy-result`}
          className={cn("text-[11px]", copied === "yes" ? "text-text-faint" : "text-destructive")}
        >
          {copied === "yes"
            ? "Copied."
            : "This browser would not let the app copy it — select it and copy it by hand."}
        </span>
      )}
    </div>
  );
}
