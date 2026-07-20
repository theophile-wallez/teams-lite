// Ctrl+P settings menu — the same DialogSelect surface as the Ctrl+K conversation
// palette, but for app settings. It is a small two-level flow:
//
//   root:  a list of settings ("Switch theme", …)
//   theme: the theme list, where focusing a row applies that theme LIVE so the
//          user can preview it (like opencode's theme picker). Enter commits the
//          focused theme; Esc reverts to the theme that was active on entry and
//          returns to the settings root. Esc at the root closes the menu.

import { createSignal, Show } from "solid-js";
import { DialogSelect } from "./dialog-select";
import { themeList, activeThemeId, setActiveThemeId } from "./theme";

export function SettingsDialog(props: { onClose: () => void }) {
  const [view, setView] = createSignal<"root" | "theme">("root");
  // The theme active when the picker was entered; restored if the user cancels.
  let themeBeforePreview = activeThemeId();

  const rootOptions = [{ title: "Switch theme", value: "theme" }];
  const themeOptions = themeList.map((t) => ({ title: t.name, value: t.id }));
  // Start the picker on the current theme so opening it previews nothing new.
  const currentThemeIndex = () => {
    const i = themeOptions.findIndex((o) => o.value === activeThemeId());
    return i < 0 ? 0 : i;
  };

  return (
    <Show
      when={view() === "theme"}
      fallback={
        <DialogSelect
          title="Settings"
          placeholder="Search settings…"
          options={rootOptions}
          onSelect={(o) => {
            if (o.value === "theme") {
              themeBeforePreview = activeThemeId();
              setView("theme");
            }
          }}
          onClose={props.onClose}
        />
      }
    >
      <DialogSelect
        title="Switch theme"
        placeholder="Search themes…"
        options={themeOptions}
        current={themeBeforePreview}
        initialIndex={currentThemeIndex()}
        onHighlight={(o) => setActiveThemeId(o.value)}
        onSelect={(o) => {
          setActiveThemeId(o.value);
          props.onClose();
        }}
        onClose={() => {
          // Cancel: undo the live preview and step back to the settings root.
          setActiveThemeId(themeBeforePreview);
          setView("root");
        }}
      />
    </Show>
  );
}
