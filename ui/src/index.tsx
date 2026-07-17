// teams-lite — entry point. Mount the UI immediately (so the splash shows at
// once), then let the App bring up the backend and connect.
import { render } from "@opentui/solid";
import { App } from "./app";

await render(() => <App />);
