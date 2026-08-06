// teams-lite — entry point of the `teams` command.
//
// One command starts everything (the opencode model): it spawns or attaches to the
// Rust backend, serves the web app locally, and opens it in the browser.
//
// What it DECIDES lives in `main` (launch.ts): refuse an argv this command cannot honour,
// answer `--help`, and only then serve. That order is the behaviour, so it belongs where a
// test can drive it rather than in a file whose shape a test would have to read.
import { main } from "./launch";

await main(process.argv.slice(2));
