// A searchable select dialog — a faithful port of opencode's TUI DialogSelect
// (packages/tui/src/ui/dialog-select.tsx + ui/dialog.tsx). Same UI, same
// navigation, same fuzzy search:
//
//   - a dimmed full-screen backdrop with a centered panel anchored a quarter of
//     the way down the screen (opencode's Dialog frame)
//   - a bold title with an "esc" affordance on the right, and a focused filter
//     input underneath
//   - a scrollable result list where the active row is a full-width highlight
//     bar (primary background, near-black text, bold) and the *current* value is
//     marked with a ● dot in the primary color
//   - fuzzy filtering via fuzzysort (the same library and version opencode uses)
//   - navigation: ↑/Ctrl+P and ↓/Ctrl+N (wrapping), PageUp/PageDown (±10),
//     Home/End, Enter to select, Esc to close, plus mouse hover/click
//
// Colors are opencode's default dark theme (theme/assets/opencode.json): the
// selected row is `primary` (#fab283) with `background` (#0a0a0a) text, which is
// exactly what `selectedForeground()` resolves to for an opaque background.
//
// This is intentionally generic (options carry an opaque `value`) so it can back
// any "quick switch" surface; the conversation switcher in app.tsx is the first
// caller.

import { RGBA, TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, createEffect, For, Show } from "solid-js";
import * as fuzzysort from "fuzzysort";
import { theme } from "./theme";
import { selectedForeground } from "./theme/resolve";

// Backdrop dim, matching opencode's RGBA.fromInts(0, 0, 0, 150).
const BACKDROP = RGBA.fromInts(0, 0, 0, 150);

// Browse (empty query) shows the most-recent slice; searching runs fuzzysort.
// Mirrors opencode's session dialog bounds (browse 100 / search 30-ish) so a
// huge list never renders thousands of rows at once.
const BROWSE_CAP = 100;
const SEARCH_CAP = 50;

export interface DialogSelectOption<T> {
  title: string;
  value: T;
}

export function DialogSelect<T>(props: {
  title: string;
  placeholder?: string;
  options: DialogSelectOption<T>[];
  /** The value considered "current"; rendered with a ● dot like opencode. */
  current?: T;
  onSelect: (option: DialogSelectOption<T>) => void;
  onClose: () => void;
  emptyText?: string;
  /** Selection to start on (defaults to the first row). */
  initialIndex?: number;
  /** Fires whenever the highlighted row changes — used for live preview. */
  onHighlight?: (option: DialogSelectOption<T>) => void;
}) {
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(props.initialIndex ?? 0);
  // Track whether the last input was keyboard or mouse. A filter change can
  // trigger a synthetic mousemove as the layout shifts under the cursor; without
  // this guard that phantom hover would hijack the keyboard selection.
  const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

  let scroll: ScrollBoxRenderable | undefined;

  const filtered = createMemo(() => {
    const q = query().trim();
    if (!q) return props.options.slice(0, BROWSE_CAP);
    return fuzzysort
      .go(q, props.options, { key: "title", limit: SEARCH_CAP })
      .map((r) => r.obj);
  });

  // Clamp the selection into range on every filter change (opencode resets to
  // the first item whenever the query changes) and pin the list back to the top.
  // The first run is skipped so `initialIndex` survives mount.
  let firstFilter = true;
  createEffect(() => {
    filtered();
    if (firstFilter) {
      firstFilter = false;
      return;
    }
    setInputMode("keyboard");
    setSelected(0);
    setTimeout(() => scroll?.scrollTo(0), 0);
  });

  // The in-range selected index; reading through this keeps us valid even if the
  // list shrank between a keypress and a render.
  const sel = createMemo(() => {
    const n = filtered().length;
    if (n === 0) return 0;
    return Math.min(selected(), n - 1);
  });

  // Report the highlighted option so callers can preview it live (e.g. a theme
  // picker applying the focused theme). Fires on mount and on every move.
  createEffect(() => {
    const option = filtered()[sel()];
    if (option) props.onHighlight?.(option);
  });

  // Half-ish the screen, capped by the number of rows — opencode's exact sizing.
  const listHeight = createMemo(() => {
    const rows = filtered().length;
    return Math.max(1, Math.min(rows, Math.floor(dimensions().height / 2) - 6));
  });

  const panelWidth = createMemo(() => Math.min(60, dimensions().width - 2));

  function scrollToSelection() {
    if (!scroll) return;
    const target = scroll.getChildren()[sel()];
    if (!target) return;
    const y = target.y - scroll.y;
    if (y < 0) {
      scroll.scrollBy(y);
      if (sel() === 0) scroll.scrollTo(0);
    } else if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1);
    }
  }

  function move(direction: number) {
    const n = filtered().length;
    if (n === 0) return;
    let next = sel() + direction;
    if (next < 0) next = n - 1;
    if (next >= n) next = 0;
    setInputMode("keyboard");
    setSelected(next);
    setTimeout(scrollToSelection, 0);
  }

  function moveTo(index: number) {
    const n = filtered().length;
    if (n === 0) return;
    setInputMode("keyboard");
    setSelected(Math.max(0, Math.min(index, n - 1)));
    setTimeout(scrollToSelection, 0);
  }

  function submit() {
    const option = filtered()[sel()];
    if (option) props.onSelect(option);
  }

  // While the dialog is mounted it owns navigation. The filter <input> is
  // focused and swallows typing/left-right; the arrow, page, home/end and enter
  // keys still reach this renderer-level listener (the same way app.tsx's global
  // handler sees keys even while the composer is focused).
  useKeyboard((e) => {
    const n = e.name;
    if (n === "escape") return props.onClose();
    if (n === "return") return submit();
    if (n === "up" || (e.ctrl && n === "p")) return move(-1);
    if (n === "down" || (e.ctrl && n === "n")) return move(1);
    if (n === "pageup") return move(-10);
    if (n === "pagedown") return move(10);
    if (n === "home") return moveTo(0);
    if (n === "end") return moveTo(filtered().length - 1);
  });

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: dimensions().width,
        height: dimensions().height,
        alignItems: "center",
        paddingTop: Math.floor(dimensions().height / 4),
        backgroundColor: BACKDROP,
      }}
      onMouseUp={() => props.onClose()}
    >
      <box
        // Swallow clicks on the panel so they don't bubble to the backdrop's
        // close handler.
        onMouseUp={(e: { stopPropagation(): void }) => e.stopPropagation()}
        style={{
          width: panelWidth(),
          flexDirection: "column",
          backgroundColor: theme().backgroundPanel,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {/* header: title + esc, then the filter input */}
        <box style={{ paddingLeft: 4, paddingRight: 4, flexDirection: "column" }}>
          <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <text content={props.title} style={{ fg: theme().text, attributes: TextAttributes.BOLD }} />
            <text content="esc" style={{ fg: theme().textMuted }} onMouseUp={() => props.onClose()} />
          </box>
          <box style={{ paddingTop: 1 }}>
            <input
              style={{
                backgroundColor: theme().backgroundPanel,
                focusedBackgroundColor: theme().backgroundPanel,
                textColor: theme().text,
                focusedTextColor: theme().text,
              }}
              focused={true}
              placeholder={props.placeholder ?? "Search"}
              placeholderColor={theme().textMuted}
              value={query()}
              onInput={(v: string) => setQuery(v)}
            />
          </box>
        </box>

        {/* results */}
        <Show
          when={filtered().length > 0}
          fallback={
            <box style={{ paddingLeft: 4, paddingRight: 4, paddingTop: 1 }}>
              <text content={props.emptyText ?? "No results found"} style={{ fg: theme().textMuted }} />
            </box>
          }
        >
          <box style={{ paddingTop: 1 }}>
            <scrollbox
              ref={(r: ScrollBoxRenderable) => (scroll = r)}
              style={{ maxHeight: listHeight(), paddingLeft: 1, paddingRight: 1 }}
              scrollbarOptions={{ visible: false }}
            >
              <For each={filtered()}>
                {(option, i) => {
                  const active = createMemo(() => i() === sel());
                  const current = createMemo(() => props.current !== undefined && option.value === props.current);
                  const fg = createMemo(() =>
                    active() ? selectedForeground(theme()) : current() ? theme().primary : theme().text,
                  );
                  return (
                    <box
                      style={{
                        flexDirection: "row",
                        paddingLeft: current() ? 1 : 3,
                        paddingRight: 3,
                        gap: 1,
                        backgroundColor: active() ? theme().primary : "transparent",
                      }}
                      onMouseMove={() => setInputMode("mouse")}
                      onMouseOver={() => {
                        if (inputMode() === "mouse") setSelected(i());
                      }}
                      onMouseDown={() => setSelected(i())}
                      onMouseUp={() => props.onSelect(option)}
                    >
                      <Show when={current()}>
                        <text content="●" style={{ fg: fg() }} />
                      </Show>
                      <text
                        content={option.title}
                        style={{
                          flexGrow: 1,
                          paddingLeft: 3,
                          fg: fg(),
                          attributes: active() ? TextAttributes.BOLD : undefined,
                        }}
                      />
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </box>
        </Show>
      </box>
    </box>
  );
}
