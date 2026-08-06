// What the compiled `teams` binary unpacks into ~/.cache/teams-lite, and how it knows
// whether what is already there is the SAME thing it carries.
//
// The binary embeds two assets that have to reach the filesystem before they can run: the
// Rust backend (see backend.ts) and the web bundle (see web-bundle.ts). Each is extracted
// once and reused, so every launch asks one question — "is the cached copy the asset this
// binary holds?" — and that question used to be answered by the byte COUNT.
//
// IT IS THE WRONG QUESTION, and an in-app update is where it showed. A Rust release
// binary's size is decided by section alignment, so consecutive builds land on the very
// same count: three of them did (17 432 216 bytes each), so the launcher kept the backend
// it had extracted two commits earlier while the launcher and the web bundle beside it
// were new. Nothing looked broken — every read answered — but the backend is the process
// that compares its own build with the release, so the app offered the SAME update for
// ever: download, apply, restart, "Update available", again.
//
// So an asset is identified by its CONTENT (`assetId`), and that id is stamped beside the
// extracted copy. Every failure to read the stamp — no file, an id another version of this
// file wrote, a truncated write — falls towards extraction, because extracting again costs
// a few milliseconds and running the wrong build costs the user their update.

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/// The identity of an embedded asset: its length AND a hash of its bytes.
///
/// The hash is Bun's own (wyhash, 64-bit): the bytes come out of this executable rather
/// than off a network, so nothing here defends against a chosen collision — the only job
/// is telling two builds apart, and it is done on content the caller already holds in
/// memory. The length rides along because it is free and it makes the id readable.
///
/// The spelling is ours and only ours: an id this function no longer produces simply
/// misses, and a miss re-extracts.
export function assetId(bytes: Uint8Array): string {
  return `${bytes.byteLength}-${Bun.hash(bytes).toString(16)}`;
}

/// Does the stamp beside an extracted asset name the id we are holding?
///
/// False on any failure at all, which is the safe direction: the caller then extracts.
export function cachedAssetIsCurrent(stampPath: string, id: string): boolean {
  try {
    return readFileSync(stampPath, "utf8").trim() === id;
  } catch {
    return false;
  }
}

/// Record which asset was extracted. Written AFTER the extraction succeeded, so a crash
/// in between leaves a stamp that misses rather than one that lies.
export function stampCachedAsset(stampPath: string, id: string): void {
  writeFileSync(stampPath, id);
}

/// Remove a stamp an older launcher wrote under another name. Missing is the normal case.
export function forgetCachedAsset(stampPath: string): void {
  try {
    unlinkSync(stampPath);
  } catch {}
}

/// Put `bytes` at `dest` through a temporary file and a RENAME, never by writing into the
/// file that is already there.
///
/// The extracted backend is an executable, and this machine may be running it: the released
/// build's unit and a `teams` command the user typed share one cache path. Rewriting the
/// bytes of a running executable is how a process earns a `SIGBUS`, so the new build goes
/// to a name of its own and is moved into place — the running process keeps the inode it
/// started from, and the next start gets the new one. It is the rule the backend's own
/// installer follows for exactly the same reason (`update::install_binary`).
///
/// The temporary name carries our pid, because two launches may start at the same moment.
export function replaceFile(dest: string, bytes: Uint8Array, mode: number): void {
  const temp = `${dest}.${process.pid}.new`;
  try {
    writeFileSync(temp, bytes);
    chmodSync(temp, mode);
    renameSync(temp, dest);
  } catch (err) {
    forgetCachedAsset(temp);
    throw err;
  }
}
