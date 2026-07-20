// Loading splash: a grey ASCII "teams" logo, centered, shown while the backend
// (auth broker + first sync) comes up. A pulsing block bar sits under the logo
// so the screen reads as "working" during the broker handshake.

import { PulseBar } from "./spinner";
import { theme } from "./theme";

export function Splash(props: { message?: string }) {
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <ascii_font text="teams" font="block" color={theme().textMuted} />
      <box style={{ height: 1 }} />
      <text content="lite — a fast Teams client" style={{ fg: theme().textFaint }} />
      <box style={{ height: 1 }} />
      <PulseBar width={12} />
      <box style={{ height: 1 }} />
      <text content={props.message ?? "connecting to backend"} style={{ fg: theme().textFaint }} />
    </box>
  );
}
