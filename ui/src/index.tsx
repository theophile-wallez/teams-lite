// teams-lite — entry point.
//
// Two modes, one binary (opencode-style):
//   • default        → the terminal UI (OpenTUI + Solid)
//   • `teams --web`  → the browser UI (TanStack Start SSR), served locally
//
// In web mode we must NOT load OpenTUI: it grabs the terminal (raw mode, alt
// screen, mouse tracking) the moment its renderer loads. So the TUI module is
// imported lazily, only on the default path — and this file is kept free of JSX
// so parsing it never pulls in the Solid/OpenTUI runtime.
import { parseWebArgs, runWeb } from "./web";

const { web, options } = parseWebArgs(process.argv.slice(2));

if (web) {
  await runWeb(options);
} else {
  const { startTui } = await import("./app");
  await startTui();
}
