//! The models a picker may offer for each agent CLI, and what a person needs in order
//! to choose one.
//!
//! Settings › AI providers draws a select rather than a bare text field, and a select
//! is only as good as the list behind it. Three facts shape this module:
//!
//! - **A model is still free-form.** The list is what a picker offers, never what the
//!   RPC accepts: [`agent_policy::is_valid_model`] is the limit, and a model this
//!   machine knows nothing about is typed in and saved exactly as before.
//! - **opencode's list belongs to the machine, not to this crate.** An opencode model
//!   is `provider/model` for whichever providers the user authenticated, so a
//!   hard-coded catalogue would be wrong on the next machine. opencode already keeps
//!   the answer on disk — the models.dev catalogue it caches, plus its own auth and
//!   config files — so that is what is read. Nothing is spawned and nothing is
//!   fetched: a settings pane must not wait three seconds on a CLI, and this app makes
//!   no network request to draw itself.
//! - **A CLI this machine does not hold offers nothing.** The pane hides the select
//!   for a missing provider, so a list is only ever read for one it has.
//!
//! What the reader gets out of it is the model's own name ("Claude Opus 5", not
//! `amazon-bedrock/eu.anthropic.claude-opus-5`), who made it, and how much it can
//! hold.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

use serde::Serialize;

use crate::agent_policy::{self, Backend, Catalogue, Model};

/// One entry in the picker, as `agent_status` publishes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Choice {
    /// What the CLI is given for its model argument.
    pub id: String,
    /// The name a person reads.
    pub label: String,
    /// Who made it, as an id — the mark a client draws beside the name.
    pub vendor: String,
    /// How that vendor is named to the user.
    pub vendor_label: String,
    /// The context window in tokens, when the catalogue states one.
    pub context: Option<u32>,
    /// The most tokens one answer may hold, when the catalogue states one.
    pub output: Option<u32>,
}

impl Choice {
    fn from_static(model: &Model) -> Self {
        Self {
            id: model.id.to_string(),
            label: model.label.to_string(),
            vendor: model.vendor.to_string(),
            vendor_label: model.vendor_label.to_string(),
            context: Some(model.context),
            output: Some(model.output),
        }
    }
}

/// The most entries one backend offers.
///
/// A bound on the message, not a curation: `agent_status` travels on every socket that
/// connects, and a machine that authenticated a dozen providers holds thousands of
/// models. The list is sorted before it is cut, so the same machine always loses the
/// same tail rather than a different one per read.
const MAX_CHOICES: usize = 1_000;

/// Every model this machine can offer for one backend.
///
/// The static list first, in the order this crate wrote it, then whatever the
/// machine's own catalogue adds — sorted, because a catalogue's order is an
/// implementation detail of whoever wrote the file.
pub fn choices(backend: &Backend) -> Vec<Choice> {
    let mut out: Vec<Choice> = backend.models.iter().map(Choice::from_static).collect();
    match backend.catalogue {
        Catalogue::None => {}
        Catalogue::Opencode => out.extend(opencode_choices()),
    }
    out.truncate(MAX_CHOICES);
    out
}

// ---- opencode's own files ---------------------------------------------------------

/// The models.dev catalogue opencode caches: every provider and model it knows of.
fn opencode_catalogue_path() -> PathBuf {
    xdg_dir("XDG_CACHE_HOME", ".cache").join("opencode/models.json")
}

/// Which providers this machine authenticated, as opencode records it.
fn opencode_auth_path() -> PathBuf {
    xdg_dir("XDG_DATA_HOME", ".local/share").join("opencode/auth.json")
}

/// The user's own opencode config, which may configure a provider the auth file does
/// not name, and may add models the catalogue does not hold.
fn opencode_config_path() -> PathBuf {
    xdg_dir("XDG_CONFIG_HOME", ".config").join("opencode/opencode.json")
}

/// A base directory, per the XDG spec: the variable when it is absolute, else the
/// documented fallback under `$HOME`.
fn xdg_dir(variable: &str, fallback: &str) -> PathBuf {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(fallback)))
        .unwrap_or_else(|| PathBuf::from("/nonexistent"))
}

/// How a file looked when it was last read: modification time and length.
///
/// Enough to notice `opencode auth login` or an `opencode upgrade`, and cheap enough
/// to ask on every status read. A file that is absent has no stamp, which is itself a
/// state worth noticing — it appears the moment the user authenticates.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// The parsed catalogue, kept for as long as opencode's files do not move.
///
/// The cache exists because the catalogue is several megabytes of JSON and
/// `agent_status` is answered on every connect. Re-reading it there would put a
/// multi-megabyte parse in front of the settings pane on every reconnect.
static CACHE: RwLock<Option<([Stamp; 3], Vec<Choice>)>> = RwLock::new(None);

fn opencode_choices() -> Vec<Choice> {
    let paths = [opencode_catalogue_path(), opencode_auth_path(), opencode_config_path()];
    let stamps = [stamp(&paths[0]), stamp(&paths[1]), stamp(&paths[2])];

    if let Ok(cache) = CACHE.read() {
        if let Some((cached_stamps, choices)) = cache.as_ref() {
            if *cached_stamps == stamps {
                return choices.clone();
            }
        }
    }

    let read = |path: &Path| std::fs::read_to_string(path).ok();
    let choices = build(
        read(&paths[0]).as_deref(),
        read(&paths[1]).as_deref(),
        read(&paths[2]).as_deref(),
    );
    if let Ok(mut cache) = CACHE.write() {
        *cache = Some((stamps, choices.clone()));
    }
    choices
}

/// One provider, as the two files together describe it.
#[derive(Default)]
struct Provider {
    /// How the provider is named to the user, when either file says.
    label: Option<String>,
    /// Its models, by id. A `BTreeMap` so the result is the same on every read.
    models: BTreeMap<String, ModelEntry>,
}

#[derive(Default)]
struct ModelEntry {
    label: Option<String>,
    context: Option<u32>,
    output: Option<u32>,
}

/// Turn opencode's files into the picker's list.
///
/// Separate from the reading above so it can be tested against small fixtures rather
/// than against whatever the developer's own machine happens to hold.
///
/// The rules, in order:
///
/// - **A provider counts when the machine configured it.** `auth.json` names the ones
///   it authenticated and the config names the ones it declared by hand (a provider
///   whose credentials come from the environment appears there and nowhere else).
///   Everything else in the catalogue is a model this machine cannot run, which is
///   exactly what makes a hard-coded catalogue wrong.
/// - **The config wins over the catalogue**, model by model and field by field, because
///   it is the file the user wrote.
/// - **A model with no catalogue entry is still offered**, under its own id. Not
///   knowing a model's name is no reason to hide a model the CLI would accept.
/// - **A model the RPC would refuse is dropped.** These are files this crate does not
///   write, and a picker that offers what `agent_set_provider` rejects is a dead
///   control that reads as a bug in the app.
fn build(catalogue: Option<&str>, auth: Option<&str>, config: Option<&str>) -> Vec<Choice> {
    let catalogue: serde_json::Value =
        catalogue.and_then(|text| serde_json::from_str(text).ok()).unwrap_or(serde_json::Value::Null);
    let auth: serde_json::Value =
        auth.and_then(|text| serde_json::from_str(text).ok()).unwrap_or(serde_json::Value::Null);
    let config: serde_json::Value =
        config.and_then(|text| serde_json::from_str(text).ok()).unwrap_or(serde_json::Value::Null);

    let mut providers: BTreeMap<String, Provider> = BTreeMap::new();
    for id in configured_providers(&auth, &config) {
        providers.entry(id).or_default();
    }

    // The catalogue fills in every configured provider it knows.
    if let Some(entries) = catalogue.as_object() {
        for (id, provider) in providers.iter_mut() {
            let Some(entry) = entries.get(id) else { continue };
            provider.label = string_field(entry, "name");
            if let Some(models) = entry.get("models").and_then(|m| m.as_object()) {
                for (model_id, model) in models {
                    provider.models.insert(model_id.clone(), model_entry(model));
                }
            }
        }
    }

    // The user's own config adds and overrides, field by field.
    if let Some(entries) = config.get("provider").and_then(|p| p.as_object()) {
        for (id, entry) in entries {
            let Some(provider) = providers.get_mut(id) else { continue };
            if let Some(label) = string_field(entry, "name") {
                provider.label = Some(label);
            }
            if let Some(models) = entry.get("models").and_then(|m| m.as_object()) {
                for (model_id, model) in models {
                    let declared = model_entry(model);
                    let existing = provider.models.entry(model_id.clone()).or_default();
                    existing.label = declared.label.or(existing.label.take());
                    existing.context = declared.context.or(existing.context);
                    existing.output = declared.output.or(existing.output);
                }
            }
        }
    }

    let mut choices: Vec<Choice> = providers
        .into_iter()
        .flat_map(|(provider_id, provider)| {
            let vendor_label = provider.label.clone().unwrap_or_else(|| provider_id.clone());
            provider.models.into_iter().map({
                let provider_id = provider_id.clone();
                move |(model_id, model)| Choice {
                    id: format!("{provider_id}/{model_id}"),
                    label: model.label.unwrap_or_else(|| model_id.clone()),
                    vendor: provider_id.clone(),
                    vendor_label: vendor_label.clone(),
                    context: model.context,
                    output: model.output,
                }
            })
        })
        .collect();
    choices.retain(|choice| agent_policy::is_valid_model(&choice.id));
    // By vendor first, so a select can group; then by the name the reader sees, with
    // the id breaking a tie between two models that share a name.
    choices.sort_by(|a, b| {
        (&a.vendor_label, &a.label, &a.id).cmp(&(&b.vendor_label, &b.label, &b.id))
    });
    choices
}

/// The providers this machine configured: the ones it authenticated, plus the ones the
/// user declared by hand.
fn configured_providers(auth: &serde_json::Value, config: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = auth.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    if let Some(declared) = config.get("provider").and_then(|p| p.as_object()) {
        ids.extend(declared.keys().cloned());
    }
    ids.sort();
    ids.dedup();
    ids
}

fn model_entry(model: &serde_json::Value) -> ModelEntry {
    let limit = model.get("limit");
    ModelEntry {
        label: string_field(model, "name"),
        context: limit.and_then(|l| token_field(l, "context")),
        output: limit.and_then(|l| token_field(l, "output")),
    }
}

fn string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    let text = value.get(field)?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn token_field(value: &serde_json::Value, field: &str) -> Option<u32> {
    let count = value.get(field)?.as_u64()?;
    (count > 0).then(|| count.min(u32::MAX as u64) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOGUE: &str = r#"{
      "anthropic": {
        "name": "Anthropic",
        "models": {
          "claude-opus-5": { "name": "Claude Opus 5", "limit": { "context": 1000000, "output": 128000 } },
          "claude-haiku-4-5": { "name": "Claude Haiku 4.5", "limit": { "context": 200000, "output": 64000 } }
        }
      },
      "openai": {
        "name": "OpenAI",
        "models": { "gpt-5": { "name": "GPT-5", "limit": { "context": 400000, "output": 128000 } } }
      }
    }"#;

    #[test]
    fn only_the_providers_this_machine_authenticated_are_offered() {
        let auth = r#"{ "anthropic": { "type": "api", "key": "sk-x" } }"#;
        let choices = build(Some(CATALOGUE), Some(auth), None);
        let ids: Vec<&str> = choices.iter().map(|c| c.id.as_str()).collect();
        // OpenAI is in the catalogue and unauthenticated, so running it would fail.
        assert_eq!(ids, ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-5"]);
        let opus = choices.iter().find(|c| c.id.ends_with("claude-opus-5")).unwrap();
        assert_eq!(opus.label, "Claude Opus 5");
        assert_eq!(opus.vendor, "anthropic");
        assert_eq!(opus.vendor_label, "Anthropic");
        assert_eq!(opus.context, Some(1_000_000));
        assert_eq!(opus.output, Some(128_000));
    }

    #[test]
    fn a_provider_the_config_declares_counts_even_with_no_auth_entry() {
        // Credentials from the environment leave `auth.json` empty, and the provider
        // still runs — hiding its models would be wrong.
        let config = r#"{ "provider": { "openai": {} } }"#;
        let choices = build(Some(CATALOGUE), Some("{}"), Some(config));
        assert_eq!(choices.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["openai/gpt-5"]);
    }

    #[test]
    fn the_users_own_config_adds_a_model_and_overrides_a_catalogue_one() {
        let auth = r#"{ "anthropic": {} }"#;
        let config = r#"{
          "provider": {
            "anthropic": {
              "name": "Anthropic (work)",
              "models": {
                "claude-opus-5": { "limit": { "context": 500000 } },
                "internal-preview": { "name": "Internal preview" }
              }
            }
          }
        }"#;
        let choices = build(Some(CATALOGUE), Some(auth), Some(config));
        let opus = choices.iter().find(|c| c.id == "anthropic/claude-opus-5").unwrap();
        // The context comes from the config, the name from the catalogue: an override
        // is per field, because a config states only what the user wanted to change.
        assert_eq!(opus.context, Some(500_000));
        assert_eq!(opus.label, "Claude Opus 5");
        assert_eq!(opus.vendor_label, "Anthropic (work)");
        let preview = choices.iter().find(|c| c.id == "anthropic/internal-preview").unwrap();
        assert_eq!(preview.label, "Internal preview");
        assert_eq!(preview.context, None);
    }

    #[test]
    fn a_model_the_catalogue_does_not_name_keeps_its_own_id() {
        let auth = r#"{ "acme": {} }"#;
        let choices = build(Some(CATALOGUE), Some(auth), Some(r#"{"provider":{"acme":{"models":{"m-1":{}}}}}"#));
        let model = choices.iter().find(|c| c.id == "acme/m-1").unwrap();
        assert_eq!(model.label, "m-1");
        assert_eq!(model.vendor_label, "acme");
    }

    #[test]
    fn missing_or_broken_files_offer_nothing_rather_than_failing() {
        assert!(build(None, None, None).is_empty());
        assert!(build(Some("not json"), Some("not json"), Some("not json")).is_empty());
        // A catalogue with nothing authenticated is the state of a fresh install.
        assert!(build(Some(CATALOGUE), None, None).is_empty());
    }

    #[test]
    fn the_static_list_is_offered_with_its_own_names() {
        let claude = agent_policy::backend_named("claude").unwrap();
        let choices = choices(claude);
        assert_eq!(
            choices.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["fable", "opus", "sonnet", "haiku"],
        );
        for choice in &choices {
            assert!(!choice.label.is_empty(), "{choice:?}");
            assert_eq!(choice.vendor, "anthropic", "{choice:?}");
            assert!(choice.context.is_some_and(|c| c > 0), "{choice:?}");
        }
    }

    #[test]
    fn every_offered_model_is_one_the_rpc_would_accept() {
        // A picker that offers what `agent_set_provider` refuses is a dead control,
        // and a catalogue is a file this crate does not write.
        let auth = r#"{ "acme": {} }"#;
        let config = r#"{ "provider": { "acme": { "models": {
          "ok-1": {}, "with space": {}, "a.b:c_d-e": {}, "quote\"d": {}
        } } } }"#;
        let ids: Vec<String> = build(None, Some(auth), Some(config)).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["acme/a.b:c_d-e", "acme/ok-1"]);

        // And the list this crate writes itself must pass the same door.
        for backend in agent_policy::BACKENDS {
            for choice in choices(&backend) {
                assert!(agent_policy::is_valid_model(&choice.id), "{choice:?}");
            }
        }
    }
}
