// teams-lite — entry point of the `teams` command.
//
// One command starts everything (the opencode model): it spawns or attaches to the
// Rust backend, serves the web app locally, and opens it in the browser.
import { launch, parseArgs, USAGE } from "./launch";

// An argv this command cannot honour ends here, with the reason and the usage — never in a
// launch that ignored it (see `parseArgs`). Exit 2 is what a caller reads as "you asked for
// something I do not have", which is the whole point: a script that meant another `teams`
// gets an answer instead of a server it did not ask for.
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`teams: ${e instanceof Error ? e.message : String(e)}\n`);
  console.error(USAGE);
  process.exit(2);
}

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

await launch(options);
