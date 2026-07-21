// Compiled-binary only: embeds the built web UI bundle inside the standalone
// `teams` executable. `bun build --compile` sees this static `type: "file"`
// import and bakes the bytes into the executable's virtual filesystem (bunfs);
// at runtime `webEmbedPath` is a `/$bunfs/root/...` path we can read.
//
// The file `web.tar.gz` is produced by ui/build.ts (a gzipped tar of
// web/server.ts + web/dist) right before the compile, and is gitignored. It does
// NOT need to exist for `bun run` (dev): this module is only imported when
// running as a compiled binary (see web-embed.ts), so the dev entrypoint never
// touches it.
import webEmbedPath from "../web.tar.gz" with { type: "file" };

export default webEmbedPath;
