// Compiled-binary only: embeds the Rust backend binary inside the standalone
// `teams` executable. `bun build --compile` sees this static `type: "file"`
// import and bakes the bytes into the executable's virtual filesystem (bunfs);
// at runtime `backendEmbedPath` is a `/$bunfs/root/...` path we can read.
//
// The file `server.embed` is produced by cli/build.ts (a copy of
// target/release/server) right before the compile, and is gitignored. It does
// NOT need to exist for `bun run` (dev): this module is only imported when
// running as a compiled binary (see backend.ts), so the dev entrypoint never
// touches it — which is also why the resolution error is silenced for a
// typecheck of the checkout.
// @ts-ignore: the artifact exists only while build.ts runs.
import backendEmbedPath from "../server.embed" with { type: "file" };

export default backendEmbedPath;
