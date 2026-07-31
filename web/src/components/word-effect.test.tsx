// @vitest-environment happy-dom
//
// How the word-effect easter egg spends its motion budget. The decoration itself is
// covered by lib/word-effects.test.ts; what matters here is *how many* words animate
// at once, because a message full of nicknames used to run one animation per letter
// and dragged the whole app to 8 fps (see lib/word-effect-motion.ts).
//
// happy-dom ships an IntersectionObserver that never calls back, so the tests
// install one they can drive: it reports a word as on screen the moment it is
// observed, and `scrollOffScreen` takes it away again.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { EffectWord, renderWordEffects } from "./word-effect";
import { MAX_MOVING_WORDS } from "~/lib/word-effect-motion";

/** The observer callbacks in play, so a test can change what is on screen. */
const watchers = new Map<IntersectionObserverCallback, Set<Element>>();

class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    watchers.set(callback, new Set());
  }
  observe(target: Element): void {
    watchers.get(this.callback)!.add(target);
    this.report(target, true);
  }
  unobserve(target: Element): void {
    watchers.get(this.callback)!.delete(target);
  }
  disconnect(): void {
    watchers.get(this.callback)!.clear();
  }
  private report(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}

/** Tell the component that these words left the viewport. */
function scrollOffScreen(targets: Iterable<Element>): void {
  const wanted = new Set(targets);
  act(() => {
    for (const [callback, observed] of watchers) {
      const gone = [...observed].filter((target) => wanted.has(target));
      if (gone.length > 0) {
        callback(
          gone.map((target) => ({ target, isIntersecting: false }) as IntersectionObserverEntry),
          null as never,
        );
      }
    }
  });
}

beforeAll(() => {
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
});

let mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.reverse()) unmount();
  mounted = [];
});

/** Mount `node` in a container of its own, unmounted when the test ends. */
function mount(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function words(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".effect-word")];
}

function movingWords(container: HTMLElement): number {
  return container.querySelectorAll('.effect-word[data-motion="on"]').length;
}

describe("EffectWord motion", () => {
  it("animates a word on screen", () => {
    const container = mount(<EffectWord word="bébou" effect="sparkle" />);
    expect(movingWords(container)).toBe(1);
  });

  it("stops animating past the budget, however many words the message holds", () => {
    const container = mount(renderWordEffects("bebou ".repeat(100), 0));
    expect(words(container).length).toBe(100);
    expect(movingWords(container)).toBe(MAX_MOVING_WORDS);
  });

  it("keeps the whole look on a word with no slot — only the motion goes", () => {
    const container = mount(renderWordEffects("bebou ".repeat(20), 0));
    const still = words(container).at(-1)!;
    expect(still.hasAttribute("data-motion")).toBe(false);
    expect(still.className).toContain("sparkle-word");
    expect(still.querySelectorAll(".effect-word-letter").length).toBe(5);
  });

  it("hands the motion on when an animated word is unmounted", () => {
    const message = mount(renderWordEffects("bebou ".repeat(MAX_MOVING_WORDS), 0));
    const latecomer = mount(<EffectWord word="bébou" effect="sparkle" />);
    expect(movingWords(message)).toBe(MAX_MOVING_WORDS);
    expect(movingWords(latecomer)).toBe(0);
    mounted.shift()!(); // the message that holds every slot scrolls out of the list
    expect(movingWords(latecomer)).toBe(1);
  });

  it("hands the motion to the words the reader scrolls to", () => {
    const container = mount(renderWordEffects("bebou ".repeat(MAX_MOVING_WORDS + 2), 0));
    const all = words(container);
    const first = all.slice(0, MAX_MOVING_WORDS);
    expect(first.every((word) => word.dataset.motion === "on")).toBe(true);
    scrollOffScreen(first);
    expect(first.some((word) => word.dataset.motion === "on")).toBe(false);
    // The two that were left over now hold slots, and the budget still holds.
    expect(movingWords(container)).toBe(2);
  });

  it("renders still on the server, so hydration has nothing to reconcile", () => {
    const html = renderToStaticMarkup(<EffectWord word="bébou" effect="sparkle" />);
    expect(html).toContain("sparkle-word");
    expect(html).not.toContain("data-motion");
  });
});
