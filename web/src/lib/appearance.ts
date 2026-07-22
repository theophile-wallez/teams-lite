// teams-lite web — appearance (Light / Dark / System).
//
// A single, modern Light+Dark design with a System option that follows the OS
// setting. This module is PURE (no DOM, no storage) so it is trivially testable;
// the controller (lib/store.ts) owns the side effects (reading the OS media
// query, writing the data-theme attribute, persisting the choice).

export type Appearance = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Persisted preference key. Kept as "teams-theme" for backward compatibility
 *  with the pre-hydration bootstrap and any previously stored value. */
export const APPEARANCE_STORAGE_KEY = "teams-theme";

export const DEFAULT_APPEARANCE: Appearance = "system";

/** Selectable options, in display order. */
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"] as const;

export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

/** Coerce an unknown stored value to a valid appearance (default when invalid).
 *  Legacy theme ids (the old 34-theme picker wrote things like "dracula") fall
 *  back to the default so upgrading users get a sane light/dark experience. */
export function coerceAppearance(value: unknown): Appearance {
  return isAppearance(value) ? value : DEFAULT_APPEARANCE;
}

/** Resolve a preference to the concrete theme that CSS keys off. */
export function resolveTheme(pref: Appearance, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

export function appearanceLabel(pref: Appearance): string {
  switch (pref) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    case "system":
      return "System";
  }
}
