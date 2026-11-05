//! Signing an agent CLI in from Settings › AI providers — with no terminal anywhere.
//!
//! Three ways a CLI gets an account, and each is the CLI's OWN mechanism presented differently:
//!
//! - **A Claude account** is Claude Code's own `claude auth login`, run behind the scenes
//!   ([`ClaudeLogin`]). The CLI prints Anthropic's authorize link; the page opens it in the
//!   reader's own browser, where they sign in on claude.com; claude.com shows a code, the reader
//!   pastes it into the page, and the page hands it to the waiting CLI's stdin. The CLI exchanges
//!   it and keeps the login in its own home. Anthropic's terms are what shape this: an app "may not
//!   collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude
//!   account must complete through Anthropic's own flow", while nothing prevents "an end user from
//!   signing in to the unmodified Claude Code binary with their own Claude subscription". So the
//!   sign-in completes on claude.com, the binary is unmodified, and the one value that crosses this
//!   app — the code — is worthless on its own: the flow is PKCE (`code_challenge_method=S256`,
//!   measured), so only the CLI process that holds the verifier can redeem it. It is never stored
//!   and never logged. `claude setup-token` is deliberately NOT used: it prints a long-lived token
//!   into its output, which this app would then be holding.
//! - **An API key, or a cloud account** (Amazon Bedrock, Google Vertex AI, Microsoft Foundry) is
//!   the documented environment of each CLI, held in this app's store ([`Config`], write-only from
//!   the page like the GitLab token) and handed to the CLI children this app starts and to nothing
//!   else ([`child_env`]). It changes nothing in the user's own shell or their own CLI config.
//! - **An opencode provider key** is written into opencode's own `auth.json`, in exactly the
//!   shape its `/connect` writes (`{"<provider>": {"type": "api", "key": "…"}}`, mode 0600, read off
//!   opencode v1.19.5's `src/auth/index.ts`), so opencode treats it as one it stored itself.
//!
//! What a key handed to a child COSTS is stated rather than hidden: it is in that child's
//! environment, so a tool the agent runs can read it — exactly as it could read the CLI's own
//! credentials file in its home. The write token is still removed (`agent::run_once`).

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::agent_cli::Tool;

/// The store setting holding [`Config`], as one JSON document so an update is one write.
pub const SETTING: &str = "agent_auth";

/// Where this app keeps the files a credential has to be a FILE for (a Google service-account
/// key), under the data directory: `0700`, every file in it `0600`.
pub const CREDENTIALS_DIR: &str = "agent-credentials";

// ---- secrets --------------------------------------------------------------------------------------

/// A credential: serialized as the plain string it is, and never printed by `Debug`, so a log line
/// or a failed assertion cannot carry one.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

// ---- the configuration ----------------------------------------------------------------------------

/// How Claude Code signs in when this app starts it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeMethod {
    /// Whatever Claude Code itself is set up to use on this machine — its own login and the
    /// environment the backend inherited. Nothing is added or removed: the behaviour every install
    /// had before this existed, and so the default.
    #[default]
    Machine,
    /// Its own Claude account login (signed in from the page), with every other way in removed
    /// from its environment so that login is what answers.
    ClaudeAi,
    /// An Anthropic API key held by this app.
    ApiKey,
    /// The Amazon Bedrock account set up under Cloud accounts.
    Bedrock,
    /// The Google Vertex AI account set up under Cloud accounts.
    Vertex,
    /// The Microsoft Foundry account set up under Cloud accounts.
    Foundry,
}

impl ClaudeMethod {
    pub const ALL: [ClaudeMethod; 6] = [
        ClaudeMethod::Machine,
        ClaudeMethod::ClaudeAi,
        ClaudeMethod::ApiKey,
        ClaudeMethod::Bedrock,
        ClaudeMethod::Vertex,
        ClaudeMethod::Foundry,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ClaudeMethod::Machine => "machine",
            ClaudeMethod::ClaudeAi => "claude_ai",
            ClaudeMethod::ApiKey => "api_key",
            ClaudeMethod::Bedrock => "bedrock",
            ClaudeMethod::Vertex => "vertex",
            ClaudeMethod::Foundry => "foundry",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|method| method.as_str() == value)
    }
}

/// Everything this app holds about how its agent CLIs sign in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub claude_method: ClaudeMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_key: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bedrock: Option<Bedrock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertex: Option<Vertex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foundry: Option<Foundry>,
}

/// An Amazon Bedrock account: a region and one way of authenticating to AWS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bedrock {
    pub region: String,
    pub credentials: BedrockCredentials,
}

/// The three ways both CLIs authenticate to Bedrock that work with no AWS CLI on the machine
/// (an SSO profile needs `aws sso login`, which is the profile case on a workstation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BedrockCredentials {
    /// An Amazon Bedrock API key: a bearer token good for Bedrock alone (`AWS_BEARER_TOKEN_BEDROCK`).
    ApiKey { api_key: Secret },
    /// An access key, with a session token when it is temporary.
    AccessKey {
        access_key_id: String,
        secret_access_key: Secret,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_token: Option<Secret>,
    },
    /// A profile in the AWS files of the CLI's own home.
    Profile { profile: String },
}

impl BedrockCredentials {
    fn kind(&self) -> &'static str {
        match self {
            BedrockCredentials::ApiKey { .. } => "api_key",
            BedrockCredentials::AccessKey { .. } => "access_key",
            BedrockCredentials::Profile { .. } => "profile",
        }
    }
}

/// A Google Vertex AI account. With no service-account key, the CLIs use the Application Default
/// Credentials of their own home (`gcloud auth application-default login` on a workstation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vertex {
    pub project: String,
    pub region: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_account: Option<Secret>,
}

/// A Microsoft Foundry account: the resource NAME (Claude Code refuses a URL there) and its key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Foundry {
    pub resource: String,
    pub api_key: Secret,
}

impl Config {
    /// The stored configuration. A value this build cannot read is the default — the machine's own
    /// setup, which adds nothing — rather than a guess at what it meant.
    pub fn parse(stored: Option<&str>) -> Config {
        let Some(text) = stored.filter(|text| !text.trim().is_empty()) else {
            return Config::default();
        };
        match serde_json::from_str(text) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("[agent-auth] the stored sign-in settings could not be read ({e}); using none");
                Config::default()
            }
        }
    }

    pub fn to_stored(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Apply one change from the page.
    ///
    /// Every section is optional and independent: `null` removes it, an object replaces it, and a
    /// SECRET left out of an object keeps the one already stored — so a region can be changed
    /// without retyping a key the page was never shown. What the method needs must exist when the
    /// change is done, or nothing is changed.
    pub fn update(&self, patch: &Value) -> Result<Config> {
        ensure!(patch.is_object(), "a sign-in change must be an object");
        let mut next = self.clone();
        if let Some(value) = patch.get("anthropic_key") {
            next.anthropic_key = if value.is_null() {
                None
            } else {
                Some(secret(value, "The Anthropic API key")?)
            };
        }
        if let Some(value) = patch.get("bedrock") {
            next.bedrock = if value.is_null() {
                None
            } else {
                Some(bedrock_from(value, self.bedrock.as_ref())?)
            };
        }
        if let Some(value) = patch.get("vertex") {
            next.vertex = if value.is_null() {
                None
            } else {
                Some(vertex_from(value, self.vertex.as_ref())?)
            };
        }
        if let Some(value) = patch.get("foundry") {
            next.foundry = if value.is_null() {
                None
            } else {
                Some(foundry_from(value, self.foundry.as_ref())?)
            };
        }
        let chose = patch.get("claude_method");
        if let Some(value) = chose {
            let name = value.as_str().context("claude_method must be a string")?;
            next.claude_method =
                ClaudeMethod::parse(name).with_context(|| format!("no such way to sign in: {name}"))?;
        }
        if let Some(missing) = next.missing_for_method() {
            if chose.is_some() {
                bail!("{missing} first");
            }
            bail!(
                "Claude Code signs in with {} — choose another way for it before removing that",
                method_label(next.claude_method)
            );
        }
        Ok(next)
    }

    /// What the chosen method needs and this configuration lacks, as the sentence that asks for it.
    fn missing_for_method(&self) -> Option<&'static str> {
        match self.claude_method {
            ClaudeMethod::Machine | ClaudeMethod::ClaudeAi => None,
            ClaudeMethod::ApiKey => self.anthropic_key.is_none().then_some("Add an Anthropic API key"),
            ClaudeMethod::Bedrock => self.bedrock.is_none().then_some("Set up Amazon Bedrock"),
            ClaudeMethod::Vertex => self.vertex.is_none().then_some("Set up Google Vertex AI"),
            ClaudeMethod::Foundry => self.foundry.is_none().then_some("Set up Microsoft Foundry"),
        }
    }
}

fn method_label(method: ClaudeMethod) -> &'static str {
    match method {
        ClaudeMethod::Machine => "this machine's own setup",
        ClaudeMethod::ClaudeAi => "a Claude account",
        ClaudeMethod::ApiKey => "an Anthropic API key",
        ClaudeMethod::Bedrock => "Amazon Bedrock",
        ClaudeMethod::Vertex => "Google Vertex AI",
        ClaudeMethod::Foundry => "Microsoft Foundry",
    }
}

// ---- validation -----------------------------------------------------------------------------------

/// The longest credential accepted. Far above any real key, it catches a whole file pasted into a
/// key field.
const MAX_SECRET_CHARS: usize = 8 * 1024;

/// The most a service-account key file may weigh (a real one is about 2.3 KB).
const MAX_SERVICE_ACCOUNT_BYTES: usize = 64 * 1024;

/// A key is one token: printable ASCII with no space inside. Anything else is a paste that went
/// wrong — a key with its label, two keys, a line break — and would fail at the provider with a
/// sentence nobody can trace back to here.
fn secret(value: &Value, what: &str) -> Result<Secret> {
    let text = value.as_str().with_context(|| format!("{what} must be text"))?.trim();
    ensure!(!text.is_empty(), "{what} is empty");
    ensure!(text.chars().count() <= MAX_SECRET_CHARS, "{what} is far longer than any key");
    ensure!(
        text.chars().all(|c| c.is_ascii_graphic()),
        "{what} must be one line with no spaces — paste the key alone"
    );
    Ok(Secret::new(text))
}

fn text_field<'a>(value: &'a Value, field: &str, what: &str) -> Result<&'a str> {
    let text = value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    text.with_context(|| format!("{what} is missing"))
}

/// An AWS region as AWS spells one: `us-east-1`, `eu-central-2`, `us-gov-west-1`, `ap-southeast-4`.
pub fn is_aws_region(region: &str) -> bool {
    let parts: Vec<&str> = region.split('-').collect();
    if region.len() > 32 || parts.len() < 3 {
        return false;
    }
    let (first, rest) = parts.split_first().expect("three parts");
    let (last, middle) = rest.split_last().expect("two parts");
    (2..=3).contains(&first.len())
        && first.chars().all(|c| c.is_ascii_lowercase())
        && middle.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase()))
        && (1..=2).contains(&last.len())
        && last.chars().all(|c| c.is_ascii_digit())
}

fn is_access_key_id(id: &str) -> bool {
    (16..=128).contains(&id.len()) && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn is_profile_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.+@-".contains(c))
}

/// A Google Cloud project id: 6 to 30 characters, a lowercase letter first, no trailing hyphen.
pub fn is_gcp_project(project: &str) -> bool {
    (6..=30).contains(&project.len())
        && project.starts_with(|c: char| c.is_ascii_lowercase())
        && !project.ends_with('-')
        && project.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A Vertex location: `global`, a multi-region (`us`, `eu`), or a region (`us-east5`,
/// `europe-west1`, `northamerica-northeast1`).
pub fn is_vertex_region(region: &str) -> bool {
    if matches!(region, "global" | "us" | "eu") {
        return true;
    }
    let Some((area, place)) = region.split_once('-') else {
        return false;
    };
    let digits = place.chars().rev().take_while(char::is_ascii_digit).count();
    region.len() <= 32
        && !area.is_empty()
        && area.chars().all(|c| c.is_ascii_lowercase())
        && (1..=2).contains(&digits)
        && place.len() > digits
        && place[..place.len() - digits].chars().all(|c| c.is_ascii_lowercase())
}

/// A Foundry resource NAME — never a URL or a host, which Claude Code refuses when a message is sent.
pub fn is_foundry_resource(resource: &str) -> bool {
    (2..=64).contains(&resource.len())
        && resource.starts_with(|c: char| c.is_ascii_alphanumeric())
        && resource.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A Google service-account key file, checked for the three fields that make it one.
fn service_account(value: &Value) -> Result<Secret> {
    let text = value.as_str().context("The service-account key must be the file's text")?.trim();
    ensure!(!text.is_empty(), "The service-account key is empty");
    ensure!(text.len() <= MAX_SERVICE_ACCOUNT_BYTES, "That file is far larger than a service-account key");
    let parsed: Value =
        serde_json::from_str(text).context("That is not a service-account key file (it is not JSON)")?;
    ensure!(
        parsed.get("type").and_then(Value::as_str) == Some("service_account"),
        "That JSON is not a service-account key (its type is not service_account)"
    );
    ensure!(
        parsed.get("client_email").and_then(Value::as_str).is_some_and(|email| email.contains('@')),
        "That service-account key names no client_email"
    );
    ensure!(
        parsed.get("private_key").and_then(Value::as_str).is_some_and(|key| key.contains("PRIVATE KEY")),
        "That service-account key holds no private_key"
    );
    Ok(Secret::new(text))
}

fn service_account_email(key: &Secret) -> Option<String> {
    let parsed: Value = serde_json::from_str(key.expose()).ok()?;
    parsed.get("client_email")?.as_str().map(str::to_string)
}

fn bedrock_from(value: &Value, existing: Option<&Bedrock>) -> Result<Bedrock> {
    let region = text_field(value, "region", "The AWS region")?;
    ensure!(is_aws_region(region), "{region} is not an AWS region (like us-east-1 or eu-west-3)");
    let kind = text_field(value, "kind", "How to authenticate to AWS")?;
    let old = existing.map(|bedrock| &bedrock.credentials);
    let credentials = match kind {
        "api_key" => {
            let api_key = match value.get("api_key") {
                Some(given) => secret(given, "The Bedrock API key")?,
                None => match old {
                    Some(BedrockCredentials::ApiKey { api_key }) => api_key.clone(),
                    _ => bail!("The Bedrock API key is missing"),
                },
            };
            BedrockCredentials::ApiKey { api_key }
        }
        "access_key" => {
            // The ID left out keeps the stored one with its own secret — the page is never shown the
            // whole ID, so a region change must not need it retyped.
            let stored_id = match old {
                Some(BedrockCredentials::AccessKey { access_key_id, .. }) => Some(access_key_id.as_str()),
                _ => None,
            };
            let given_id = value.get("access_key_id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty());
            let access_key_id = given_id.or(stored_id).context("The access key ID is missing")?;
            ensure!(is_access_key_id(access_key_id), "{access_key_id} is not an AWS access key ID");
            // A stored secret belongs to the key id it was given with: keeping it under another id
            // would pair two halves of two different keys.
            let same_key = match old {
                Some(BedrockCredentials::AccessKey { access_key_id: id, .. }) => id == access_key_id,
                _ => false,
            };
            let kept = |pick: fn(&BedrockCredentials) -> Option<Secret>| old.filter(|_| same_key).and_then(pick);
            let secret_access_key = match value.get("secret_access_key") {
                Some(given) => secret(given, "The secret access key")?,
                None => kept(|c| match c {
                    BedrockCredentials::AccessKey { secret_access_key, .. } => Some(secret_access_key.clone()),
                    _ => None,
                })
                .context("The secret access key is missing")?,
            };
            let session_token = match value.get("session_token") {
                Some(Value::Null) => None,
                Some(given) => Some(secret(given, "The session token")?),
                None => kept(|c| match c {
                    BedrockCredentials::AccessKey { session_token, .. } => session_token.clone(),
                    _ => None,
                }),
            };
            BedrockCredentials::AccessKey {
                access_key_id: access_key_id.to_string(),
                secret_access_key,
                session_token,
            }
        }
        "profile" => {
            let profile = text_field(value, "profile", "The AWS profile name")?;
            ensure!(is_profile_name(profile), "{profile} is not an AWS profile name");
            BedrockCredentials::Profile { profile: profile.to_string() }
        }
        other => bail!("no such way to authenticate to AWS: {other}"),
    };
    Ok(Bedrock { region: region.to_string(), credentials })
}

fn vertex_from(value: &Value, existing: Option<&Vertex>) -> Result<Vertex> {
    let project = text_field(value, "project", "The Google Cloud project")?;
    ensure!(is_gcp_project(project), "{project} is not a Google Cloud project ID");
    let region = text_field(value, "region", "The Vertex AI region")?;
    ensure!(is_vertex_region(region), "{region} is not a Vertex AI location (like global or us-east5)");
    let service_account = match value.get("service_account") {
        Some(Value::Null) => None,
        Some(given) => Some(service_account(given)?),
        None => existing.and_then(|vertex| vertex.service_account.clone()),
    };
    Ok(Vertex { project: project.to_string(), region: region.to_string(), service_account })
}

fn foundry_from(value: &Value, existing: Option<&Foundry>) -> Result<Foundry> {
    let resource = text_field(value, "resource", "The Foundry resource name")?;
    ensure!(
        is_foundry_resource(resource),
        "{resource} is not a Foundry resource name — give the name alone, not its URL"
    );
    let api_key = match value.get("api_key") {
        Some(given) => secret(given, "The Foundry API key")?,
        None => existing
            .map(|foundry| foundry.api_key.clone())
            .context("The Foundry API key is missing")?,
    };
    Ok(Foundry { resource: resource.to_string(), api_key })
}

// ---- what the page is told ----------------------------------------------------------------------

/// The configuration as the page may see it: every fact a form needs to say what is set up, and
/// never a secret — whether one is set, and of an access key only its last four characters.
pub fn status_json(config: &Config) -> Value {
    json!({
        "claude_method": config.claude_method.as_str(),
        "anthropic_key": config.anthropic_key.is_some(),
        "bedrock": config.bedrock.as_ref().map(|bedrock| {
            let mut view = json!({ "region": bedrock.region, "kind": bedrock.credentials.kind() });
            match &bedrock.credentials {
                BedrockCredentials::ApiKey { .. } => {}
                BedrockCredentials::AccessKey { access_key_id, session_token, .. } => {
                    let tail: String = access_key_id.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                    view["access_key_id_tail"] = json!(tail);
                    view["session_token"] = json!(session_token.is_some());
                }
                BedrockCredentials::Profile { profile } => view["profile"] = json!(profile),
            }
            view
        }),
        "vertex": config.vertex.as_ref().map(|vertex| json!({
            "project": vertex.project,
            "region": vertex.region,
            "service_account": vertex.service_account.as_ref().and_then(service_account_email),
        })),
        "foundry": config.foundry.as_ref().map(|foundry| json!({ "resource": foundry.resource })),
    })
}

// ---- the child's environment --------------------------------------------------------------------

/// What one CLI child's environment gains and loses: removals first, then what is set, so a
/// variable both removed and set ends up set.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ChildEnv {
    pub remove: Vec<&'static str>,
    /// Every inherited variable whose name starts with one of these is removed too — for a family
    /// of names a CLI derives per model (`VERTEX_REGION_CLAUDE_4_6_SONNET`, …).
    pub remove_prefixed: Vec<&'static str>,
    pub set: Vec<(&'static str, String)>,
}

/// Names only: the values ARE the credentials, and an `agent::Request` (which derives `Debug`)
/// carries one of these.
impl std::fmt::Debug for ChildEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let set: Vec<&str> = self.set.iter().map(|(name, _)| *name).collect();
        f.debug_struct("ChildEnv")
            .field("remove", &self.remove)
            .field("remove_prefixed", &self.remove_prefixed)
            .field("set", &set)
            .finish()
    }
}

impl ChildEnv {
    fn remove_all(&mut self, names: &[&'static str]) {
        for name in names {
            if !self.remove.contains(name) {
                self.remove.push(name);
            }
        }
    }

    fn set(&mut self, name: &'static str, value: impl Into<String>) {
        self.set.retain(|(existing, _)| *existing != name);
        self.set.push((name, value.into()));
    }

    /// The value this environment sets for `name`, for tests and for the status read.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.set.iter().find(|(key, _)| *key == name).map(|(_, value)| value.as_str())
    }

    pub fn apply(&self, command: &mut std::process::Command) {
        self.apply_over(command, std::env::vars_os());
    }

    /// [`ChildEnv::apply`] over an inherited environment handed in, so the prefix removal is
    /// tested without touching this process's own.
    fn apply_over(
        &self,
        command: &mut std::process::Command,
        inherited: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    ) {
        for name in &self.remove {
            command.env_remove(name);
        }
        if !self.remove_prefixed.is_empty() {
            for (name, _) in inherited {
                let Some(text) = name.to_str() else { continue };
                if self.remove_prefixed.iter().any(|prefix| text.starts_with(prefix)) {
                    command.env_remove(&name);
                }
            }
        }
        for (name, value) in &self.set {
            command.env(name, value);
        }
    }
}

/// The variables that choose Claude Code's provider. The first six are the CLI's own list, read
/// out of the 2.1.316 binary (`o0`), plus the gateway's; the ignored
/// `the_lists_name_every_way_in_the_real_cli_reads` re-measures them.
const CLAUDE_PROVIDER_FLAGS: [&str; 7] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_GATEWAY",
];

/// The variables that sign Claude Code in ahead of its own login (its documented precedence), and
/// the credential of every provider above that this app does not set itself.
const CLAUDE_CREDENTIALS: [&str; 12] = [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_AWS_WORKSPACE_ID",
];

/// WHERE an inherited setup sends requests, and the switches that make it send them unsigned.
/// A method the user chose in this app is a whole route, so a key it stores must reach the
/// provider it was given for — never a gateway or an endpoint the machine's environment happened to
/// name, which would receive that key (`x-api-key`, a Bedrock bearer) with nobody having chosen it.
const CLAUDE_ENDPOINTS: [&str; 17] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
];

/// The model pins an inherited setup may carry. They are spelled for ONE provider — a Bedrock pin
/// is `eu.anthropic.claude-…`, which the first-party API refuses — so a method this app chose
/// clears them rather than running the machine's pins against another provider.
const CLAUDE_MODEL_PINS: [&str; 7] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
];

/// A Vertex region per model family (`VERTEX_REGION_CLAUDE_4_6_SONNET`), which outranks
/// `CLOUD_ML_REGION` for that model — so an inherited one would run that model in a region nobody
/// chose here.
const VERTEX_MODEL_REGIONS: &str = "VERTEX_REGION_";

/// Every way AWS credentials reach a process, cleared before the account this app holds is set.
const AWS_CREDENTIALS: [&str; 6] = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_REGION",
];

const GOOGLE_CREDENTIALS: [&str; 1] = ["GOOGLE_APPLICATION_CREDENTIALS"];

/// The environment one CLI child runs with, from what this app holds.
///
/// Claude Code takes ONE way in, the one the user chose ([`ClaudeMethod`]); "this machine's own
/// setup" adds and removes nothing. opencode chooses a provider per MODEL, so every cloud account
/// set up here is handed to it, and an `amazon-bedrock/…` model then has what it needs — Foundry
/// excepted, because opencode has no provider for Foundry's Anthropic endpoint.
pub fn child_env(config: &Config, tool: Tool, credentials_dir: Option<&Path>) -> ChildEnv {
    let mut env = ChildEnv::default();
    let service_account_file = credentials_dir.map(service_account_path);
    match tool {
        Tool::Claude => {
            if config.claude_method == ClaudeMethod::Machine {
                return env;
            }
            env.remove_all(&CLAUDE_PROVIDER_FLAGS);
            env.remove_all(&CLAUDE_CREDENTIALS);
            env.remove_all(&CLAUDE_ENDPOINTS);
            env.remove_all(&CLAUDE_MODEL_PINS);
            match config.claude_method {
                ClaudeMethod::Machine | ClaudeMethod::ClaudeAi => {}
                ClaudeMethod::ApiKey => {
                    if let Some(key) = &config.anthropic_key {
                        env.set("ANTHROPIC_API_KEY", key.expose());
                    }
                }
                ClaudeMethod::Bedrock => {
                    if let Some(bedrock) = &config.bedrock {
                        env.set("CLAUDE_CODE_USE_BEDROCK", "1");
                        bedrock_env(&mut env, bedrock);
                    }
                }
                ClaudeMethod::Vertex => {
                    if let Some(vertex) = &config.vertex {
                        env.remove_prefixed.push(VERTEX_MODEL_REGIONS);
                        env.set("CLAUDE_CODE_USE_VERTEX", "1");
                        env.set("CLOUD_ML_REGION", &vertex.region);
                        env.set("ANTHROPIC_VERTEX_PROJECT_ID", &vertex.project);
                        google_credentials(&mut env, vertex, service_account_file.as_deref());
                    }
                }
                ClaudeMethod::Foundry => {
                    if let Some(foundry) = &config.foundry {
                        env.set("CLAUDE_CODE_USE_FOUNDRY", "1");
                        env.set("ANTHROPIC_FOUNDRY_RESOURCE", &foundry.resource);
                        env.set("ANTHROPIC_FOUNDRY_API_KEY", foundry.api_key.expose());
                    }
                }
            }
        }
        Tool::Opencode => {
            if let Some(bedrock) = &config.bedrock {
                bedrock_env(&mut env, bedrock);
            }
            if let Some(vertex) = &config.vertex {
                // Every spelling opencode v1.19.5's two Vertex providers read, in the order they
                // read them (`google-vertex` takes GOOGLE_VERTEX_* first, `google-vertex-anthropic`
                // GOOGLE_CLOUD_*), so an inherited one cannot win over the account chosen here.
                env.set("GOOGLE_VERTEX_PROJECT", &vertex.project);
                env.set("GOOGLE_CLOUD_PROJECT", &vertex.project);
                env.set("GOOGLE_VERTEX_LOCATION", &vertex.region);
                env.set("GOOGLE_CLOUD_LOCATION", &vertex.region);
                env.set("VERTEX_LOCATION", &vertex.region);
                google_credentials(&mut env, vertex, service_account_file.as_deref());
            }
        }
    }
    env
}

fn bedrock_env(env: &mut ChildEnv, bedrock: &Bedrock) {
    env.remove_all(&AWS_CREDENTIALS);
    env.set("AWS_REGION", &bedrock.region);
    match &bedrock.credentials {
        BedrockCredentials::ApiKey { api_key } => env.set("AWS_BEARER_TOKEN_BEDROCK", api_key.expose()),
        BedrockCredentials::AccessKey { access_key_id, secret_access_key, session_token } => {
            env.set("AWS_ACCESS_KEY_ID", access_key_id);
            env.set("AWS_SECRET_ACCESS_KEY", secret_access_key.expose());
            if let Some(token) = session_token {
                env.set("AWS_SESSION_TOKEN", token.expose());
            }
        }
        BedrockCredentials::Profile { profile } => env.set("AWS_PROFILE", profile),
    }
}

fn google_credentials(env: &mut ChildEnv, vertex: &Vertex, file: Option<&Path>) {
    if vertex.service_account.is_none() {
        return;
    }
    env.remove_all(&GOOGLE_CREDENTIALS);
    if let Some(file) = file {
        env.set("GOOGLE_APPLICATION_CREDENTIALS", file.display().to_string());
    }
}

/// The opencode providers the cloud accounts here make runnable, so its model picker offers them.
pub fn opencode_cloud_providers(config: &Config) -> Vec<&'static str> {
    let mut providers = Vec::new();
    if config.bedrock.is_some() {
        providers.push("amazon-bedrock");
    }
    if config.vertex.is_some() {
        providers.extend(["google-vertex", "google-vertex-anthropic"]);
    }
    providers
}

// ---- files --------------------------------------------------------------------------------------

/// `<data dir>/agent-credentials`, when this process has a data directory at all.
pub fn credentials_dir() -> Option<PathBuf> {
    Some(crate::agent_cli::data_dir()?.join(CREDENTIALS_DIR))
}

pub fn service_account_path(dir: &Path) -> PathBuf {
    dir.join("vertex-service-account.json")
}

/// Make the files the configuration names match it: the service-account key written (only when it
/// changed) or removed. Called on every change and before every run, so a file deleted under the
/// app comes back rather than leaving a child pointed at nothing.
pub fn sync_files(config: &Config, dir: &Path) -> Result<()> {
    let path = service_account_path(dir);
    match config.vertex.as_ref().and_then(|vertex| vertex.service_account.as_ref()) {
        Some(key) => {
            if std::fs::read(&path).ok().as_deref() != Some(key.expose().as_bytes()) {
                write_private(&path, key.expose().as_bytes())?;
            }
        }
        None => match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("remove {}", path.display())),
        },
    }
    Ok(())
}

/// Write a file only its owner can read, atomically: a temporary file created `0600` beside it,
/// then a rename over it — so a reader never meets half a key, and the key is never readable by
/// anybody else for even a moment.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("a credentials file has no directory")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .with_context(|| format!("create {}", dir.display()))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("credentials");
    // Per process AND per write, so two saves landing together never share one temporary file.
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nth = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = dir.join(format!(".{name}.{}.{nth}.tmp", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        std::io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.with_context(|| format!("write {}", path.display()))
}

// ---- opencode's own credentials file -------------------------------------------------------------

/// One provider opencode holds a credential for: its id and its kind (`api`, `oauth`, `wellknown`),
/// never the credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpencodeCredential {
    pub provider: String,
    pub kind: String,
}

/// A provider id as opencode and models.dev spell one (`anthropic`, `amazon-bedrock`, `openrouter`).
pub fn is_provider_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
}

/// What `auth.json` holds, provider by provider. A file this cannot read lists nothing.
pub fn opencode_credentials(text: Option<&str>) -> Vec<OpencodeCredential> {
    let Some(entries) = text
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.as_object().cloned())
    else {
        return Vec::new();
    };
    let mut out: Vec<OpencodeCredential> = entries
        .iter()
        .map(|(provider, entry)| OpencodeCredential {
            provider: provider.clone(),
            kind: entry.get("type").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        })
        .collect();
    out.sort_by(|a, b| a.provider.cmp(&b.provider));
    out
}

/// The file as a map, refusing one that exists and cannot be read — rewriting it would throw away
/// every login opencode keeps there, OAuth ones included.
fn read_opencode_auth(path: &Path) -> Result<serde_json::Map<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(serde_json::Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            _ => bail!(
                "opencode's credentials file ({}) could not be read, so nothing was changed",
                path.display()
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// Store an API key for one provider, exactly as opencode's own `/connect` would.
pub fn opencode_set_key(path: &Path, provider: &str, key: &str) -> Result<()> {
    ensure!(is_provider_id(provider), "{provider} is not an opencode provider id");
    let key = secret(&Value::String(key.to_string()), "The API key")?;
    let mut entries = read_opencode_auth(path)?;
    entries.insert(provider.to_string(), json!({ "type": "api", "key": key.expose() }));
    let text = serde_json::to_string_pretty(&Value::Object(entries)).context("serialize auth.json")?;
    write_private(path, text.as_bytes())
}

/// Remove one provider's credential. `false` when opencode held none for it.
pub fn opencode_remove(path: &Path, provider: &str) -> Result<bool> {
    ensure!(is_provider_id(provider), "{provider} is not an opencode provider id");
    let mut entries = read_opencode_auth(path)?;
    if entries.remove(provider).is_none() {
        return Ok(false);
    }
    let text = serde_json::to_string_pretty(&Value::Object(entries)).context("serialize auth.json")?;
    write_private(path, text.as_bytes())?;
    Ok(true)
}

// ---- Claude Code's own account -------------------------------------------------------------------

/// What `claude auth status --json` says, in the fields a page draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeAccount {
    pub logged_in: bool,
    /// `claude.ai`, `api_key`, `api_key_helper`, `oauth_token`, `third_party` or `none` — the
    /// spellings the CLI's own status builder writes.
    pub method: String,
    /// `firstParty`, `bedrock`, `vertex`, `foundry`, `gateway`.
    pub provider: String,
    pub email: Option<String>,
    pub organization: Option<String>,
    pub plan: Option<String>,
}

/// Read the status document. The JSON is found inside the output, because a CLI may print a
/// notice beside it.
pub fn parse_claude_status(output: &str) -> Option<ClaudeAccount> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    let value: Value = serde_json::from_str(output.get(start..=end)?).ok()?;
    let text = |field: &str| {
        value
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    Some(ClaudeAccount {
        logged_in: value.get("loggedIn")?.as_bool()?,
        method: text("authMethod").unwrap_or_else(|| "none".to_string()),
        provider: text("apiProvider").unwrap_or_else(|| "firstParty".to_string()),
        email: text("email"),
        organization: text("orgName"),
        plan: text("subscriptionType"),
    })
}

pub fn account_json(account: &ClaudeAccount) -> Value {
    json!({
        "logged_in": account.logged_in,
        "method": account.method,
        "provider": account.provider,
        "email": account.email,
        "organization": account.organization,
        "plan": account.plan,
    })
}

/// How long a status read may take. It reads local files, so anything longer is a CLI that hung.
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// A Claude Code child with this app's shape: the agent home, no self-update for this app's copy,
/// no write token, no display to open a browser on, and `env` on top.
fn claude_command(program: &Path, managed: bool, env: &ChildEnv) -> tokio::process::Command {
    claude_command_in(program, managed, env, crate::agent_cli::agent_home().as_deref())
}

/// [`claude_command`] with the agent home handed in, so the real CLI can be driven in a throwaway
/// home by a test without touching this process's environment.
fn claude_command_in(program: &Path, managed: bool, env: &ChildEnv, home: Option<&Path>) -> tokio::process::Command {
    let mut command = std::process::Command::new(program);
    crate::agent_cli::prepare_child_with(&mut command, "claude", managed, home);
    env.apply(&mut command);
    command
        .env_remove(crate::agent::WRITE_TOKEN_ENV)
        // The sign-in link is opened in the READER's browser, from the page. A CLI that found a
        // display here would open one on this machine's screen instead — on a workstation, the
        // user's own desktop — so it is given none, and a browser that succeeds by doing nothing.
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env("BROWSER", "true");
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    command
}

/// The environment the sign-in commands run with: the Claude account and nothing else, so an
/// inherited API key or cloud flag cannot turn `auth login` into something else.
pub fn claude_ai_env() -> ChildEnv {
    let config = Config { claude_method: ClaudeMethod::ClaudeAi, ..Config::default() };
    child_env(&config, Tool::Claude, None)
}

/// Ask Claude Code how it would sign in, with the environment a run gets.
pub async fn claude_status(program: &Path, managed: bool, env: &ChildEnv) -> Result<ClaudeAccount> {
    let mut command = claude_command(program, managed, env);
    command.args(["auth", "status", "--json"]).stdin(Stdio::null());
    let output = tokio::time::timeout(STATUS_TIMEOUT, command.output())
        .await
        .context("claude auth status did not answer within 15 seconds")?
        .context("run claude auth status")?;
    // Signed out exits 1 with the same document, so the exit code says nothing here.
    let text = String::from_utf8_lossy(&output.stdout);
    parse_claude_status(&text).with_context(|| {
        let said = last_line(&strip_terminal(&String::from_utf8_lossy(&output.stderr)));
        format!("claude auth status answered with no status{}", said.map(|s| format!(": {s}")).unwrap_or_default())
    })
}

/// Sign Claude Code's own account out (`claude auth logout`).
pub async fn claude_logout(program: &Path, managed: bool) -> Result<()> {
    let mut command = claude_command(program, managed, &claude_ai_env());
    command.args(["auth", "logout"]).stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .context("claude auth logout did not finish within 30 seconds")?
        .context("run claude auth logout")?;
    if output.status.success() {
        return Ok(());
    }
    let mut said = String::from_utf8_lossy(&output.stdout).into_owned();
    said.push_str(&String::from_utf8_lossy(&output.stderr));
    bail!(
        "{}",
        last_line(&strip_terminal(&said)).unwrap_or_else(|| format!("claude auth logout exited {}", output.status))
    )
}

// ---- the sign-in, behind the scenes --------------------------------------------------------------

/// The hosts a sign-in link may point at. The link comes from the CLI's output and is handed to a
/// page to open, so nothing else is ever passed on: a link to anywhere else is not a sign-in.
pub const LOGIN_HOSTS: [&str; 4] = ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"];

/// How long a sign-in stays open for its code. Generous — it covers a password manager, an SSO
/// page and a second device — and bounded, so an abandoned sign-in does not hold a process for ever.
pub const LOGIN_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// How long the CLI has to print its link.
const LINK_WAIT: Duration = Duration::from_secs(30);

/// How long the CLI has to exchange the code and say how that went.
const FINISH_WAIT: Duration = Duration::from_secs(60);

/// The most output kept from one sign-in: enough for every line it prints, bounded because it is a
/// child's output.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

/// `claude auth login`, waiting for the code its link leads to.
pub struct ClaudeLogin {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    output: Arc<Mutex<String>>,
    /// The tasks copying the CLI's stdout and stderr into `output`, awaited once it exits so the
    /// last thing it said — its refusal — is read before anything is reported.
    readers: Vec<tokio::task::JoinHandle<()>>,
    url: String,
}

impl std::fmt::Debug for ClaudeLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeLogin").field("url", &self.url).finish_non_exhaustive()
    }
}

/// How long the output of a CLI that exited is waited for. Its pipes close as it exits, so this is
/// only the moment the copying tasks need to take the last bytes.
const DRAIN_WAIT: Duration = Duration::from_secs(1);

/// Wait (bounded) for the copying tasks to take what is left in the pipes.
async fn drain(readers: &mut Vec<tokio::task::JoinHandle<()>>) {
    let until = tokio::time::Instant::now() + DRAIN_WAIT;
    for reader in readers.drain(..) {
        let _ = tokio::time::timeout_at(until, reader).await;
    }
}

impl ClaudeLogin {
    /// Start the CLI's sign-in and wait for the link it prints. `console` signs in to an Anthropic
    /// Console account (API billing) instead of a Claude subscription.
    pub async fn start(program: &Path, managed: bool, console: bool) -> Result<ClaudeLogin> {
        Self::start_in(program, managed, console, crate::agent_cli::agent_home().as_deref()).await
    }

    async fn start_in(program: &Path, managed: bool, console: bool, home: Option<&Path>) -> Result<ClaudeLogin> {
        let mut command = claude_command_in(program, managed, &claude_ai_env(), home);
        command.args(["auth", "login"]);
        if console {
            command.arg("--console");
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().context("start claude auth login")?;
        let output = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        for stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            readers.push(tokio::spawn(collect(stream, Arc::clone(&output))));
        }
        let stdin = child.stdin.take();

        let deadline = Instant::now() + LINK_WAIT;
        let url = loop {
            if let Some(url) = login_url(&snapshot(&output)) {
                break url;
            }
            if let Some(status) = child.try_wait().context("watch claude auth login")? {
                drain(&mut readers).await;
                let said = last_line(&strip_terminal(&snapshot(&output)));
                bail!(
                    "claude auth login ended before it offered a sign-in link: {}",
                    said.unwrap_or_else(|| format!("it exited {status}"))
                );
            }
            ensure!(Instant::now() < deadline, "claude auth login offered no sign-in link within 30 seconds");
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        Ok(ClaudeLogin { child, stdin, output, readers, url })
    }

    /// The authorize link, on claude.com.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Whether the CLI is gone: a sign-in whose CLI exited has nothing left to hand a code to, so
    /// its link must be withdrawn rather than left on the page.
    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// The sentence for a CLI that went away while it was waiting for its code.
    async fn gone(&mut self, mark: usize) -> anyhow::Error {
        drain(&mut self.readers).await;
        let said = snapshot(&self.output);
        let since = said.get(mark..).unwrap_or_default();
        let sentence = failure_sentence(since)
            .or_else(|| last_line(&strip_terminal(since)))
            .unwrap_or_else(|| "claude auth login is no longer running — press Sign in again".to_string());
        anyhow::anyhow!(sentence)
    }

    /// Hand the code claude.com showed to the waiting CLI, and wait for its answer.
    ///
    /// Success is the CLI's own: an exit of 0, or its "Login successful" (after which it may wait
    /// for Enter, which is pressed for it). Anything else is reported in the CLI's own sentence —
    /// "That code wasn't accepted…" — because that is the sentence that says what to do.
    pub async fn finish(mut self, code: &str) -> Result<()> {
        let code = login_code(code)?;
        let mark = snapshot(&self.output).len();
        if self.has_exited() {
            return Err(self.gone(mark).await);
        }
        let written = match self.stdin.as_mut() {
            Some(stdin) => {
                let mut line = code.into_bytes();
                line.push(b'\n');
                stdin.write_all(&line).await.and(stdin.flush().await)
            }
            None => Err(std::io::Error::other("no stdin")),
        };
        if written.is_err() {
            return Err(self.gone(mark).await);
        }

        let deadline = Instant::now() + FINISH_WAIT;
        let mut succeeded_at: Option<Instant> = None;
        let mut pressed_enter = false;
        loop {
            if let Some(status) = self.child.try_wait().context("watch claude auth login")? {
                drain(&mut self.readers).await;
                let since = snapshot(&self.output).get(mark..).unwrap_or_default().to_string();
                if status.success() || said_success(&since) {
                    return Ok(());
                }
                bail!(
                    "{}",
                    failure_sentence(&since)
                        .unwrap_or_else(|| format!("claude auth login refused the code (it exited {status})"))
                );
            }
            let since = snapshot(&self.output).get(mark..).unwrap_or_default().to_string();
            if succeeded_at.is_none() && said_success(&since) {
                succeeded_at = Some(Instant::now());
            }
            match succeeded_at {
                Some(at) => {
                    // It said so; what is left is its "press Enter", which is pressed for it, and then
                    // a bounded wait for it to leave. The minute below no longer applies: the sign-in
                    // is done, and a success near its end must not be reported as a failure.
                    if !pressed_enter && at.elapsed() > Duration::from_secs(1) {
                        if let Some(stdin) = self.stdin.as_mut() {
                            stdin.write_all(b"\n").await.ok();
                            stdin.flush().await.ok();
                        }
                        pressed_enter = true;
                    }
                    if at.elapsed() > Duration::from_secs(6) {
                        self.child.kill().await.ok();
                        return Ok(());
                    }
                }
                None if Instant::now() > deadline => {
                    self.child.kill().await.ok();
                    bail!("claude auth login did not finish within a minute of the code");
                }
                None => {}
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

async fn collect(mut stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>, output: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Ok(mut text) = output.lock() {
                    if text.len() + n <= MAX_OUTPUT_BYTES {
                        text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                    }
                }
            }
        }
    }
}

fn snapshot(output: &Arc<Mutex<String>>) -> String {
    output.lock().map(|text| text.clone()).unwrap_or_default()
}

/// The first link in the output that is a sign-in on Anthropic's own hosts.
pub fn login_url(output: &str) -> Option<String> {
    let mut rest = output;
    while let Some(at) = rest.find("https://") {
        let candidate: String = rest[at..]
            .chars()
            .take_while(|c| !c.is_whitespace() && !c.is_control() && !"\"'<>`".contains(*c))
            .collect();
        rest = &rest[at + "https://".len()..];
        let Ok(url) = reqwest::Url::parse(&candidate) else { continue };
        let on_our_host = url.host_str().is_some_and(|host| LOGIN_HOSTS.contains(&host));
        if url.scheme() == "https" && on_our_host && url.path().ends_with("/oauth/authorize") {
            return Some(url.to_string());
        }
    }
    None
}

/// A code as claude.com shows one: one token of printable characters (it carries a `#` and the
/// state after it), bounded.
pub fn login_code(code: &str) -> Result<String> {
    let code = code.trim();
    ensure!(!code.is_empty(), "Paste the code claude.com showed you");
    ensure!(code.len() <= 1024, "That is far longer than a sign-in code");
    ensure!(
        code.chars().all(|c| c.is_ascii_graphic()),
        "A sign-in code is one line with no spaces — paste it alone"
    );
    Ok(code.to_string())
}

fn said_success(output: &str) -> bool {
    strip_terminal(output).to_ascii_lowercase().contains("login successful")
}

/// The CLI's own sentence about a failure: its "Login failed: …" line, else its last line.
pub fn failure_sentence(output: &str) -> Option<String> {
    let clean = strip_terminal(output);
    let lines: Vec<&str> = clean
        .lines()
        .map(|line| line.rsplit("prompted >").next().unwrap_or(line).trim())
        .filter(|line| !line.is_empty())
        .collect();
    let line = lines
        .iter()
        .rev()
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("failed") || lower.contains("error") || lower.contains("wasn't accepted")
        })
        .or(lines.last())?;
    Some(bounded(line, 300))
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).last().map(|line| bounded(line, 300))
}

fn bounded(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// A terminal's output with its escape sequences taken out: colours and cursor moves (CSI), and
/// hyperlinks and titles (OSC), so what is left is the words. A carriage return is a line break.
pub fn strip_terminal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => out.push('\n'),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, emptied first (the workspace has no temp-dir crate).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("teams-lite-agent-auth-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn configured() -> Config {
        Config {
            claude_method: ClaudeMethod::Machine,
            anthropic_key: Some(Secret::new("sk-ant-api03-key")),
            bedrock: Some(Bedrock {
                region: "eu-west-3".into(),
                credentials: BedrockCredentials::ApiKey { api_key: Secret::new("bedrock-token") },
            }),
            vertex: Some(Vertex {
                project: "my-project-1".into(),
                region: "us-east5".into(),
                service_account: None,
            }),
            foundry: Some(Foundry { resource: "my-resource".into(), api_key: Secret::new("foundry-key") }),
        }
    }

    const SERVICE_ACCOUNT: &str = r#"{"type":"service_account","project_id":"p","client_email":"bot@p.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"}"#;

    #[test]
    fn a_secret_never_prints() {
        let config = configured();
        let debug = format!("{config:?}");
        for secret in ["sk-ant-api03-key", "bedrock-token", "foundry-key"] {
            assert!(!debug.contains(secret), "{secret} leaked into Debug: {debug}");
        }
    }

    #[test]
    fn the_page_is_told_what_is_set_up_and_never_a_secret() {
        let mut config = configured();
        config.bedrock = Some(Bedrock {
            region: "us-east-1".into(),
            credentials: BedrockCredentials::AccessKey {
                access_key_id: "AKIAABCDEFGHIJKLWXYZ".into(),
                secret_access_key: Secret::new("very-secret"),
                session_token: Some(Secret::new("session-secret")),
            },
        });
        config.vertex.as_mut().unwrap().service_account = Some(Secret::new(SERVICE_ACCOUNT));
        let view = status_json(&config);
        let text = view.to_string();
        for secret in ["sk-ant-api03-key", "very-secret", "session-secret", "foundry-key", "PRIVATE KEY", "AKIAABCDEFGHIJKL"] {
            assert!(!text.contains(secret), "{secret} reached the page: {text}");
        }
        assert_eq!(view["anthropic_key"], true);
        assert_eq!(view["bedrock"]["kind"], "access_key");
        assert_eq!(view["bedrock"]["access_key_id_tail"], "WXYZ");
        assert_eq!(view["bedrock"]["session_token"], true);
        assert_eq!(view["vertex"]["service_account"], "bot@p.iam.gserviceaccount.com");
        assert_eq!(view["foundry"]["resource"], "my-resource");
    }

    #[test]
    fn the_machines_own_setup_adds_and_removes_nothing() {
        let config = configured();
        assert_eq!(child_env(&config, Tool::Claude, None), ChildEnv::default());
    }

    #[test]
    fn a_chosen_method_clears_every_other_way_in_and_the_machines_model_pins() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::ClaudeAi;
        let env = child_env(&config, Tool::Claude, None);
        assert!(env.set.is_empty(), "a Claude account is the CLI's own login: {:?}", env.set);
        for name in ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_OAUTH_TOKEN"] {
            assert!(env.remove.contains(&name), "{name} must be removed");
        }

        config.claude_method = ClaudeMethod::ApiKey;
        let env = child_env(&config, Tool::Claude, None);
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some("sk-ant-api03-key"));
        assert!(env.remove.contains(&"CLAUDE_CODE_USE_BEDROCK"));
    }

    #[test]
    fn bedrock_is_the_documented_environment_for_both_clis() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::Bedrock;
        let claude = child_env(&config, Tool::Claude, None);
        assert_eq!(claude.get("CLAUDE_CODE_USE_BEDROCK"), Some("1"));
        assert_eq!(claude.get("AWS_REGION"), Some("eu-west-3"));
        assert_eq!(claude.get("AWS_BEARER_TOKEN_BEDROCK"), Some("bedrock-token"));
        assert!(claude.remove.contains(&"AWS_PROFILE"), "an inherited profile must not outrank the key");

        // opencode picks a provider per model, so the account is handed over whatever Claude Code does.
        config.claude_method = ClaudeMethod::Machine;
        let opencode = child_env(&config, Tool::Opencode, None);
        assert_eq!(opencode.get("AWS_REGION"), Some("eu-west-3"));
        assert_eq!(opencode.get("AWS_BEARER_TOKEN_BEDROCK"), Some("bedrock-token"));
        assert_eq!(opencode.get("CLAUDE_CODE_USE_BEDROCK"), None);
        assert_eq!(opencode_cloud_providers(&config), ["amazon-bedrock", "google-vertex", "google-vertex-anthropic"]);
    }

    #[test]
    fn an_access_key_and_a_profile_are_spelled_the_way_aws_reads_them() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::Bedrock;
        config.bedrock = Some(Bedrock {
            region: "us-east-1".into(),
            credentials: BedrockCredentials::AccessKey {
                access_key_id: "AKIAABCDEFGHIJKLMNOP".into(),
                secret_access_key: Secret::new("s3cr3t"),
                session_token: None,
            },
        });
        let env = child_env(&config, Tool::Claude, None);
        assert_eq!(env.get("AWS_ACCESS_KEY_ID"), Some("AKIAABCDEFGHIJKLMNOP"));
        assert_eq!(env.get("AWS_SECRET_ACCESS_KEY"), Some("s3cr3t"));
        assert_eq!(env.get("AWS_SESSION_TOKEN"), None);
        assert!(env.remove.contains(&"AWS_SESSION_TOKEN"), "an inherited token would pair with another key");

        config.bedrock.as_mut().unwrap().credentials = BedrockCredentials::Profile { profile: "work".into() };
        let env = child_env(&config, Tool::Claude, None);
        assert_eq!(env.get("AWS_PROFILE"), Some("work"));
        assert_eq!(env.get("AWS_ACCESS_KEY_ID"), None);
    }

    #[test]
    fn vertex_and_foundry_are_the_documented_environment() {
        let mut config = configured();
        config.vertex.as_mut().unwrap().service_account = Some(Secret::new(SERVICE_ACCOUNT));
        config.claude_method = ClaudeMethod::Vertex;
        let dir = Path::new("/data/agent-credentials");
        let env = child_env(&config, Tool::Claude, Some(dir));
        assert_eq!(env.get("CLAUDE_CODE_USE_VERTEX"), Some("1"));
        assert_eq!(env.get("CLOUD_ML_REGION"), Some("us-east5"));
        assert_eq!(env.get("ANTHROPIC_VERTEX_PROJECT_ID"), Some("my-project-1"));
        assert_eq!(
            env.get("GOOGLE_APPLICATION_CREDENTIALS"),
            Some("/data/agent-credentials/vertex-service-account.json")
        );
        let opencode = child_env(&config, Tool::Opencode, Some(dir));
        assert_eq!(opencode.get("GOOGLE_CLOUD_PROJECT"), Some("my-project-1"));
        assert_eq!(opencode.get("VERTEX_LOCATION"), Some("us-east5"));

        config.claude_method = ClaudeMethod::Foundry;
        let env = child_env(&config, Tool::Claude, None);
        assert_eq!(env.get("CLAUDE_CODE_USE_FOUNDRY"), Some("1"));
        assert_eq!(env.get("ANTHROPIC_FOUNDRY_RESOURCE"), Some("my-resource"));
        assert_eq!(env.get("ANTHROPIC_FOUNDRY_API_KEY"), Some("foundry-key"));
        assert!(env.remove.contains(&"ANTHROPIC_FOUNDRY_BASE_URL"));
        // opencode has no provider for Foundry's Anthropic endpoint, so it is handed nothing of it.
        assert_eq!(child_env(&config, Tool::Opencode, None).get("ANTHROPIC_FOUNDRY_API_KEY"), None);
    }

    #[test]
    fn a_removal_then_a_set_of_one_name_ends_set() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::ApiKey;
        let env = child_env(&config, Tool::Claude, None);
        let mut command = std::process::Command::new("true");
        env.apply(&mut command);
        let value = command
            .get_envs()
            .find(|(name, _)| *name == "ANTHROPIC_API_KEY")
            .and_then(|(_, value)| value);
        assert_eq!(value.and_then(|v| v.to_str()), Some("sk-ant-api03-key"));
    }

    #[test]
    fn an_update_keeps_a_secret_it_was_not_given_and_checks_the_method() {
        let config = configured();
        // A new region, the key left out: the key stays.
        let next = config.update(&json!({ "bedrock": { "region": "us-west-2", "kind": "api_key" } })).unwrap();
        assert_eq!(next.bedrock.as_ref().unwrap().region, "us-west-2");
        assert_eq!(
            next.bedrock.as_ref().unwrap().credentials,
            BedrockCredentials::ApiKey { api_key: Secret::new("bedrock-token") }
        );
        // Moving to an access key needs its secret: the old Bedrock API key is not one.
        assert!(
            config
                .update(&json!({ "bedrock": { "region": "us-west-2", "kind": "access_key", "access_key_id": "AKIAABCDEFGHIJKLMNOP" } }))
                .is_err()
        );
        // A method that needs a piece this configuration lacks is refused, with the step to take.
        let empty = Config::default();
        let error = empty.update(&json!({ "claude_method": "bedrock" })).unwrap_err().to_string();
        assert_eq!(error, "Set up Amazon Bedrock first");
        // Removing what the chosen method runs on is refused too.
        let on_bedrock = config.update(&json!({ "claude_method": "bedrock" })).unwrap();
        let error = on_bedrock.update(&json!({ "bedrock": null })).unwrap_err().to_string();
        assert!(error.contains("signs in with Amazon Bedrock"), "{error}");
        // Both in one change is fine.
        let moved = on_bedrock.update(&json!({ "claude_method": "claude_ai", "bedrock": null })).unwrap();
        assert!(moved.bedrock.is_none());
    }

    #[test]
    fn an_access_key_is_edited_without_retyping_its_id() {
        let config = Config::default()
            .update(&json!({ "bedrock": { "region": "us-east-1", "kind": "access_key",
                "access_key_id": "AKIAAAAAAAAAAAAAAAAA", "secret_access_key": "one", "session_token": "t" } }))
            .unwrap();
        let moved = config.update(&json!({ "bedrock": { "region": "eu-west-1", "kind": "access_key" } })).unwrap();
        assert_eq!(
            moved.bedrock.unwrap().credentials,
            BedrockCredentials::AccessKey {
                access_key_id: "AKIAAAAAAAAAAAAAAAAA".into(),
                secret_access_key: Secret::new("one"),
                session_token: Some(Secret::new("t")),
            }
        );
        // And a session token can be dropped on its own.
        let dropped = config
            .update(&json!({ "bedrock": { "region": "eu-west-1", "kind": "access_key", "session_token": null } }))
            .unwrap();
        assert!(matches!(
            dropped.bedrock.unwrap().credentials,
            BedrockCredentials::AccessKey { session_token: None, .. }
        ));
    }

    #[test]
    fn a_chosen_method_clears_every_provider_the_cli_reads_and_every_inherited_endpoint() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::ApiKey;
        let env = child_env(&config, Tool::Claude, None);
        // The CLI's own provider list (2.1.316's `o0`), and the gateway beside it.
        for flag in [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
            "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
            "CLAUDE_CODE_USE_MANTLE",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_GATEWAY",
        ] {
            assert!(env.remove.contains(&flag), "{flag} must be removed");
        }
        // A key stored here goes to Anthropic, never to a gateway the machine's environment named.
        for name in ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_AWS_API_KEY"] {
            assert!(env.remove.contains(&name), "{name} must be removed");
        }
        // The machine's own setup still touches nothing.
        config.claude_method = ClaudeMethod::Machine;
        assert_eq!(child_env(&config, Tool::Claude, None), ChildEnv::default());
    }

    #[test]
    fn vertex_clears_the_per_model_regions_a_machine_inherited() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::Vertex;
        let env = child_env(&config, Tool::Claude, None);
        let mut command = std::process::Command::new("true");
        let inherited = [
            ("VERTEX_REGION_CLAUDE_4_6_SONNET".into(), "europe-west1".into()),
            ("HOME".into(), "/home/x".into()),
        ];
        env.apply_over(&mut command, inherited.into_iter());
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains(&"VERTEX_REGION_CLAUDE_4_6_SONNET".to_string()), "{removed:?}");
        assert!(!removed.contains(&"HOME".to_string()));
    }

    #[test]
    fn opencode_is_given_every_spelling_its_vertex_providers_read() {
        let config = configured();
        let env = child_env(&config, Tool::Opencode, None);
        for (name, value) in [
            ("GOOGLE_VERTEX_PROJECT", "my-project-1"),
            ("GOOGLE_CLOUD_PROJECT", "my-project-1"),
            ("GOOGLE_VERTEX_LOCATION", "us-east5"),
            ("GOOGLE_CLOUD_LOCATION", "us-east5"),
            ("VERTEX_LOCATION", "us-east5"),
        ] {
            assert_eq!(env.get(name), Some(value), "{name}");
        }
    }

    #[test]
    fn a_child_env_prints_names_and_never_values() {
        let mut config = configured();
        config.claude_method = ClaudeMethod::ApiKey;
        let debug = format!("{:?}", child_env(&config, Tool::Claude, None));
        assert!(debug.contains("ANTHROPIC_API_KEY"));
        assert!(!debug.contains("sk-ant-api03-key"), "{debug}");
    }

    #[test]
    fn a_stored_secret_belongs_to_its_access_key_id() {
        let mut config = Config::default();
        config = config
            .update(&json!({ "bedrock": { "region": "us-east-1", "kind": "access_key",
                "access_key_id": "AKIAAAAAAAAAAAAAAAAA", "secret_access_key": "one" } }))
            .unwrap();
        // The same id, the secret left out: kept.
        assert!(
            config
                .update(&json!({ "bedrock": { "region": "eu-west-1", "kind": "access_key", "access_key_id": "AKIAAAAAAAAAAAAAAAAA" } }))
                .is_ok()
        );
        // Another id with the old secret would pair two halves of two keys.
        assert!(
            config
                .update(&json!({ "bedrock": { "region": "eu-west-1", "kind": "access_key", "access_key_id": "AKIABBBBBBBBBBBBBBBB" } }))
                .is_err()
        );
    }

    #[test]
    fn what_a_form_sends_is_checked_before_it_is_kept() {
        let config = Config::default();
        for bad in [
            json!({ "anthropic_key": "sk-ant one" }),
            json!({ "anthropic_key": "" }),
            json!({ "bedrock": { "region": "Europe", "kind": "api_key", "api_key": "x" } }),
            json!({ "bedrock": { "region": "us-east-1", "kind": "sso", "api_key": "x" } }),
            json!({ "vertex": { "project": "P", "region": "global" } }),
            json!({ "vertex": { "project": "my-project", "region": "us-east5", "service_account": "{\"type\":\"user\"}" } }),
            json!({ "foundry": { "resource": "https://x.services.ai.azure.com", "api_key": "k" } }),
            json!({ "claude_method": "magic" }),
        ] {
            assert!(config.update(&bad).is_err(), "{bad} was accepted");
        }
        let ok = config
            .update(&json!({ "vertex": { "project": "my-project", "region": "global", "service_account": SERVICE_ACCOUNT } }))
            .unwrap();
        assert!(ok.vertex.unwrap().service_account.is_some());
    }

    #[test]
    fn regions_and_names_are_the_shapes_their_providers_use() {
        for region in ["us-east-1", "eu-central-2", "us-gov-west-1", "ap-southeast-4", "il-central-1"] {
            assert!(is_aws_region(region), "{region}");
        }
        for region in ["us-east", "US-EAST-1", "eu-west-123", "global", "us-east-1/x"] {
            assert!(!is_aws_region(region), "{region}");
        }
        for region in ["global", "us", "eu", "us-east5", "europe-west1", "northamerica-northeast1"] {
            assert!(is_vertex_region(region), "{region}");
        }
        for region in ["us-east", "us-east-1", "EU", "asia"] {
            assert!(!is_vertex_region(region), "{region}");
        }
        assert!(is_gcp_project("my-project-123"));
        assert!(!is_gcp_project("1project") && !is_gcp_project("short") && !is_gcp_project("ends-"));
        assert!(is_foundry_resource("my-resource"));
        assert!(!is_foundry_resource("my-resource.services.ai.azure.com"));
    }

    #[test]
    fn a_stored_value_this_cannot_read_is_the_machines_own_setup() {
        assert_eq!(Config::parse(Some("not json")), Config::default());
        assert_eq!(Config::parse(None), Config::default());
        let config = configured();
        assert_eq!(Config::parse(Some(&config.to_stored())), config);
    }

    #[test]
    fn opencode_keys_land_in_its_own_file_in_its_own_shape() {
        let dir = scratch("opencode-keys");
        let path = dir.join("opencode/auth.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"github-copilot":{"type":"oauth","refresh":"r","access":"a","expires":1}}"#).unwrap();

        opencode_set_key(&path, "anthropic", "sk-ant-x").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["anthropic"], json!({ "type": "api", "key": "sk-ant-x" }));
        // An OAuth login opencode keeps there survives a key being added beside it.
        assert_eq!(value["github-copilot"]["type"], "oauth");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let listed = opencode_credentials(Some(&text));
        assert_eq!(
            listed,
            [
                OpencodeCredential { provider: "anthropic".into(), kind: "api".into() },
                OpencodeCredential { provider: "github-copilot".into(), kind: "oauth".into() },
            ]
        );
        assert!(opencode_remove(&path, "anthropic").unwrap());
        assert!(!opencode_remove(&path, "anthropic").unwrap());
        assert!(opencode_set_key(&path, "../escape", "k").is_err());
        assert!(opencode_set_key(&path, "openai", "two words").is_err());
    }

    #[test]
    fn an_unreadable_opencode_file_is_never_overwritten() {
        let dir = scratch("opencode-unreadable");
        let path = dir.join("auth.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(opencode_set_key(&path, "anthropic", "k").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn the_service_account_file_follows_the_config() {
        let dir = scratch("service-account");
        let credentials = dir.join(CREDENTIALS_DIR);
        let mut config = configured();
        config.vertex.as_mut().unwrap().service_account = Some(Secret::new(SERVICE_ACCOUNT));
        sync_files(&config, &credentials).unwrap();
        let path = service_account_path(&credentials);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SERVICE_ACCOUNT);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&credentials).unwrap().permissions().mode() & 0o777, 0o700);
        config.vertex = None;
        sync_files(&config, &credentials).unwrap();
        assert!(!path.exists());
    }

    // The output below is what Claude Code 2.1.316 really printed on this machine, run with a
    // throwaway home and no browser, with the link's query shortened.
    const LOGIN_OUTPUT: &str = "Opening browser to sign in…\r\nIf the browser didn't open, visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=c&code_challenge_method=S256&state=s\u{7}https://claude.com/cai/oauth/authorize?code=true\u{1b}]8;;\u{7}\r\nPaste code here if prompted > ";

    #[test]
    fn the_sign_in_link_is_read_out_of_the_clis_own_output() {
        let url = login_url(LOGIN_OUTPUT).unwrap();
        assert!(url.starts_with("https://claude.com/cai/oauth/authorize?"), "{url}");
        assert!(url.contains("code_challenge_method=S256"));
        // A link anywhere else is not a sign-in, whatever its path says.
        assert_eq!(login_url("visit https://evil.example/cai/oauth/authorize?x=1"), None);
        assert_eq!(login_url("visit http://claude.com/cai/oauth/authorize"), None);
        assert_eq!(login_url("visit https://claude.com/download"), None);
    }

    #[test]
    fn the_clis_own_refusal_is_what_the_page_is_told() {
        let after = "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n";
        assert_eq!(
            failure_sentence(after).as_deref(),
            Some("Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.")
        );
        assert!(said_success("\u{1b}[32mLogin successful\u{1b}[0m"));
        assert!(login_code("abc123#state").is_ok());
        assert!(login_code("abc 123").is_err());
        assert!(login_code("  ").is_err());
    }

    #[test]
    fn a_status_document_is_read_for_every_way_in() {
        // Measured: signed out, an API key, Bedrock — and the claude.ai fields the CLI's own status
        // builder writes (`email`, `orgName`, `subscriptionType`).
        let out = parse_claude_status(r#"{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}"#).unwrap();
        assert!(!out.logged_in);
        let key = parse_claude_status(r#"{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY"}"#).unwrap();
        assert_eq!(key.method, "api_key");
        let bedrock = parse_claude_status(r#"{"loggedIn": true, "authMethod": "third_party", "apiProvider": "bedrock"}"#).unwrap();
        assert_eq!(bedrock.provider, "bedrock");
        let account = parse_claude_status(
            "notice\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\",\"email\":\"ada@example.com\",\"orgName\":\"Ada's org\",\"subscriptionType\":\"max\"}",
        )
        .unwrap();
        assert_eq!(account.email.as_deref(), Some("ada@example.com"));
        assert_eq!(account.organization.as_deref(), Some("Ada's org"));
        assert_eq!(account.plan.as_deref(), Some("max"));
        assert_eq!(parse_claude_status("Not logged in."), None);
    }

    #[test]
    fn terminal_escapes_are_taken_out() {
        assert_eq!(strip_terminal("\u{1b}[1mBold\u{1b}[0m\rnext"), "Bold\nnext");
        assert_eq!(strip_terminal("a\u{1b}]8;;https://x\u{7}link\u{1b}]8;;\u{1b}\\b"), "alinkb");
    }

    /// The real CLI, driven exactly as the app drives it, in a throwaway home: its link is read out
    /// of its own output, and a code claude.com never issued is refused in its own words. Nothing is
    /// signed in — the code is bogus — so it is safe to run on a machine whose own Claude Code is
    /// signed in. It needs `claude` on PATH, so it is run by hand:
    ///
    ///     cargo test --lib agent_auth::tests::the_real_cli_offers_its_link_and_refuses_a_bad_code -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "runs the real claude auth login (no sign-in completes)"]
    async fn the_real_cli_offers_its_link_and_refuses_a_bad_code() {
        let program = crate::agent::resolve_program("claude").expect("claude on PATH");
        let home = scratch("real-login");
        let login = ClaudeLogin::start_in(&program, false, false, Some(&home)).await.unwrap();
        let url = reqwest::Url::parse(login.url()).unwrap();
        println!("link host: {:?}, path: {}", url.host_str(), url.path());
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("code_challenge_method").map(String::as_str), Some("S256"), "the flow is PKCE");
        assert_eq!(
            query.get("redirect_uri").map(String::as_str),
            Some("https://platform.claude.com/oauth/code/callback"),
            "claude.com shows the code rather than redirecting to this machine"
        );
        let refusal = login.finish("bogus-code#bogus-state").await.unwrap_err().to_string();
        println!("refusal: {refusal}");
        assert!(refusal.contains("wasn't accepted") || refusal.to_lowercase().contains("failed"), "{refusal}");
        assert!(!home.join(".claude/.credentials.json").exists(), "nothing was signed in");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The provider flags and endpoint overrides are pinned against the CLI that ships: every
    /// `CLAUDE_CODE_USE_<provider>` and every `…_BASE_URL` it reads is one a chosen method clears.
    ///
    ///     cargo test --lib agent_auth::tests::the_lists_name_every_way_in_the_real_cli_reads -- --ignored
    #[test]
    #[ignore = "reads the real claude binary"]
    fn the_lists_name_every_way_in_the_real_cli_reads() {
        let program = crate::agent::resolve_program("claude").expect("claude on PATH");
        let bytes = std::fs::read(std::fs::canonicalize(program).unwrap()).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        // The CLI's own list of provider flags, as it declares it.
        let at = text.find("[\"CLAUDE_CODE_USE_BEDROCK\"").expect("the provider list");
        let list = &text[at..at + text[at..].find(']').unwrap()];
        for flag in list.split(',').map(|f| f.trim_matches(|c| c == '[' || c == '"' || c == ' ')) {
            assert!(CLAUDE_PROVIDER_FLAGS.contains(&flag), "{flag} is a provider the CLI reads and nothing clears");
        }
        for name in ["ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"] {
            assert!(text.contains(name), "{name} is no longer in the CLI");
            assert!(CLAUDE_ENDPOINTS.contains(&name));
        }
    }
}
