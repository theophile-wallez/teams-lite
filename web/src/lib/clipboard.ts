/**
 * Put text on the clipboard, wherever this app happens to be open.
 *
 * The async Clipboard API is the right call and it is not always there. It needs a
 * SECURE context, and a plain-HTTP front is a supported way to open this app — the
 * launcher takes `--host`, so a phone on the LAN reaching `http://<machine>:19440`
 * gets `navigator.clipboard === undefined` — and a browser may refuse the write even
 * in a secure one. Either way the write is lost, and the only report is one line at
 * the foot of the sidebar, so it reads as a Copy that does nothing.
 *
 * So a missing or refused API falls back to the selection path every browser still
 * carries: `execCommand("copy")`, which needs no secure context and no permission —
 * only the user gesture the click already is.
 *
 * NOTHING IS AWAITED BEFORE THE FIRST ATTEMPT. Both paths spend the activation that
 * click gave us, and it is gone by the next task: with the API absent the fallback
 * therefore runs synchronously, inside the gesture. After a REJECTION it is a
 * best-effort second chance rather than a guarantee, since the refusal lands a task
 * later — which is why the caller still reports the outcome.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  const writeText = navigator.clipboard?.writeText;
  if (!writeText) return copyBySelection(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelection(text);
  }
}

/**
 * The pre-Clipboard-API copy, kept for the contexts that still only have it. Two things
 * about it are load-bearing, and each was measured against the browser rather than
 * assumed (`web/e2e/messaging.spec.ts` holds them to the CLIPBOARD, not to the sentence
 * the app says afterwards):
 *
 *  - **The text is selected by RANGE, never by focusing a field.** Copy is offered from
 *    inside an open Radix menu, whose focus scope bounces the focus straight back — so a
 *    hidden `<textarea>` was never focused, nothing was selected, and the copy carried
 *    nothing. A selection needs no focus.
 *  - **The `copy` EVENT is what writes, and what says the write happened.** With an empty
 *    selection `execCommand("copy")` still answered `true` while the clipboard kept its
 *    old contents — a lie in exactly the shape this whole fix exists to remove. Setting
 *    the data on the event makes the write independent of what the selection ended up
 *    being, and the flag makes the answer the truth.
 */
function copyBySelection(text: string): boolean {
  // Off-screen, but LAID OUT and selectable: a node with no box has no range to select,
  // `pre-wrap` keeps the newlines of a body that spans two blocks, and the app's own
  // `user-select` is overridden rather than trusted.
  const holder = document.createElement("span");
  holder.textContent = text;
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;top:0;left:-9999px;white-space:pre-wrap;user-select:text";
  document.body.append(holder);

  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    wrote = true;
  };
  document.addEventListener("copy", onCopy, true);

  // The reader may have had a selection of their own; it is put back either way.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const range = document.createRange();
  range.selectNodeContents(holder);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let ran = false;
  try {
    ran = document.execCommand("copy");
  } catch {
    ran = false;
  }

  document.removeEventListener("copy", onCopy, true);
  selection?.removeAllRanges();
  if (previous) selection?.addRange(previous);
  holder.remove();
  return ran && wrote;
}
