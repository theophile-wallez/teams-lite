import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Store, useStore } from "@tanstack/react-store";
import { TeamsController, type AppState } from "~/lib/store";
import { defaultWsUrl } from "~/lib/ws-client";

const ControllerContext = createContext<TeamsController | null>(null);

/**
 * Provides a single TeamsController for the client session. The controller is
 * created lazily (client-only — it owns the WebSocket) and started once mounted.
 */
export function ControllerProvider(props: { children: ReactNode; url?: string }) {
  const [controller] = useState(() => new TeamsController(props.url ?? defaultWsUrl()));

  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);

  return (
    <ControllerContext.Provider value={controller}>{props.children}</ControllerContext.Provider>
  );
}

export function useController(): TeamsController {
  const ctrl = useContext(ControllerContext);
  if (!ctrl) throw new Error("useController must be used within <ControllerProvider>");
  return ctrl;
}

/** Subscribe to a fine-grained slice of app state (selector-based, memoized). */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const ctrl = useController();
  return useStore(ctrl.store, selector);
}

/**
 * The controller when there IS one, and null outside a provider — see
 * {@link useOptionalAppState} for the one kind of caller this exists for.
 */
export function useOptionalController(): TeamsController | null {
  return useContext(ControllerContext);
}

/**
 * A slice of app state when there IS a controller, and `fallback` outside a provider — for a
 * component that draws better with the app's state and correctly without it.
 *
 * There is exactly one kind of caller, and it is not a convenience: a custom agent's LABEL
 * and FACE are looked up in the local record (see components/agent-persona-mark.tsx), and a
 * message body is rendered in places that have no store — `RichContent` is pure given its
 * props, which is what lets the renderer be server-rendered to a string and tested without a
 * DOM. With no record the answer is already defined: the address, and the provider's own
 * mark. That is the same answer a persona the user DELETED gets, so this hook adds no new
 * state to reason about.
 *
 * Never reach for this to avoid wiring a provider. {@link useController} throws on purpose —
 * a component that needs the socket and silently does nothing without it is a bug that hides.
 */
export function useOptionalAppState<T>(selector: (state: AppState) => T, fallback: T): T {
  const ctrl = useContext(ControllerContext);
  // The subscription has to be unconditional (hooks cannot be skipped), so a store-less
  // caller subscribes to a store that never changes.
  const store = ctrl?.store ?? EMPTY_STORE;
  const value = useStore(store, (state) => (ctrl ? selector(state as AppState) : fallback));
  return value as T;
}

/** A store for {@link useOptionalAppState} to subscribe to when there is no controller.
 *  Never written, so nothing ever re-renders from it. */
const EMPTY_STORE = new Store<AppState>({} as AppState);
