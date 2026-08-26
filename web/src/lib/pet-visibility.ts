/**
 * WHETHER THIS WINDOW DRAWS THE COMPANIONS — the whole of the preference behind
 * Settings › Companions, and nothing else.
 *
 * It is modelled on lib/sounds.ts's own pure layer (key / default / coerce, no DOM and no
 * storage) for that file's own reason: a switch whose default and whose round-trip are pure
 * functions is testable without a browser, and the controller (lib/store.ts) owns the
 * persistence and the state. "Companion" is the word the reader is shown and "pet" the word
 * the code uses everywhere else here (pet-wire.ts, pet-state.ts, `petError`), which is why
 * the exports below are spelled `PETS_*`: one vocabulary in the source, one in the pane.
 *
 * **IT IS LOCAL TO THIS BROWSER, AND THERE IS NOTHING TO PUBLISH.** Whether a reader wants to
 * look at a creature is not a fact about the conversation — the pets themselves live in the
 * thread's own messages (pet-wire.ts), so a colleague's app is unaffected by what this window
 * decides. So there is no RPC, no backend setting and no Teams write here: it is persisted per
 * browser exactly as the chat pins, the appearance and the sounds are, and for the same reason
 * — there is no upstream to write it to.
 *
 * **HIDING IS NOT DESPAWNING**, and the pane says so in its own words. Off stops THIS WINDOW
 * drawing them; the reader's own pet is still in the thread, their friends still see it, and it
 * is still ageing. Taking a pet away for everybody is its own menu's Remove, which asks twice.
 * A reader who cannot tell those apart turns this switch off believing they have put their
 * creature down — which is the one misreading this preference must not invite.
 *
 * **IT IS OFFERED WHETHER OR NOT A PET EXISTS.** Settings is where somebody goes to turn a
 * thing off before they have ever met it, so the section is drawn unconditionally and has no
 * empty state. Off means the overlay is not mounted at all rather than mounted and blank.
 */

/** Persisted preference key. Client-only, like `teams-lite:sounds` and the chat pins beside
 *  it: there is no backend row for this and no Teams setting it could mirror. */
export const PETS_SHOWN_STORAGE_KEY = "teams-lite:pets-shown";

/** Companions are DRAWN out of the box; this switch is the off switch. A fresh browser shows
 *  them, because a feature carried by the thread's own messages that nothing drew until a
 *  setting was found would be a feature nobody has (the reading § Push notifications states:
 *  a setting nobody finds is a feature that does not exist). */
export const DEFAULT_PETS_SHOWN = true;

/** What is WRITTEN for a preference. It is a function rather than a literal at the call site
 *  because the two halves have to agree and nothing else can check that they do: with the
 *  encode spelled in `setPetsShown` and the decode here, a write of "yes"/"no" would leave
 *  every unit test passing while the preference silently reset to the default on every reload
 *  — which is the one thing this module promises against. One spelling, one round trip. */
export function petsShownValue(shown: boolean): "1" | "0" {
  return shown ? "1" : "0";
}

/** Read one back. "true"/"false" are honoured too, for a value edited by hand, and anything
 *  else falls back to the default — a junk entry must never be the reason a reader's creature
 *  stopped appearing. */
export function coercePetsShown(value: unknown): boolean {
  if (value === petsShownValue(true) || value === "true") return true;
  if (value === petsShownValue(false) || value === "false") return false;
  return DEFAULT_PETS_SHOWN;
}
