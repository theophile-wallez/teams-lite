// Embed the git commit this binary was built from, so the running app can tell
// whether a newer rolling `latest` release exists (see src/update.rs).
//
// teams-lite ships as a rolling `latest` GitHub release: there is no semantic
// version, so a build's identity IS the commit it came from. CI passes
// `TEAMS_BUILD_REV=${{ github.sha }}` when building the release binary; local
// dev builds leave it unset, which we surface as an empty value so the update
// check skips itself (developers running from source are never nagged).
fn main() {
    let rev = std::env::var("TEAMS_BUILD_REV").unwrap_or_default();
    println!("cargo:rustc-env=TEAMS_BUILD_REV={rev}");
    // Recompile when the value changes, so the embedded commit can never go
    // stale: without this, cargo would happily reuse a cached build carrying an
    // older SHA when only the env var changed.
    println!("cargo:rerun-if-env-changed=TEAMS_BUILD_REV");
}
