// Manual live measurement of WHO a GitLab user is in Teams, READ-ONLY.
//
// The merge-request page draws a colleague as the colleague this app already knows: their
// Teams face, and the name the user gave them. The whole feature rests on matching two
// systems' record of one person by their REAL NAME (`gitlab_people`), and a rule like that is
// worth exactly what it measures — so this counts it against the user's own merge requests
// and the user's own store.
//
// It answers three questions, and each one decided a rule:
//
//   1. **How many resolve at all?** A rule that matched a handful would not be worth the
//      complexity; one that matched everybody would be too loose to trust.
//   2. **Does the key's FOLDING carry any of it?** A byte-for-byte comparison is counted
//      beside the real one, so the answer is a number rather than a belief. On this instance
//      it is none of it — the accounts come from the same directory Teams does — which is
//      exactly what `gitlab_people` says about its own rule.
//   3. **Does anything become AMBIGUOUS?** Two colleagues under one name resolve to neither,
//      and the count of those is what says whether the refusal is a real state.
//
// It also groups what does NOT resolve, because that is where a next rule would come from —
// a GitLab bot, a "Placeholder <name>" account left by an import, or a real colleague this
// machine has never been told about.
//
// READ-ONLY, twice over: the GitLab half is `gitlab_mr::fetch_list` (a GET), and the Teams
// half is the local store. Nothing is written, nothing is posted, and no name is printed —
// these are the user's colleagues, and this output ends up in a terminal or a transcript.
//
//   cargo run --example gitlab_teams_people_recon
//
// Measured 2026-08-06 on `git.sia.partners`, against a store of 12 603 messages naming 294
// people under 296 names: 26 people named on 200 merge requests, 18 resolved, 0 ambiguous,
// 8 not — and all 8 were an import's placeholder account. All 18 were spelled identically on
// both sides, which is what the module's own doc says and why accents are not folded.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState, Person};
use teams_lite::gitlab_people::{name_key, Roster};

/// How many open merge requests are read in FULL, to see the people reviewing them. Bounded
/// because each one is a request: enough for a count, and nowhere near the token's limit.
const DETAIL_SAMPLE: usize = 25;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;

    // The same store the backend reads, and the same two settings keys.
    let store = teams_lite::store::Store::open(&db_path()?)?;
    let host = store
        .get_setting("gitlab_host")?
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| teams_lite::gitlab::DEFAULT_HOST.to_string());
    let token = store.get_setting("gitlab_token")?.filter(|t| !t.is_empty());
    println!("== host {host} · token {}", if token.is_some() { "set" } else { "ABSENT" });
    anyhow::ensure!(token.is_some(), "no GitLab token stored — the page can read nothing");

    // The Teams half: everybody this machine has been told the name of.
    let people = store.named_people()?;
    let mris: BTreeSet<&str> = people.iter().map(|(mri, _)| mri.as_str()).collect();
    let roster = Roster::from_people(people.clone());
    println!(
        "== teams · {} people under {} names · {} names resolve to one person",
        mris.len(),
        people.len(),
        roster.len(),
    );
    // The comparison a byte-for-byte match would make, for question 2.
    let exact: BTreeSet<&str> = people.iter().map(|(_, name)| name.as_str()).collect();

    // The GitLab half: every person named on the merge requests the page shows. An AUTHOR is
    // on the row, so both lists are read whole; a reviewer and an assignee are only on a
    // DETAIL, so a bounded sample of those is read too — the sidebar's own rows are written
    // by a couple of dozen people, and the people REVIEWING them are a wider set than that.
    let mut named: BTreeMap<String, Person> = BTreeMap::new();
    let mut sample: Vec<(String, u64)> = Vec::new();
    for state in [ListState::Opened, ListState::Closed] {
        let query = ListQuery { scope: ListScope::All, state };
        let list = gitlab_mr::fetch_list(&http, &host, token.as_deref(), query).await?;
        println!("== list state={} · {} rows", state.as_str(), list.items.len());
        for row in list.items {
            if matches!(state, ListState::Opened) && sample.len() < DETAIL_SAMPLE {
                sample.push((row.project_path.clone(), row.iid));
            }
            named.insert(row.author.username.clone(), row.author);
        }
    }
    let authors = named.len();
    for (project_path, iid) in &sample {
        let detail =
            gitlab_mr::fetch_detail(&http, &host, token.as_deref(), project_path, *iid).await?;
        for person in detail.reviewers.into_iter().chain(detail.assignees) {
            named.insert(person.username.clone(), person);
        }
    }
    println!(
        "== gitlab · {} people named · {authors} as an author, the rest reviewing or assigned \
         on the newest {} open",
        named.len(),
        sample.len(),
    );

    let mut resolved = 0usize;
    let mut resolved_byte_for_byte = 0usize;
    let mut ambiguous = 0usize;
    let mut unresolved_bot = 0usize;
    let mut unresolved_placeholder = 0usize;
    let mut unresolved_person = 0usize;
    for person in named.values() {
        let key = name_key(&person.name);
        // The roster answers `None` for an ambiguous name as well as for an unknown one, so
        // the two are told apart here: `mri_for` refusing while some name folds the same way
        // IS the ambiguity.
        let known = roster.mri_for(&person.name).is_some();
        let folds_onto_somebody =
            !key.is_empty() && people.iter().any(|(_, name)| name_key(name) == key);
        if known {
            resolved += 1;
            if exact.contains(person.name.as_str()) {
                resolved_byte_for_byte += 1;
            }
        } else if folds_onto_somebody {
            ambiguous += 1;
        } else if person.name.trim().is_empty() || person.name.trim_matches('*').is_empty() {
            // GitLab redacts a bot's name to `****`.
            unresolved_bot += 1;
        } else if person.name.starts_with("Placeholder ") {
            // What a GitLab import leaves behind for somebody who never signed in.
            unresolved_placeholder += 1;
        } else {
            unresolved_person += 1;
        }
    }

    println!("== resolved            {resolved}");
    println!(
        "   of those, {resolved_byte_for_byte} spelled identically on both sides and {} needed \
         the key's own folding",
        resolved - resolved_byte_for_byte,
    );
    println!("== ambiguous, so named nobody {ambiguous}");
    println!("== not in this store   {}", unresolved_bot + unresolved_placeholder + unresolved_person);
    println!("   a bot GitLab redacts     {unresolved_bot}");
    println!("   an import placeholder    {unresolved_placeholder}");
    println!("   a name this store has never been told  {unresolved_person}");
    println!("== done · two reads, no write, no name printed");
    Ok(())
}

/// The store the backend keeps, resolved the way it resolves it.
fn db_path() -> Result<String> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    let path = format!("{base}/teams-lite/teams-lite.sqlite");
    anyhow::ensure!(
        std::path::Path::new(&path).exists(),
        "no store at {path} — run the app once so it has one"
    );
    Ok(path)
}
