/**
 * A SEALED chat, on the page's side: every pure decision the surface is built from.
 *
 * The BACKEND is the encryption boundary (src/seal.rs). It seals every body it posts to a
 * sealed conversation and decrypts on every store read, so **this file holds no crypto at
 * all** — no key, no passphrase, no ciphertext ever reaches the page. What the page is told
 * is `seal` on each message and `seal_status` for the conversations, and what it owes the
 * reader is drawn from exactly that.
 *
 * The split matters and is worth keeping: a second implementation of the envelope here would
 * be a second thing to keep in step with the one that really posts, and the passphrase would
 * have to live in a browser — where it would be entered once per device instead of once per
 * machine, which is the opposite of what the feature promises.
 */

import type { ChatMessage, SealStatus, SealedConversation } from "./protocol";

/** How a message's body reached the reader. `null` for an ordinary message. */
export type SealState = NonNullable<ChatMessage["seal"]> | null;

/** What a message's seal says, normalised — an older backend sends nothing at all. */
export function sealStateOf(message: Pick<ChatMessage, "seal">): SealState {
  return message.seal ?? null;
}

/** Whether this message's words are readable here.
 *
 *  An ordinary message and an OPENED one both are; the three failures are not. */
export function sealIsReadable(message: Pick<ChatMessage, "seal">): boolean {
  const state = sealStateOf(message);
  return state === null || state === "opened";
}

/** Whether this row's body is withheld, so the bubble draws a locked row instead of words.
 *
 *  It is the shape a DELETED message already takes: the row is still there, at its own place
 *  in the history, and what it says is why its body is not. */
export function sealIsLocked(message: Pick<ChatMessage, "seal">): boolean {
  return !sealIsReadable(message);
}

/** What a locked row SAYS, and what the reader can do about it.
 *
 *  Three sentences rather than one, because the next move differs: a missing passphrase is
 *  something they can ask a colleague for, an old build is something an update fixes, and
 *  damaged bytes are neither. Collapsing them into "this message cannot be read" is what
 *  makes an encrypted chat feel broken. */
export function sealLockedMessage(message: Pick<ChatMessage, "seal" | "seal_key_id">): string {
  switch (sealStateOf(message)) {
    case "locked":
      return "Encrypted with a passphrase this app does not have.";
    case "newer":
      return "Encrypted by a newer version of this app.";
    case "damaged":
      return "Encrypted, and these bytes could not be read.";
    default:
      return "";
  }
}

/** The one action a locked row can offer, or null where there is nothing to offer.
 *
 *  Only a missing passphrase has one, and it is the same dialog the header opens: adding it
 *  is what makes every message already in the thread readable at once. */
export function sealLockedAction(
  message: Pick<ChatMessage, "seal">,
): "add-passphrase" | null {
  return sealStateOf(message) === "locked" ? "add-passphrase" : null;
}

/** The conversation's own record, or undefined when this machine holds no key for it. */
export function sealOf(
  status: SealStatus | null,
  conversationId: string | null,
): SealedConversation | undefined {
  if (!status || !conversationId) return undefined;
  return status.conversations.find((c) => c.conversation === conversationId);
}

/** Whether NEW messages in this conversation are sealed — the one question the composer asks.
 *
 *  It reads the BACKEND's answer and is false until it arrives, which is the reading every
 *  unanswered capability takes in this app: a hopeful `true` would tell the reader their next
 *  message is encrypted while it goes out in the clear. */
export function sealIsOn(status: SealStatus | null, conversationId: string | null): boolean {
  return sealOf(status, conversationId)?.sealing === true;
}

/** Whether this machine holds any passphrase for the conversation, current or not.
 *
 *  A chat that stopped being sealed still holds its keys, so its history stays readable — and
 *  that is the state this tells apart from "nothing here is sealed at all". */
export function sealHoldsKey(status: SealStatus | null, conversationId: string | null): boolean {
  return (sealOf(status, conversationId)?.keys.length ?? 0) > 0;
}

/** Whether a conversation may be sealed at all.
 *
 *  A CHANNEL may not, in this version: its history is drawn as threads, so a sealed post there
 *  would have to answer a different question about where the padlock sits — and the backend
 *  refuses one, so offering it would be a control that reports a refusal. NOTES may not either:
 *  there is nobody to share a passphrase with, and every message in it is already the user's own.
 */
export function sealCanBeUsed(kind: string | undefined, conversationId: string | null): boolean {
  if (!conversationId) return false;
  // The channel id shape the backend's own `is_channel_thread_id` recognises.
  if (conversationId.includes(";messageid=")) return false;
  return kind !== "notes";
}

/** What the header's menu row says, given where the conversation stands. */
export function sealMenuLabel(status: SealStatus | null, conversationId: string | null): string {
  if (sealIsOn(status, conversationId)) return "Encryption on";
  if (sealHoldsKey(status, conversationId)) return "Encryption off";
  return "Encrypt this chat";
}

/** The sentence the composer carries while a chat is sealed.
 *
 *  It states the two things the reader decides with, and no more: what happens to the words,
 *  and the one part of the message that is NOT covered. A picture's bytes go to Microsoft's own
 *  object store, so nothing here can seal them (see § A sealed chat), and a message that looked
 *  sealed while carrying a readable screenshot would be a lie. */
export const SEAL_COMPOSER_HINT = "Messages here are encrypted. Pictures are not.";

/** The sentence the composer carries when the reader is about to write into a chat whose
 *  messages were sealed with a passphrase this machine does not hold.
 *
 *  This is the one warning that stops the sharpest failure this feature has: two people each
 *  set a different passphrase, every message each posts is unreadable to the other, and neither
 *  is told. */
export const SEAL_MISMATCH_HINT =
  "The messages here were encrypted with a different passphrase. What you send now may not be readable by the others.";

/** Whether the composer should carry {@link SEAL_MISMATCH_HINT}: this machine is sealing under
 *  one key while the thread's own messages carry another. */
export function sealKeyDisagrees(
  status: SealStatus | null,
  conversationId: string | null,
  messages: Pick<ChatMessage, "seal" | "seal_key_id">[],
): boolean {
  const current = sealOf(status, conversationId);
  if (!current?.sealing) return false;
  const known = new Set(current.keys.map((k) => k.key_id));
  // A message this machine could not open, under a key it does not hold, is proof of the
  // disagreement — and it is proof the page already has, without asking anything.
  return messages.some((m) => m.seal === "locked" && !!m.seal_key_id && !known.has(m.seal_key_id));
}

/** What the dialog says before the reader hands out a passphrase.
 *
 *  Both halves are load-bearing. A colleague who has the passphrase can read every message ever
 *  sealed under it — including the ones sent before they were given it — and can seal a message
 *  themselves, so a padlock is a claim about who can READ and never about who wrote. And the
 *  passphrase is kept on this machine so it can be shown again, which is the only way somebody
 *  who joins later can be given it. */
export const SEAL_SHARING_NOTE =
  "Everybody you give this passphrase to can read every message in this chat, including the ones sent before you gave it to them.";
export const SEAL_STORAGE_NOTE =
  "It is kept on this machine so you can see it again and share it. Never reuse a passphrase from somewhere else.";

/** What "forget this passphrase" costs, said before the second press.
 *
 *  It is the one act in this feature that nothing takes back: the messages it opened are still
 *  in the thread, and no later click makes them readable here again. */
export const SEAL_FORGET_WARNING =
  "Every message this passphrase opened becomes unreadable on this machine. No later action brings it back.";

/** The passphrase, as the dialog shows one the app generated: in groups, so it can be read
 *  aloud and retyped.
 *
 *  The backend generates it (`seal::generate_passphrase`) and this only decides how it is DRAWN,
 *  which is the half that decides whether it survives being typed into a phone. */
export function sealPassphraseGroups(passphrase: string): string[] {
  return passphrase.split("-").filter((group) => group.length > 0);
}
