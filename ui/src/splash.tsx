// Loading splash: a grey ASCII "teams" logo, centered, shown while the backend
// (auth broker + first sync) comes up.

import { createSignal, onMount } from "solid-js";

export function Splash(props: { message?: string }) {
  // a tiny animated ellipsis so it does not look frozen during the broker handshake
  const [dots, setDots] = createSignal("");
  onMount(() => {
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 400);
    return () => clearInterval(t);
  });

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
      <ascii_font text="teams" font="block" color="#808080" />
      <box style={{ height: 1 }} />
      <text content="lite — a fast Teams client" style={{ fg: "#5b5b5b" }} />
      <box style={{ height: 1 }} />
      <text content={`${props.message ?? "connecting to backend"}${dots()}`} style={{ fg: "#5b5b5b" }} />
    </box>
  );
}
