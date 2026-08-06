// Who a GitLab user IS in Teams.
//
// A merge request names its author, its reviewers and every commenter the way GITLAB knows
// them: a handle, and whatever display name that instance holds. Most of those people are
// the user's own colleagues, who are already in this app — with the face Teams holds for
// them, and with the name the user themselves gave them (see § Renaming a person in
// CLAUDE.md). So `clement.bosle` under tinted initials on the GitLab page, beside the same
// person's photo in every chat, is one colleague drawn as two.
//
// This module answers one question — "which Teams person is this GitLab user?" — and the
// page then draws that person the way the rest of the app does. It is READ-ONLY in the
// strongest sense: it holds no store and no network, and the identity it hands back is a
// pair the caller resolved out of the local store.
//
// **The match is by REAL NAME, and it is measured** (`examples/gitlab_teams_people_recon.rs`,
// read-only, over the merge requests the token can see). Measured 2026-08-06 on
// `git.sia.partners`, against a store of 12 603 messages naming 294 people under 296 names:
// of the 26 people named on 200 merge requests, **18 resolve, 0 are ambiguous, 8 do not** —
// and all 8 of those are a GitLab import's "Placeholder <name>" account, which is not the
// person's own. So the rule is worth having, and it is not too loose.
//
// What the same run says about the KEY is the part worth reading before changing it:
//
//   - **All 18 resolve byte for byte.** This instance's accounts are provisioned from the
//     same directory Teams is, so it already spells a name as Teams does — capitalised
//     surname, accents and all.
//   - **Case is folded anyway, and whitespace collapsed.** Neither is measured, and both
//     stay: the GitLab HOST is configurable and an account made by hand carries a name
//     somebody typed, one name in this store really does hold a double space, and the
//     failure a widening would cause cannot happen here — two colleagues whose names differ
//     only in case are caught by the ambiguity rail below and resolve to neither.
//   - **ACCENTS are NOT folded.** That is where the line is drawn, and it is drawn by the
//     measurement: it changes nothing (18 either way), and dropping a mark is where two
//     names that are genuinely different start to collide. Run the recon again rather than
//     widening on a hunch.
//
// Four rails hold the resolution itself, and each is pinned by a test below:
//
//   - **An AMBIGUOUS name names nobody.** Two colleagues called "Alex Martin" and a GitLab
//     "Alex Martin" resolve to neither, exactly as an agent's `@mention` refuses an
//     ambiguous name: notifying — or here, portraying — the wrong colleague is worse than
//     doing neither.
//   - **Only a PERSON is ever matched.** A roster entry whose MRI is not `8:…` is dropped,
//     so a Teams app or bot ("Workflows", `28:…`) can never lend its face to a GitLab
//     account, and a `review-bot` on a merge request stays what GitLab called it.
//   - **The identity is only ever ADDED to what GitLab said.** GitLab's own `name` and
//     `username` travel untouched beside it, so the page can always say who this is on the
//     instance — and a person the store cannot name is not diminished by a missing field.
//   - **A stale identity is REPLACED, never kept.** [`annotate`] removes the field when a
//     name no longer resolves, so a payload that carried one from an earlier pass (a
//     response cache, a re-annotation) can never show a colleague who has since been
//     renamed under the old name.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

/// The Teams person one GitLab user IS, as it travels to the page.
///
/// `name` is what this app calls them — the user's own nickname when they set one, else the
/// name Teams holds — so the two halves of § Renaming a person are already applied by the
/// time the page reads it. `mri` is what a face is addressed by (`fetch_avatar`), which is
/// the same path every other avatar in this app takes, so a custom picture wins there too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamsPerson {
    pub mri: String,
    pub name: String,
}

/// The comparison key for a display name: what two systems have to agree on for their
/// people to be one person. Empty when the name spells nobody, and an empty key never
/// matches (see [`Roster::mri_for`]).
pub fn name_key(name: &str) -> String {
    let mut key = String::with_capacity(name.len());
    for word in name.split_whitespace() {
        if !key.is_empty() {
            key.push(' ');
        }
        key.extend(word.chars().flat_map(char::to_lowercase));
    }
    key
}

/// What one folded name resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Named {
    /// Exactly one person carries this name.
    One(String),
    /// More than one does, so it names nobody.
    Ambiguous,
}

/// Every Teams person a GitLab name can resolve to, folded once.
///
/// Built from the pairs the store already holds — see `Store::named_people`, which is
/// everybody Teams has named to this machine. A person may appear under more than one name
/// (Teams renamed them, or they married): each one resolves, because an old name on a
/// GitLab account is still that person.
#[derive(Debug, Clone, Default)]
pub struct Roster {
    by_name: BTreeMap<String, Named>,
}

impl Roster {
    /// Fold `(mri, name)` pairs into a roster. Anything that cannot be a person is dropped
    /// here rather than at the call site: an empty half, and an MRI that is not `8:…` —
    /// which is what tells a colleague from a Teams app (`28:…`) or a thread (`19:…`).
    pub fn from_people(people: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut by_name: BTreeMap<String, Named> = BTreeMap::new();
        for (mri, name) in people {
            if !mri.starts_with("8:") {
                continue;
            }
            let key = name_key(&name);
            if key.is_empty() {
                continue;
            }
            match by_name.get(&key) {
                // The same person under the same name twice is one person, not a clash.
                Some(Named::One(known)) if *known == mri => {}
                Some(Named::One(_)) => {
                    by_name.insert(key, Named::Ambiguous);
                }
                Some(Named::Ambiguous) => {}
                None => {
                    by_name.insert(key, Named::One(mri));
                }
            }
        }
        Self { by_name }
    }

    /// The one Teams person that GitLab name belongs to, or `None` when the store knows
    /// nobody by it — or knows two.
    pub fn mri_for(&self, name: &str) -> Option<&str> {
        let key = name_key(name);
        if key.is_empty() {
            return None;
        }
        match self.by_name.get(&key)? {
            Named::One(mri) => Some(mri.as_str()),
            Named::Ambiguous => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    /// How many names resolve. For the recon example, which reports what it measured.
    pub fn len(&self) -> usize {
        self.by_name.len()
    }
}

/// Add the Teams identity to every person in one GitLab payload, in place.
///
/// It walks the whole answer rather than naming the fields that hold people (`author`,
/// `reviewers`, `assignees`, a note's own author, …). One rule covers all of them and
/// covers a field added later: a person is an object carrying both a `name` and a
/// `username`, which is exactly [`crate::gitlab_mr::Person`] and nothing else in these
/// payloads — a CI job has a `name` and no handle, a pipeline has neither.
///
/// `resolve` is handed GitLab's own display name and answers with the Teams person it is.
/// It is a closure because the answer needs the store — the roster to match on, and the
/// person's current display name — and this module holds neither.
pub fn annotate(value: &mut Value, resolve: &mut impl FnMut(&str) -> Option<TeamsPerson>) {
    match value {
        Value::Object(map) => {
            if let Some(name) = gitlab_person_name(map) {
                match resolve(&name) {
                    Some(person) => {
                        map.insert("teams".to_string(), json!(person));
                    }
                    // Removed rather than left alone: an identity that no longer resolves
                    // must not survive in a payload that once carried it.
                    None => {
                        map.remove("teams");
                    }
                }
            }
            for (_, child) in map.iter_mut() {
                annotate(child, resolve);
            }
        }
        Value::Array(items) => {
            for child in items {
                annotate(child, resolve);
            }
        }
        _ => {}
    }
}

/// The display name of a GitLab PERSON object, or `None` when this object is not one.
fn gitlab_person_name(map: &serde_json::Map<String, Value>) -> Option<String> {
    let name = map.get("name")?.as_str()?;
    // A handle is what makes it a person rather than anything else with a name.
    map.get("username")?.as_str()?;
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two names one tenant really writes for one person: Teams capitalises the
    /// surname and GitLab does not. Every match in the measured sample needs this.
    #[test]
    fn a_surname_in_capitals_is_the_same_person() {
        let roster = Roster::from_people([
            ("8:orgid:theo".to_string(), "Théophile WALLEZ".to_string()),
            ("8:orgid:clement".to_string(), "Clément BOSLE".to_string()),
        ]);
        assert_eq!(roster.mri_for("Théophile Wallez"), Some("8:orgid:theo"));
        assert_eq!(roster.mri_for("théophile wallez"), Some("8:orgid:theo"));
        assert_eq!(roster.mri_for("Clément BOSLE"), Some("8:orgid:clement"));
    }

    /// The shape this instance really answers with: the same spelling on both sides. It is
    /// what every measured match is, so it is the case that must never break.
    #[test]
    fn the_same_spelling_on_both_sides_is_one_person() {
        let roster =
            Roster::from_people([("8:orgid:theo".to_string(), "Théophile WALLEZ".to_string())]);
        assert_eq!(roster.mri_for("Théophile WALLEZ"), Some("8:orgid:theo"));
    }

    #[test]
    fn whitespace_is_collapsed_and_an_accent_is_not_folded() {
        let roster = Roster::from_people([
            ("8:orgid:subhash".to_string(), "Karna SUBHASH  KUMAR".to_string()),
            ("8:orgid:clement".to_string(), "Clément BOSLE".to_string()),
        ]);
        // A double space on one side only — the shape the tenant really holds.
        assert_eq!(roster.mri_for(" Karna Subhash Kumar "), Some("8:orgid:subhash"));
        // Accents are part of the name: dropping them would widen the match with nothing
        // measured behind it, and the wrong face is worse than none.
        assert_eq!(roster.mri_for("Clement Bosle"), None);
    }

    #[test]
    fn an_ambiguous_name_names_nobody() {
        let roster = Roster::from_people([
            ("8:orgid:one".to_string(), "Alex MARTIN".to_string()),
            ("8:orgid:two".to_string(), "Alex Martin".to_string()),
        ]);
        assert_eq!(roster.mri_for("Alex Martin"), None);
        // …and it stays ambiguous however many more arrive.
        let roster = Roster::from_people([
            ("8:orgid:one".to_string(), "Alex MARTIN".to_string()),
            ("8:orgid:two".to_string(), "Alex Martin".to_string()),
            ("8:orgid:three".to_string(), "alex martin".to_string()),
        ]);
        assert_eq!(roster.mri_for("Alex Martin"), None);
    }

    #[test]
    fn one_person_under_two_names_is_not_a_clash() {
        let roster = Roster::from_people([
            ("8:orgid:ada".to_string(), "Ada BYRON".to_string()),
            ("8:orgid:ada".to_string(), "Ada LOVELACE".to_string()),
        ]);
        assert_eq!(roster.mri_for("Ada Byron"), Some("8:orgid:ada"));
        assert_eq!(roster.mri_for("Ada Lovelace"), Some("8:orgid:ada"));
    }

    /// A Teams app is not a person, so it can never lend its face to a GitLab account —
    /// even one called exactly the same thing.
    #[test]
    fn only_a_person_is_ever_matched() {
        let roster = Roster::from_people([
            ("28:358f0194-6b0e".to_string(), "Workflows".to_string()),
            ("19:thread@thread.v2".to_string(), "Platform Team".to_string()),
            (String::new(), "Nobody".to_string()),
            ("8:orgid:ada".to_string(), String::new()),
        ]);
        assert!(roster.is_empty());
        assert_eq!(roster.mri_for("Workflows"), None);
        assert_eq!(roster.mri_for(""), None);
    }

    /// The name GitLab redacts a bot to, and a name nobody carries: neither resolves, and
    /// neither is a special case in the code.
    #[test]
    fn a_name_the_store_does_not_hold_resolves_to_nobody() {
        let roster =
            Roster::from_people([("8:orgid:ada".to_string(), "Ada LOVELACE".to_string())]);
        assert_eq!(roster.mri_for("****"), None);
        assert_eq!(roster.mri_for("Placeholder Ada LOVELACE"), None);
        assert_eq!(roster.mri_for("review-bot"), None);
    }

    /// The whole point of the walk: one rule reaches the author of a list row, the people
    /// on a detail and the author of every comment, and nothing else.
    #[test]
    fn every_person_in_a_payload_is_named_and_nothing_else_is() {
        let mut payload = json!({
            "items": [{
                "iid": 42,
                "author": { "name": "Ada Lovelace", "username": "ada" },
            }],
            "assignees": [
                { "name": "Ada Lovelace", "username": "ada" },
                { "name": "Grace Hopper", "username": "grace" },
            ],
            "discussions": [{
                "notes": [{ "id": 1, "author": { "name": "Ada Lovelace", "username": "ada" } }],
            }],
            // A CI job has a name and no handle, so it is not a person.
            "jobs": [{ "id": 7, "name": "🧪 unit", "stage": "test" }],
            "pipeline": { "id": 9, "status": "running" },
        });

        annotate(&mut payload, &mut |name| {
            (name == "Ada Lovelace").then(|| TeamsPerson {
                mri: "8:orgid:ada".to_string(),
                // The name the USER gave her, which is what the page must draw.
                name: "Ada B.".to_string(),
            })
        });

        let ada = json!({ "mri": "8:orgid:ada", "name": "Ada B." });
        assert_eq!(payload["items"][0]["author"]["teams"], ada);
        assert_eq!(payload["assignees"][0]["teams"], ada);
        assert_eq!(payload["discussions"][0]["notes"][0]["author"]["teams"], ada);
        // GitLab's own words are untouched beside it.
        assert_eq!(payload["items"][0]["author"]["name"], json!("Ada Lovelace"));
        assert_eq!(payload["items"][0]["author"]["username"], json!("ada"));
        // Somebody the store cannot name keeps exactly what GitLab said.
        assert_eq!(payload["assignees"][1].get("teams"), None);
        // And nothing that is not a person is touched.
        assert_eq!(payload["jobs"][0].get("teams"), None);
        assert_eq!(payload["pipeline"].get("teams"), None);
    }

    /// A renamed colleague, and one who left the roster: neither may be shown under what a
    /// previous pass wrote.
    #[test]
    fn a_stale_identity_is_replaced_rather_than_kept() {
        let mut payload = json!({
            "author": {
                "name": "Ada Lovelace",
                "username": "ada",
                "teams": { "mri": "8:orgid:ada", "name": "the old name" },
            },
            "reviewers": [{
                "name": "Grace Hopper",
                "username": "grace",
                "teams": { "mri": "8:orgid:grace", "name": "somebody else" },
            }],
        });

        annotate(&mut payload, &mut |name| {
            (name == "Ada Lovelace").then(|| TeamsPerson {
                mri: "8:orgid:ada".to_string(),
                name: "the new name".to_string(),
            })
        });

        assert_eq!(payload["author"]["teams"]["name"], json!("the new name"));
        assert_eq!(payload["reviewers"][0].get("teams"), None);
    }
}
