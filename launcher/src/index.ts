// teams-lite — entry point of the `teams` command.
//
// One command starts everything (the opencode model): it spawns or attaches to the
// Rust backend, serves the web app locally, and opens it in the browser.
import { launch, parseArgs, USAGE } from "./launch";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

await launch(options);
