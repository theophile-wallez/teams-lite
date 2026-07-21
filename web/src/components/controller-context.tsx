import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "@tanstack/react-store";
import { TeamsController, type AppState } from "~/lib/store";
import { DEFAULT_WS_URL } from "~/lib/ws-client";

const ControllerContext = createContext<TeamsController | null>(null);

/**
 * Provides a single TeamsController for the client session. The controller is
 * created lazily (client-only — it owns the WebSocket) and started once mounted.
 */
export function ControllerProvider(props: { children: ReactNode; url?: string }) {
  const [controller] = useState(() => new TeamsController(props.url ?? DEFAULT_WS_URL));

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
