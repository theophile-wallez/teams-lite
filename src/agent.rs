//! Run a local coding agent (Claude Code, opencode) and watch its answer grow.
//!
//! The mechanical half of the Teams agent reply; [`crate::agent_policy`] holds the
//! opinions (who may summon it, where the answer may go). This module knows two
//! things: how to spell the command line for each CLI, and how to read its streamed
//! JSON back into one growing string.
//!
//! # Why it streams
//!
//! The answer is posted once and then EDITED as it grows, so everybody in the thread
//! watches it being written (see `agent_reply` in `src/bin/server.rs`). That needs
//! the answer-so-far, not just the final text, which is why both backends run in
//! their streaming mode and why progress goes out over a [`watch`] channel: only the
//! latest value matters, so a consumer doing a network round-trip per edit can never
//! fall behind the model.
//!
//! Two consumers read that channel, and they want different things from it. A Teams
//! edit is a network round-trip everybody in the thread pays for, so it only cares
//! about [`Progress::text`] and is rate-limited. The app's own frontends are local,
//! so they get the whole [`Progress`] — the reasoning, the tool that is running, the
//! phase — and render the answer as it is written rather than in one-second jumps.
//! That is why this module reports a struct and not a string: the edit path was never
//! going to carry "reading src/agent.rs" into a colleague's chat, and a local UI
//! should not be limited to what a chat message can hold.
//!
//! # What the child may do
//!
//! Two things are deliberate and load-bearing:
//!
//! - **This app never widens the child's permissions by itself.** The trigger is a chat
//!   message; the answer runs a program on the user's machine. So by default the tool
//!   list is an explicit allowlist ([`DEFAULT_TOOLS`] is read-only) and Claude Code is
//!   pinned to `--permission-mode default`, which refuses anything outside it rather
//!   than prompting (there is no terminal to prompt). [`TOOL_GRANTS`] is how that
//!   allowlist is widened — named read-only groups the user switches on from the
//!   thread's own menu, so "it may read Grafana" is one action instead of thirty tool
//!   names typed by hand.
//!
//!   [`Permissions::OwnConfig`] is the other setting, off by default and gated
//!   (`agent_set_unrestricted`): it passes NEITHER flag, so the CLI resolves both from
//!   the user's own configuration — every MCP server, every tool, whatever
//!   `permissions.defaultMode` says — which is the same run they get in their terminal.
//!   The floor that stays: this crate never *spells* an escalation. No
//!   `bypassPermissions`, no `--dangerously-skip-permissions`, ever. What the mode
//!   opens is what the user's own settings already open, and § The local agent in
//!   AGENTS.md names the risk it accepts.
//! - **The child never inherits the write token.** `TEAMS_LITE_WRITE_TOKEN` is the
//!   capability that makes `send` possible; an agent holding it could post to any
//!   chat directly, around every consent gate in this crate. It is removed from the
//!   child's environment. That is a floor, not a wall — a process running as the user
//!   can read the same 0600 file the backend publishes — but nothing we hand it makes
//!   posting easy.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::agent_policy::Backend;

/// The tools an agent may use unless the user widens the list. Read-only on purpose:
/// a message must not be able to write a file or run a command on the first day.
pub const DEFAULT_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];

/// One named group of tools the user can grant, or take back, in one action.
///
/// The allowlist itself stays a flat list of tool names ([`SETTING_TOOLS`]) — this is
/// how that list is *offered*, so the consent is a sentence the user can read ("it may
/// read Grafana") instead of thirty tool names they have to spell correctly.
#[derive(Debug, Clone, Copy)]
pub struct ToolGrant {
    /// Stable id, for a client that stores which switch it drew.
    pub key: &'static str,
    /// What the switch says.
    pub label: &'static str,
    /// One line of why, for the line under the switch.
    pub detail: &'static str,
    /// The tool names this grant adds to the allowlist.
    pub tools: &'static [&'static str],
}

/// What the user may grant the agent from a thread's own menu.
///
/// # Why a hand-written catalogue
///
/// The agent runs Claude Code, which loads the user's own MCP servers, so the tools it
/// *could* reach include every write those servers expose: `update_dashboard`,
/// `create_incident`, `save_issue`, `update_issue`, and `grafana_api_request` /
/// `execute_sentry_tool`, which are "call any endpoint" in a friendly shape. A grant
/// spelled `mcp__grafana` would hand over all of them at once.
///
/// So each grant names its tools one by one, and every one of them reads. Those systems
/// belong to the user's colleagues as much as to them — the same reason
/// `src/gitlab.rs` and `src/linear.rs` only ever issue reads — and a thread transcript
/// is untrusted text that travels with every prompt, so an agent holding a write is a
/// write anybody in the thread can aim. `every_granted_tool_reads` pins the shape:
/// three segments (never a whole server) and a verb that reads.
///
/// Adding a tool here is a deliberate edit, reviewed like the two modules above.
pub const TOOL_GRANTS: [ToolGrant; 4] = [
    ToolGrant {
        key: "files",
        label: "Read files",
        detail: "Open, list and search the files in its workspace.",
        tools: &["Read", "Glob", "Grep"],
    },
    ToolGrant {
        key: "grafana",
        label: "Read Grafana",
        detail: "Dashboards, Prometheus and Loki queries, incidents. No dashboard edit.",
        tools: &[
            // What exists, and whether it answers at all.
            "mcp__grafana__list_datasources",
            "mcp__grafana__get_datasource",
            "mcp__grafana__check_datasources_health",
            // Dashboards, as they are.
            "mcp__grafana__search_dashboards",
            "mcp__grafana__search_folders",
            "mcp__grafana__get_dashboard_by_uid",
            "mcp__grafana__get_dashboard_summary",
            "mcp__grafana__get_dashboard_property",
            "mcp__grafana__get_dashboard_panel_queries",
            "mcp__grafana__get_panel_image",
            "mcp__grafana__generate_deeplink",
            // Metrics: what a "is it up, how much memory" question is made of.
            "mcp__grafana__query_prometheus",
            "mcp__grafana__query_prometheus_histogram",
            "mcp__grafana__list_prometheus_metric_names",
            "mcp__grafana__list_prometheus_metric_metadata",
            "mcp__grafana__list_prometheus_label_names",
            "mcp__grafana__list_prometheus_label_values",
            // Logs.
            "mcp__grafana__query_loki_logs",
            "mcp__grafana__query_loki_stats",
            "mcp__grafana__query_loki_patterns",
            "mcp__grafana__list_loki_label_names",
            "mcp__grafana__list_loki_label_values",
            // Incidents as a record to read. Declaring one is not ours to do, and
            // neither is `find_error_pattern_logs` / `find_slow_requests`: both look
            // like reads and both create a Sift investigation in the org.
            "mcp__grafana__list_incidents",
            "mcp__grafana__get_incident",
        ],
    },
    ToolGrant {
        key: "sentry",
        label: "Read Sentry",
        detail: "Projects, issues and events. No issue edit, and no Seer run.",
        tools: &[
            "mcp__sentry__find_organizations",
            "mcp__sentry__find_projects",
            "mcp__sentry__search_issues",
            "mcp__sentry__search_events",
            "mcp__sentry__get_sentry_resource",
            "mcp__sentry__search_sentry_tools",
        ],
    },
    ToolGrant {
        key: "linear",
        label: "Read Linear",
        detail: "Issues, projects and comments. No issue, comment or status written.",
        tools: &[
            "mcp__linear__list_teams",
            "mcp__linear__list_users",
            "mcp__linear__list_projects",
            "mcp__linear__list_issues",
            "mcp__linear__list_issue_labels",
            "mcp__linear__list_issue_statuses",
            "mcp__linear__list_cycles",
            "mcp__linear__list_comments",
            "mcp__linear__list_documents",
            "mcp__linear__list_milestones",
            "mcp__linear__list_initiatives",
            "mcp__linear__get_issue",
            "mcp__linear__get_issue_status",
            "mcp__linear__get_project",
            "mcp__linear__get_team",
            "mcp__linear__get_user",
            "mcp__linear__get_document",
            "mcp__linear__get_milestone",
            "mcp__linear__get_initiative",
            "mcp__linear__search_documentation",
        ],
    },
];

/// The store key holding the tool allowlist, as a JSON array of tool names.
pub const SETTING_TOOLS: &str = "agent_tools";

/// The store key holding whether the agent runs on the user's own configuration
/// ([`Permissions::OwnConfig`]) instead of this app's allowlist. `"1"` is on; absent is
/// off, which is what a fresh store holds.
pub const SETTING_UNRESTRICTED: &str = "agent_unrestricted";

/// The store key holding the directory the agent runs in.
pub const SETTING_WORKSPACE: &str = "agent_workspace";

/// The store key prefix under which one conversation's agent session id lives, so a
/// follow-up question continues the same conversation with the model.
pub const SETTING_SESSION_PREFIX: &str = "agent_session:";

/// How long the CLI may say NOTHING AT ALL before the child is killed.
///
/// This is a liveness check, not a budget: a run that keeps emitting events — a token,
/// a tool starting, a tool finishing — lives as long as the work takes. A wall-clock cap
/// cannot tell a wedged CLI from a real piece of work, so it killed the second one to
/// catch the first: a question that needed forty minutes of tool calls was cut at ten,
/// mid-answer, and the thread got the failure of a run that was working.
///
/// The window is wide because silence is normal: one tool call can be a build or a test
/// suite, and the CLI reports nothing while it runs. What it must stay narrower than is
/// the patience of the person watching the message.
pub const RUN_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The backstop: how long one run may last however talkative it is.
///
/// [`RUN_IDLE_TIMEOUT`] catches a CLI that stopped; this catches one that never stops —
/// a loop that calls a tool, prints a token and calls it again would otherwise hold a
/// live run, and its marker, for as long as the machine is up. Hours rather than
/// minutes, because reaching it is a bug and not a long question.
pub const RUN_MAX_DURATION: Duration = Duration::from_secs(8 * 3600);

/// How much answer is kept in memory. A runaway CLI that prints megabytes gets
/// truncated here rather than in the store.
const MAX_ANSWER_BYTES: usize = 200 * 1024;

/// How much of the reasoning is kept.
///
/// It is the whole transcript that a reader scrolls, not a sample of it (see
/// [`Progress::steps`]), so this cap decides how far back they can look — which is why
/// it is generous where a one-line label needed almost nothing. The tail is what
/// survives: the beginning of an hour of reasoning is the part nobody reads.
const MAX_THINKING_BYTES: usize = 16 * 1024;

/// How many tool calls are remembered. They are all shown, oldest first, so this is
/// what keeps a run with a hundred greps from carrying a hundred rows; the count
/// ([`Progress::tools_used`]) survives the cap.
const MAX_TOOL_CALLS: usize = 32;

/// How long a tool's target may be before it is cut. It is a file path or a pattern
/// travelling into a one-line label, not a payload.
const MAX_TARGET_CHARS: usize = 120;

/// The environment variable holding the backend's write token — removed from the
/// child's environment. Spelled here rather than imported because `src/bin/server.rs`
/// is a binary, not a library, and one of the two copies drifting is caught by
/// `the_child_never_inherits_the_write_token` in that file.
const WRITE_TOKEN_ENV: &str = "TEAMS_LITE_WRITE_TOKEN";

/// What the child is allowed to do — the two states, spelled so they cannot disagree.
#[derive(Debug, Clone, PartialEq)]
pub enum Permissions {
    /// The allowlist this app decides, refusing everything else. One name per tool, and
    /// `--permission-mode default` under it, so a tool nobody granted is refused rather
    /// than prompted for. An empty list is a legitimate choice: an agent that only talks.
    Granted(Vec<String>),
    /// Whatever the user's own Claude Code configuration says — every MCP server, every
    /// tool, their own `permissions.defaultMode`. The same run their terminal gives them.
    ///
    /// The user asks for this on purpose (`agent_set_unrestricted`, off by default). It
    /// is not a wider default: it is this app standing aside, so what the child may do
    /// is exactly what the user already configured for themselves.
    OwnConfig,
}

/// What to run, and with what.
#[derive(Debug, Clone)]
pub struct Request {
    pub backend: &'static Backend,
    /// The user's prompt, with any thread context already folded in.
    pub prompt: String,
    /// Instructions about the room the answer lands in.
    pub system_prompt: String,
    /// The agent session to continue, when this thread already has one.
    pub resume_session: Option<String>,
    /// The directory the agent runs in.
    pub workspace: PathBuf,
    /// What it may do without being asked.
    pub permissions: Permissions,
    /// The model to run, when the user chose one for this backend. `None` leaves the
    /// choice to the CLI's own configuration, which is the default.
    pub model: Option<String>,
}

/// What an agent is doing right now, as coarsely as a label can say it.
///
/// Three states, because that is how many a reader can tell apart at a glance: the
/// model is thinking, a tool is running, or the answer is being written. The terminal
/// states (finished, failed) are not here — they belong to the run, not to its
/// progress, and `src/bin/server.rs` adds them from the [`Outcome`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Phase {
    /// Nothing has been said yet: the model was called, or it is reasoning.
    #[default]
    Thinking,
    /// A tool is running — see [`Progress::activity`].
    Working,
    /// The answer is arriving.
    Writing,
}

impl Phase {
    /// The wire spelling, which is also what a UI keys its label off.
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Thinking => "thinking",
            Phase::Working => "working",
            Phase::Writing => "writing",
        }
    }
}

/// One tool call, as it happens.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Activity {
    /// The tool's own name: "Read", "Grep", "read", "grep".
    pub tool: String,
    /// What it was pointed at — a path, a pattern, a query. Empty when the call's
    /// arguments have not arrived yet, or when the tool takes none.
    pub target: String,
    /// Whether it finished. A finished call stays in the progress on purpose: the
    /// last thing the agent did is worth showing while the next token is awaited.
    pub done: bool,
}

/// One entry of the run's transcript, in the order the CLI emitted it.
///
/// The order is the whole value of it: "I should read both rather than answer from
/// memory", then `Read src/bin/server.rs`, then what reading it led to. A list of
/// thoughts beside a list of calls says the same words and loses why each call happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A stretch of the model's reasoning, as it emitted it.
    Thought(String),
    /// A tool call, in the state it was last reported in.
    Tool(Activity),
}

/// The answer as it stands, and what the agent is doing to grow it.
///
/// The whole state, not a delta: this rides a [`watch`] channel where only the latest
/// value survives, so every value has to stand on its own.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    /// The answer so far, as the Markdown the CLI emitted.
    pub text: String,
    /// How the answer was arrived at: the model's reasoning and the tool calls,
    /// interleaved in the order they happened, bounded by [`MAX_THINKING_BYTES`] and
    /// [`MAX_TOOL_CALLS`].
    ///
    /// Claude Code reports reasoning when extended thinking is on; opencode does not,
    /// so on that backend the transcript is the tool calls alone.
    pub steps: Vec<Step>,
    /// The tool call in flight, or the last one that ran. It is the newest [`Step::Tool`]
    /// of the transcript, kept apart because it is what the run is doing NOW: the phase
    /// is derived from it, and a UI names it while the reader waits.
    pub activity: Option<Activity>,
    /// How many tool calls the run has made — the count survives [`MAX_TOOL_CALLS`].
    pub tools_used: usize,
}

impl Progress {
    /// The model's reasoning, the thoughts of the transcript joined back together.
    /// Derived rather than carried, so there is one record of what the model said.
    pub fn thinking(&self) -> String {
        self.steps
            .iter()
            .filter_map(|step| match step {
                Step::Thought(text) => Some(text.as_str()),
                Step::Tool(_) => None,
            })
            .collect()
    }
}

/// What one run produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    /// The answer, authoritative: the CLI's own final text when it reports one.
    pub text: String,
    /// The agent session, to store against the thread for the next question.
    pub session_id: Option<String>,
    /// What the run cost in US dollars, when the CLI reports it. For the log line
    /// only — a price never goes into a Teams message.
    pub cost_usd: Option<f64>,
}

/// Whether this machine can run the given backend at all (the program is on `PATH`).
pub fn is_available(backend: &Backend) -> bool {
    program_path(backend).is_some()
}

/// Where this machine's copy of a backend's CLI sits, when it has one.
///
/// Public because a CLI that is not on `PATH` is the one failure this feature cannot
/// report in the thread: the trigger is dropped before anything is posted, so the
/// answer has to be in the log an operator reads. The startup line in
/// `src/bin/server.rs` prints this, and the path it prints is what says whether the
/// process inherited the user's own bin directories.
pub fn program_path(backend: &Backend) -> Option<PathBuf> {
    which_program(backend.program)
}

/// Resolve a program on `PATH` without spawning a shell.
fn which_program(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

/// Run the agent, reporting the answer-so-far on `progress`.
///
/// Returns when the child exits. It fails with the child killed when the CLI goes
/// silent for [`RUN_IDLE_TIMEOUT`], or when the whole run passes [`RUN_MAX_DURATION`].
/// A non-zero exit with no answer at all is an error carrying the tail of stderr,
/// because "the agent said nothing" is not something to post to a channel.
///
/// A run that was resuming a stored session is retried ONCE from scratch when it
/// fails. Sessions expire and CLI state gets cleared, and the failure looks exactly
/// like a broken feature: every follow-up in a thread refuses, forever, because of an
/// id nobody can see. Starting fresh loses the context and answers the question.
pub async fn run(request: &Request, progress: &watch::Sender<Progress>) -> Result<Outcome> {
    let first = run_once(request, progress).await;
    let Err(error) = first else {
        return first;
    };
    let Some(session) = &request.resume_session else {
        return Err(error);
    };
    eprintln!(
        "[agent] {} could not resume session {session} ({error}) — starting a fresh one",
        request.backend.name
    );
    let mut fresh = request.clone();
    fresh.resume_session = None;
    run_once(&fresh, progress).await
}

async fn run_once(request: &Request, progress: &watch::Sender<Progress>) -> Result<Outcome> {
    let program = which_program(request.backend.program).with_context(|| {
        format!("`{}` is not on PATH — this machine cannot run it", request.backend.program)
    })?;
    std::fs::create_dir_all(&request.workspace)
        .with_context(|| format!("create the agent workspace {}", request.workspace.display()))?;

    let mut command = Command::new(program);
    let stdin_prompt = build_command(&mut command, request);
    command
        .current_dir(&request.workspace)
        .env_remove(WRITE_TOKEN_ENV)
        .stdin(if stdin_prompt.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .with_context(|| format!("start {}", request.backend.program))?;

    if let (Some(text), Some(mut stdin)) = (stdin_prompt, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).await.context("write the prompt to the agent")?;
        stdin.shutdown().await.ok();
    }

    let stdout = child.stdout.take().context("the agent has no stdout")?;
    let stderr = child.stderr.take().context("the agent has no stderr")?;
    let stderr_tail = tokio::spawn(read_tail(stderr));

    let harvest = harvest(request.backend, stdout, RUN_IDLE_TIMEOUT, progress);
    let outcome = match tokio::time::timeout(RUN_MAX_DURATION, harvest).await {
        Ok(result) => result?,
        Err(_) => {
            child.kill().await.ok();
            anyhow::bail!(
                "{} ran for {} hours and was stopped",
                request.backend.name,
                RUN_MAX_DURATION.as_secs() / 3600
            );
        }
    };
    let status = child.wait().await.context("wait for the agent")?;
    let stderr_tail = stderr_tail.await.unwrap_or_default();

    if outcome.text.trim().is_empty() {
        let reason = if stderr_tail.is_empty() {
            format!("{} exited {} without saying anything", request.backend.name, status)
        } else {
            format!("{} said nothing ({stderr_tail})", request.backend.name)
        };
        anyhow::bail!(reason);
    }
    Ok(outcome)
}

/// Whether THIS APP can say "no tools" on that backend's command line at all.
///
/// It is not a claim about a vendor's trustworthiness — it is a claim about
/// [`build_command`], and only about what the arm below it spells. `claude` consults
/// [`Request::permissions`]: an empty [`Permissions::Granted`] skips `--allowed-tools`
/// while still passing `--permission-mode default`, so any tool the model reaches for is
/// prompted, there is no terminal to answer the prompt, and it is refused. The other arm
/// consults `permissions` not at all, so its CLI runs with whatever tool set its own
/// configuration gives it and this app cannot narrow that from here.
///
/// A caller that NEEDS the empty allowlist honoured (the task scan, whose prompt is a
/// colleague's words) asks this first and refuses to run rather than running a child it
/// cannot bound. `an_empty_allowlist_is_only_claimed_where_the_command_line_states_it`
/// keeps this from drifting away from `build_command` when a backend is added — and if
/// opencode ever grows a tool-restriction flag, this is the one place that changes.
pub fn enforces_empty_allowlist(backend: &Backend) -> bool {
    // The same arms `build_command` matches on, and deliberately no wider.
    matches!(backend.name, "claude")
}

/// Spell the command line for one backend, returning the prompt to write on stdin
/// when that backend reads it there.
///
/// Split out of [`run`] so both spellings are unit-tested without a child process:
/// the flags are the security boundary (permission mode, tool allowlist), and a
/// silent typo in one of them is a tool grant nobody notices.
fn build_command(command: &mut Command, request: &Request) -> Option<String> {
    match request.backend.name {
        // Claude Code: the prompt on stdin (no argv limit, no quoting), the answer as
        // a JSON event stream with per-token deltas.
        "claude" => {
            command.args([
                "-p",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
            ]);
            match &request.permissions {
                // The allowlist this app decides. `default` is the mode that refuses
                // what the list does not name — and this crate never spells an
                // escalation, whatever the user's own settings default to.
                Permissions::Granted(tools) => {
                    command.args(["--permission-mode", "default"]);
                    if !tools.is_empty() {
                        command.arg("--allowed-tools").args(tools);
                    }
                }
                // NEITHER flag: the CLI then resolves the tools and the permission mode
                // from the user's own configuration, which is what makes this the run
                // their terminal gives them. Passing `bypassPermissions` here instead
                // would be this app deciding, and it would keep deciding after the user
                // changed their mind in `~/.claude/settings.json`.
                Permissions::OwnConfig => {}
            }
            command.arg("--append-system-prompt").arg(&request.system_prompt);
            if let Some(model) = model_of(request) {
                command.arg("--model").arg(model);
            }
            if let Some(session) = &request.resume_session {
                command.arg("--resume").arg(session);
            }
            Some(request.prompt.clone())
        }
        // opencode: the message as arguments, and no --append-system-prompt, so the
        // instructions ride at the top of the message. No --auto in either mode: that
        // flag is opencode's own escalation, not a setting the user already made, so
        // spelling it here would be this app deciding. `Permissions::OwnConfig` is
        // therefore a Claude Code setting, and the menu says so.
        _ => {
            command.args(["run", "--format", "json"]);
            command.arg("--dir").arg(&request.workspace);
            if let Some(model) = model_of(request) {
                command.arg("--model").arg(model);
            }
            if let Some(session) = &request.resume_session {
                command.arg("--session").arg(session);
            }
            command.arg("--");
            command.arg(format!("{}\n\n{}", request.system_prompt, request.prompt));
            None
        }
    }
}

/// The model to put on the command line, or `None` to leave the CLI its own default.
///
/// The shape is re-checked here rather than trusted from the store: this is the last
/// point before the value becomes an argument, and a name that could pass for a flag
/// must never get there (see [`agent_policy::is_valid_model`]).
fn model_of(request: &Request) -> Option<&str> {
    request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| crate::agent_policy::is_valid_model(model))
}

/// Read the child's JSON event stream, updating `progress` as the answer grows.
///
/// Fails when `idle` passes with no line at all: the wait is per LINE rather than over
/// the whole run, so the deadline moves forward on every event the CLI emits and only a
/// CLI that stopped talking hits it (see [`RUN_IDLE_TIMEOUT`]).
///
/// Generic over the reader so a test can drive it with a pipe: the idle rule is the one
/// thing here that decides whether a run lives, and a rule nothing can exercise without
/// a child process is a rule nobody checks.
async fn harvest<R>(
    backend: &Backend,
    stdout: R,
    idle: Duration,
    progress: &watch::Sender<Progress>,
) -> Result<Outcome>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stdout).lines();
    let mut answer = Answer::default();
    let mut outcome = Outcome::default();
    let mut last_sent = Progress::default();

    while let Some(line) = next_line_before(&mut lines, idle, backend).await? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue; // a log line, a banner: not our business
        };
        for update in updates_from(backend, &event) {
            match update {
                Update::Session(id) => outcome.session_id = Some(id),
                Update::Cost(cost) => outcome.cost_usd = Some(cost),
                Update::Final(text) => outcome.text = text,
                other => answer.apply(other),
            }
        }
        let current = answer.progress();
        if current != last_sent {
            last_sent = current.clone();
            // A closed receiver is normal: the consumer stops watching once it has
            // posted the final edit. The run still finishes, so the store learns the
            // session id.
            let _ = progress.send(current);
        }
    }
    // The CLI's own final text wins when it reports one; the streamed pieces are what
    // we have otherwise (and are all opencode ever gives us).
    if outcome.text.trim().is_empty() {
        outcome.text = answer.text();
    }
    Ok(outcome)
}

/// The next line of the child's output, or an error when `idle` passes without one.
///
/// The message names the silence rather than a budget, because that is what the reader
/// of the thread has to act on: the CLI stopped, and asking again is the way out.
async fn next_line_before<R>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
    idle: Duration,
    backend: &Backend,
) -> Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    match tokio::time::timeout(idle, lines.next_line()).await {
        Ok(line) => line.context("read the agent's output"),
        Err(_) => anyhow::bail!(
            "{} said nothing for {} minutes and was stopped",
            backend.name,
            idle.as_secs() / 60
        ),
    }
}

/// One thing an event tells us.
#[derive(Debug, Clone, PartialEq)]
enum Update {
    /// The agent session id, to continue this thread next time.
    Session(String),
    /// Start a new paragraph before the next appended text.
    Break,
    /// More text for the paragraph being written.
    Append(String),
    /// The whole text of an identified part, which may arrive several times as it
    /// grows (opencode reports parts, not deltas).
    Part { key: String, text: String },
    /// More of the model's reasoning.
    Thinking(String),
    /// A tool call started, or a running one was described more fully. `target` is
    /// empty while the arguments are still arriving.
    Tool { id: String, name: String, target: String },
    /// A tool call finished.
    ToolDone { id: String },
    /// More of the open tool call's arguments, as the partial JSON Claude Code
    /// streams. Applies to the call that started most recently.
    ToolArgs(String),
    /// The CLI's authoritative final answer.
    Final(String),
    /// What the run cost.
    Cost(f64),
}

/// Read one JSON event from a backend into zero or more [`Update`]s.
///
/// Shapes confirmed against the installed CLIs (Claude Code 2.1.220, opencode
/// 1.18.3) rather than guessed; the tests below pin a real line from each.
fn updates_from(backend: &Backend, event: &Value) -> Vec<Update> {
    let mut updates = Vec::new();
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    match backend.name {
        "claude" => {
            if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                updates.push(Update::Session(id.to_string()));
            }
            match kind {
                "stream_event" => {
                    let inner = event.get("event").unwrap_or(&Value::Null);
                    match inner.get("type").and_then(Value::as_str).unwrap_or("") {
                        "content_block_start" => {
                            let block = inner.get("content_block").unwrap_or(&Value::Null);
                            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                                // A new text block, or a new assistant turn after a
                                // tool call: what follows is a new paragraph.
                                "text" => updates.push(Update::Break),
                                // A tool call, named the moment it starts. Its
                                // arguments follow as partial JSON, so the target is
                                // still unknown here — and "Read" alone already says
                                // more than a spinner does.
                                "tool_use" => updates.push(Update::Tool {
                                    id: block
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                    name: block
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                    target: String::new(),
                                }),
                                _ => {}
                            }
                        }
                        "content_block_delta" => {
                            let delta = inner.get("delta").unwrap_or(&Value::Null);
                            match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                                "text_delta" => {
                                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                                        updates.push(Update::Append(text.to_string()));
                                    }
                                }
                                "thinking_delta" => {
                                    if let Some(text) =
                                        delta.get("thinking").and_then(Value::as_str)
                                    {
                                        updates.push(Update::Thinking(text.to_string()));
                                    }
                                }
                                "input_json_delta" => {
                                    if let Some(json) =
                                        delta.get("partial_json").and_then(Value::as_str)
                                    {
                                        updates.push(Update::ToolArgs(json.to_string()));
                                    }
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                // The complete assistant turn, which arrives after its deltas: a
                // tool_use block here carries the WHOLE input, so it names the target
                // even when the streamed partial JSON never parsed.
                "assistant" => {
                    for block in message_content(event) {
                        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                            continue;
                        }
                        updates.push(Update::Tool {
                            id: block.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            target: target_from_input(block.get("input").unwrap_or(&Value::Null)),
                        });
                    }
                }
                // A tool's result comes back as a user turn — which is how a run says
                // the call it was making has finished.
                "user" => {
                    for block in message_content(event) {
                        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                            updates.push(Update::ToolDone { id: id.to_string() });
                        }
                    }
                }
                "result" => {
                    if let Some(text) = event.get("result").and_then(Value::as_str) {
                        updates.push(Update::Final(text.to_string()));
                    }
                    if let Some(cost) = event.get("total_cost_usd").and_then(Value::as_f64) {
                        updates.push(Update::Cost(cost));
                    }
                }
                _ => {}
            }
        }
        _ => {
            if let Some(id) = event.get("sessionID").and_then(Value::as_str) {
                updates.push(Update::Session(id.to_string()));
            }
            let part = event.get("part").unwrap_or(&Value::Null);
            match kind {
                "text" => {
                    if let (Some(key), Some(text)) = (
                        part.get("id").and_then(Value::as_str),
                        part.get("text").and_then(Value::as_str),
                    ) {
                        updates.push(Update::Part { key: key.to_string(), text: text.to_string() });
                    }
                }
                // opencode reports a tool call as one part carrying its whole state,
                // re-sent as that state changes — so the status field, not the event,
                // is what says whether the call is still running.
                "tool_use" => {
                    let id = part
                        .get("callID")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    updates.push(Update::Tool {
                        id: id.clone(),
                        name: part.get("tool").and_then(Value::as_str).unwrap_or_default().to_string(),
                        target: target_from_input(
                            part.pointer("/state/input").unwrap_or(&Value::Null),
                        ),
                    });
                    let status = part.pointer("/state/status").and_then(Value::as_str).unwrap_or("");
                    if matches!(status, "completed" | "error") {
                        updates.push(Update::ToolDone { id });
                    }
                }
                // A reasoning part, when the model behind opencode emits one.
                "reasoning" => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        updates.push(Update::Thinking(text.to_string()));
                    }
                }
                "step_finish" => {
                    if let Some(cost) = part.get("cost").and_then(Value::as_f64) {
                        updates.push(Update::Cost(cost));
                    }
                }
                _ => {}
            }
        }
    }
    updates
}

/// The content blocks of a Claude Code `assistant`/`user` event, or nothing.
fn message_content(event: &Value) -> &[Value] {
    event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// What a tool call was pointed at, read out of its arguments.
///
/// A tool's own schema names the interesting argument differently every time
/// (`file_path` for Claude Code's Read, `filePath` for opencode's read, `pattern` for
/// a grep), and no CLI reports "the target" as such. So the first key that carries a
/// human-readable subject wins, in the order a reader would care about, and anything
/// unrecognised yields nothing rather than a guess: an empty target renders as the
/// tool's name alone, which is honest.
fn target_from_input(input: &Value) -> String {
    const KEYS: [&str; 9] = [
        "file_path",
        "filePath",
        "notebook_path",
        "path",
        "pattern",
        "query",
        "url",
        "command",
        "description",
    ];
    let Some(object) = input.as_object() else {
        return String::new();
    };
    for key in KEYS {
        let Some(value) = object.get(key).and_then(Value::as_str) else {
            continue;
        };
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() {
            continue;
        }
        return value.chars().take(MAX_TARGET_CHARS).collect();
    }
    String::new()
}

/// The answer as it is being written: a list of paragraphs, each either appended to
/// (a delta stream) or replaced wholesale (a part that grew) — plus the reasoning and
/// the tool calls that went into it.
///
/// One structure for both backends, because the difference between "append a token"
/// and "here is the part again, longer" is not worth two accumulators.
#[derive(Debug, Default)]
struct Answer {
    parts: Vec<(String, String)>,
    /// Whether the next [`Update::Append`] opens a new paragraph.
    pending_break: bool,
    /// The reasoning and the tool calls, in the order they happened — what
    /// [`Progress::steps`] is built from. Bounded on both halves: the reasoning keeps
    /// its tail ([`MAX_THINKING_BYTES`]), the calls their newest [`MAX_TOOL_CALLS`].
    entries: Vec<Entry>,
    /// Every tool call ever made, including the ones the cap dropped.
    calls_seen: usize,
}

/// One entry of that transcript. The private half of [`Step`]: a call is tracked here
/// while it runs, and only the part a reader needs is published.
#[derive(Debug)]
enum Entry {
    /// A stretch of reasoning, appended to while it is the newest entry.
    Thought(String),
    Call(Call),
}

/// One tool call being tracked while it runs.
#[derive(Debug, Default)]
struct Call {
    id: String,
    name: String,
    target: String,
    /// The streamed arguments, accumulated until they parse (Claude Code sends them
    /// as partial JSON, one fragment at a time).
    args: String,
    done: bool,
}

impl Answer {
    fn apply(&mut self, update: Update) {
        match update {
            Update::Break => self.pending_break = true,
            Update::Append(text) => {
                let open = match self.parts.last_mut() {
                    Some((key, existing)) if key.is_empty() && !self.pending_break => Some(existing),
                    _ => None,
                };
                match open {
                    Some(existing) => existing.push_str(&text),
                    None => self.parts.push((String::new(), text)),
                }
                self.pending_break = false;
            }
            Update::Part { key, text } => match self.parts.iter_mut().find(|(k, _)| *k == key) {
                Some((_, existing)) => *existing = text,
                None => self.parts.push((key, text)),
            },
            // Reasoning grows the newest thought when it is still the newest entry, and
            // opens a new one after a tool call — which is what puts the reasoning that
            // FOLLOWED a call after it in the transcript rather than back with the
            // reasoning that led to it.
            Update::Thinking(text) => {
                match self.entries.last_mut() {
                    Some(Entry::Thought(thought)) => thought.push_str(&text),
                    _ => self.entries.push(Entry::Thought(text)),
                }
                self.keep_thinking_tail();
            }
            // A call is upserted by id: it is announced when it starts (with no
            // target), described again when the whole turn arrives (with one), and a
            // later, fuller description must never lose what the first one said.
            Update::Tool { id, name, target } => match self.call_mut(&id) {
                Some(call) => {
                    if !name.is_empty() {
                        call.name = name;
                    }
                    if !target.is_empty() {
                        call.target = target;
                    }
                }
                None => {
                    self.entries.push(Entry::Call(Call { id, name, target, ..Call::default() }));
                    self.calls_seen += 1;
                    self.keep_newest_calls();
                }
            },
            Update::ToolArgs(json) => {
                let Some(call) = self.last_call_mut() else {
                    return;
                };
                call.args.push_str(&json);
                // The arguments are only useful once they are a whole JSON object, so
                // every fragment re-tries the parse and the last one wins. A call
                // whose arguments never complete keeps the target it already had.
                if let Ok(input) = serde_json::from_str::<Value>(&call.args) {
                    let target = target_from_input(&input);
                    if !target.is_empty() {
                        call.target = target;
                    }
                }
            }
            Update::ToolDone { id } => {
                if let Some(call) = self.call_mut(&id) {
                    call.done = true;
                }
            }
            // Handled by the caller; listed so a new variant cannot be forgotten here.
            Update::Session(_) | Update::Final(_) | Update::Cost(_) => {}
        }
    }

    fn call_mut(&mut self, id: &str) -> Option<&mut Call> {
        self.calls_mut().find(|call| call.id == id)
    }

    /// The call the streamed arguments belong to: the newest one, since Claude Code
    /// sends a call's arguments right after announcing it.
    fn last_call_mut(&mut self) -> Option<&mut Call> {
        self.calls_mut().next_back()
    }

    fn calls_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut Call> {
        self.entries.iter_mut().filter_map(|entry| match entry {
            Entry::Call(call) => Some(call),
            Entry::Thought(_) => None,
        })
    }

    /// Drop the oldest reasoning until the transcript holds no more than
    /// [`MAX_THINKING_BYTES`] of it. A thought emptied by the cut goes with it, so an
    /// exhausted entry never draws a blank line.
    fn keep_thinking_tail(&mut self) {
        let mut over = self
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Thought(text) => text.len(),
                Entry::Call(_) => 0,
            })
            .sum::<usize>()
            .saturating_sub(MAX_THINKING_BYTES);
        if over == 0 {
            return;
        }
        for entry in self.entries.iter_mut() {
            if over == 0 {
                break;
            }
            if let Entry::Thought(text) = entry {
                let dropped = text.len().min(over);
                keep_tail(text, text.len() - dropped);
                over -= dropped;
            }
        }
        self.entries
            .retain(|entry| !matches!(entry, Entry::Thought(text) if text.is_empty()));
    }

    /// Drop the oldest tool calls until no more than [`MAX_TOOL_CALLS`] are left. The
    /// reasoning around a dropped call stays: the two are capped apart, because a long
    /// run is long for one reason or the other and losing both would be a double cut.
    fn keep_newest_calls(&mut self) {
        let mut over = self
            .entries
            .iter()
            .filter(|entry| matches!(entry, Entry::Call(_)))
            .count()
            .saturating_sub(MAX_TOOL_CALLS);
        if over == 0 {
            return;
        }
        self.entries.retain(|entry| match entry {
            Entry::Call(_) if over > 0 => {
                over -= 1;
                false
            }
            _ => true,
        });
    }

    fn text(&self) -> String {
        let mut text = self
            .parts
            .iter()
            .map(|(_, part)| part.trim())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if text.len() > MAX_ANSWER_BYTES {
            let mut cut = MAX_ANSWER_BYTES;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        text
    }

    /// The whole state, as a consumer sees it.
    ///
    /// The phase is derived rather than tracked, so it can never disagree with what
    /// the run actually holds: a tool in flight beats everything (it is what the wait
    /// is FOR), then an answer that has started arriving, then reasoning.
    fn progress(&self) -> Progress {
        let text = self.text();
        let steps = self
            .entries
            .iter()
            .map(|entry| match entry {
                Entry::Thought(thought) => Step::Thought(thought.clone()),
                Entry::Call(call) => Step::Tool(Activity {
                    tool: call.name.clone(),
                    target: call.target.clone(),
                    done: call.done,
                }),
            })
            .collect::<Vec<_>>();
        let activity = steps.iter().rev().find_map(|step| match step {
            Step::Tool(activity) => Some(activity.clone()),
            Step::Thought(_) => None,
        });
        let phase = match &activity {
            Some(activity) if !activity.done => Phase::Working,
            _ if !text.is_empty() => Phase::Writing,
            _ => Phase::Thinking,
        };
        Progress { phase, text, steps, activity, tools_used: self.calls_seen }
    }
}

/// Drop the beginning of `text` until it fits `max` bytes, on a character boundary.
/// The tail is what is worth keeping: it is the latest thing the model said.
fn keep_tail(text: &mut String, max: usize) {
    if text.len() <= max {
        return;
    }
    let mut cut = text.len() - max;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    text.drain(..cut);
}

/// Keep the last few hundred bytes of a stream, for an error message.
async fn read_tail<R: tokio::io::AsyncRead + Unpin>(stream: R) -> String {
    const MAX: usize = 400;
    let mut lines = BufReader::new(stream).lines();
    let mut tail = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        tail = line.to_string();
    }
    if tail.chars().count() > MAX {
        tail = tail.chars().take(MAX).collect();
    }
    tail
}

/// The default workspace: a directory of its own, never the checkout.
///
/// An agent summoned from a phone should not start out sitting in a git repository it
/// can change. The user points it somewhere else on purpose, through
/// [`SETTING_WORKSPACE`].
pub fn default_workspace() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("teams-lite/agent-workspace")
}

/// Parse the stored tool allowlist, falling back to [`DEFAULT_TOOLS`].
///
/// A stored empty list is honoured (an agent with no tools at all is a legitimate
/// choice); only an absent or unreadable setting falls back.
pub fn tools_from_setting(setting: Option<&str>) -> Vec<String> {
    let parsed = setting
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok());
    match parsed {
        Some(tools) => tools
            .into_iter()
            .map(|tool| tool.trim().to_string())
            .filter(|tool| !tool.is_empty())
            .collect(),
        None => DEFAULT_TOOLS.iter().map(|t| t.to_string()).collect(),
    }
}

/// Whether the user asked for the run their own configuration describes. Off unless the
/// setting says `"1"`: anything unreadable means the app keeps deciding, which is the
/// safe direction for a switch that hands over a machine.
pub fn unrestricted_from_setting(setting: Option<&str>) -> bool {
    setting.map(str::trim) == Some("1")
}

/// What the child may do, from the two settings that decide it.
///
/// One place, so the precedence is stated once: the user's own configuration wins when
/// they asked for it, and the stored allowlist is what applies otherwise. A caller that
/// reads both settings and combines them itself is a second answer waiting to drift.
pub fn permissions_from_settings(tools: Option<&str>, unrestricted: Option<&str>) -> Permissions {
    if unrestricted_from_setting(unrestricted) {
        return Permissions::OwnConfig;
    }
    Permissions::Granted(tools_from_setting(tools))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_policy::{BACKENDS, Catalogue};

    const CLAUDE: &Backend = &BACKENDS[0];
    const OPENCODE: &Backend = &BACKENDS[1];

    fn request(backend: &'static Backend) -> Request {
        Request {
            backend,
            prompt: "what is the port?".into(),
            system_prompt: "answer for a chat".into(),
            resume_session: None,
            workspace: PathBuf::from("/tmp/agent-workspace"),
            permissions: Permissions::Granted(vec!["Read".into(), "Grep".into()]),
            model: None,
        }
    }

    /// The argv a spelling produces, as strings, so a flag can be asserted on.
    fn argv(request: &Request) -> (Vec<String>, Option<String>) {
        let mut command = Command::new("/bin/true");
        let stdin = build_command(&mut command, request);
        let args = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        (args, stdin)
    }

    #[test]
    fn claude_runs_headless_streaming_and_never_bypasses_permissions() {
        let (args, stdin) = argv(&request(CLAUDE));
        assert_eq!(stdin.as_deref(), Some("what is the port?"));
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        // The security boundary: an explicit mode, and never the bypass.
        let mode = args.iter().position(|a| a == "--permission-mode").expect("a permission mode");
        assert_eq!(args[mode + 1], "default");
        assert!(!args.iter().any(|a| a.contains("bypassPermissions")));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
    }

    #[test]
    fn claude_passes_the_tool_allowlist_and_the_system_prompt() {
        let (args, _) = argv(&request(CLAUDE));
        let allowed = args.iter().position(|a| a == "--allowed-tools").expect("an allowlist");
        assert_eq!(&args[allowed + 1..allowed + 3], ["Read", "Grep"]);
        let system = args.iter().position(|a| a == "--append-system-prompt").expect("a prompt");
        assert_eq!(args[system + 1], "answer for a chat");
    }

    #[test]
    fn an_agent_with_no_tools_passes_no_allowlist_flag() {
        let mut request = request(CLAUDE);
        request.permissions = Permissions::Granted(Vec::new());
        let (args, _) = argv(&request);
        assert!(!args.contains(&"--allowed-tools".to_string()));
    }

    /// `enforces_empty_allowlist` must agree with what `build_command` really spells, per
    /// backend — a caller that trusts it refuses to run rather than running a child whose
    /// tools this app cannot narrow. A backend added without touching either half is
    /// caught here rather than by a scan quietly holding every tool its CLI defaults to.
    #[test]
    fn an_empty_allowlist_is_only_claimed_where_the_command_line_states_it() {
        for backend in &BACKENDS {
            let mut request = request(backend);
            request.permissions = Permissions::Granted(Vec::new());
            let (args, _) = argv(&request);
            let names_the_mode = args
                .iter()
                .position(|a| a == "--permission-mode")
                .is_some_and(|at| args.get(at + 1).map(String::as_str) == Some("default"));
            assert!(
                !args.contains(&"--allowed-tools".to_string()),
                "{}: an empty allowlist must pass no list at all: {args:?}",
                backend.name
            );
            assert_eq!(
                enforces_empty_allowlist(backend),
                names_the_mode,
                "{} claims to honour an empty allowlist without naming a permission mode \
                 that refuses what the list does not: {args:?}",
                backend.name
            );
        }
    }

    /// The run the user's own terminal gives them: this app names neither the tools nor
    /// the mode, so the CLI reads both from `~/.claude/settings.json` and the MCP servers
    /// configured there. Passing `bypassPermissions` instead would look the same today
    /// and stop matching the moment the user changed their own settings.
    ///
    /// Verified against Claude Code 2.1.220 with the user's own configuration
    /// (`permissions.defaultMode: bypassPermissions`): `claude -p` with neither flag ran
    /// a Bash command and reported no permission denial.
    #[test]
    fn the_users_own_configuration_names_neither_the_tools_nor_the_mode() {
        let mut request = request(CLAUDE);
        request.permissions = Permissions::OwnConfig;
        let (args, stdin) = argv(&request);
        assert!(!args.contains(&"--allowed-tools".to_string()), "{args:?}");
        assert!(!args.contains(&"--permission-mode".to_string()), "{args:?}");
        // Everything else is unchanged: still headless, still streaming, and the system
        // prompt that quarantines the thread transcript still rides along.
        assert_eq!(stdin.as_deref(), Some("what is the port?"));
        assert!(args.contains(&"stream-json".to_string()));
        let system = args.iter().position(|a| a == "--append-system-prompt").expect("a prompt");
        assert_eq!(args[system + 1], "answer for a chat");
    }

    /// The floor that holds in BOTH modes: this crate never spells an escalation. What
    /// `OwnConfig` opens is what the user's own settings open — never something this app
    /// added on top, and never something their settings cannot take back.
    #[test]
    fn no_mode_ever_spells_an_escalation() {
        for permissions in [
            Permissions::Granted(vec!["Read".into()]),
            Permissions::Granted(Vec::new()),
            Permissions::OwnConfig,
        ] {
            for backend in [CLAUDE, OPENCODE] {
                let mut request = request(backend);
                request.permissions = permissions.clone();
                let (args, _) = argv(&request);
                for forbidden in ["bypassPermissions", "acceptEdits", "dangerously", "--auto"] {
                    assert!(
                        !args.iter().any(|a| a.contains(forbidden)),
                        "{} must never pass {forbidden}: {args:?}",
                        backend.name
                    );
                }
            }
        }
    }

    #[test]
    fn the_unrestricted_setting_is_off_unless_it_says_one() {
        assert_eq!(
            permissions_from_settings(None, None),
            Permissions::Granted(DEFAULT_TOOLS.iter().map(|t| t.to_string()).collect())
        );
        // Only "1" is on. A typo, an empty value or an older spelling leaves this app
        // deciding, because that is the direction a failure must fall in.
        for off in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
            assert!(!unrestricted_from_setting(off), "{off:?} must not switch it on");
        }
        assert!(unrestricted_from_setting(Some("1")));
        assert!(unrestricted_from_setting(Some(" 1 ")));
        // And when it is on, the stored allowlist stops applying — the two settings can
        // never half-apply.
        assert_eq!(
            permissions_from_settings(Some(r#"["Read"]"#), Some("1")),
            Permissions::OwnConfig
        );
    }

    #[test]
    fn a_chosen_model_reaches_both_clis_and_a_refused_one_reaches_neither() {
        for backend in [CLAUDE, OPENCODE] {
            let mut request = request(backend);
            request.model = Some("opus".into());
            let (args, _) = argv(&request);
            let at = args.iter().position(|a| a == "--model").expect("a model flag");
            assert_eq!(args[at + 1], "opus", "{}", backend.name);

            // No choice is the default: the CLI keeps its own configured model.
            request.model = None;
            let (args, _) = argv(&request);
            assert!(!args.contains(&"--model".to_string()), "{}", backend.name);

            // A stored value that could pass for a flag never becomes one, even if it
            // somehow got past the RPC that stored it.
            request.model = Some("--dangerously-skip-permissions".into());
            let (args, _) = argv(&request);
            assert!(!args.contains(&"--model".to_string()), "{}", backend.name);
            assert!(!args.iter().any(|a| a.contains("dangerously")), "{}", backend.name);
        }
    }

    #[test]
    fn a_follow_up_resumes_the_threads_session() {
        let mut request = request(CLAUDE);
        request.resume_session = Some("c1f31051".into());
        let (args, _) = argv(&request);
        let resume = args.iter().position(|a| a == "--resume").expect("a resume flag");
        assert_eq!(args[resume + 1], "c1f31051");

        let mut request = request.clone();
        request.backend = OPENCODE;
        request.resume_session = Some("ses_0378f913".into());
        let (args, _) = argv(&request);
        let session = args.iter().position(|a| a == "--session").expect("a session flag");
        assert_eq!(args[session + 1], "ses_0378f913");
    }

    #[test]
    fn opencode_runs_in_json_mode_and_never_auto_approves() {
        let (args, stdin) = argv(&request(OPENCODE));
        assert!(stdin.is_none(), "opencode takes the message as an argument");
        assert_eq!(&args[..3], ["run", "--format", "json"]);
        assert!(args.contains(&"--dir".to_string()));
        assert!(!args.contains(&"--auto".to_string()));
        // No --append-system-prompt exists there, so the instructions ride along.
        let message = args.last().expect("a message");
        assert!(message.starts_with("answer for a chat"));
        assert!(message.ends_with("what is the port?"));
    }

    #[test]
    fn the_prompt_is_never_run_through_a_shell() {
        // A prompt is untrusted text. It must reach the CLI as one argument (or on
        // stdin), never as something a shell parses.
        let mut request = request(OPENCODE);
        request.prompt = "$(rm -rf ~) && echo `whoami`".into();
        let (args, _) = argv(&request);
        assert_eq!(args.iter().filter(|a| a.contains("rm -rf")).count(), 1);
    }

    /// A real line from `claude -p --output-format stream-json --include-partial-messages`.
    const CLAUDE_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ello"}},"session_id":"c1f31051"}"#;
    /// A real line from `opencode run --format json`.
    const OPENCODE_TEXT: &str = r#"{"type":"text","timestamp":1785774254040,"sessionID":"ses_0378f913","part":{"id":"prt_fc870a6b","messageID":"msg_fc8707e6","type":"text","text":"hello from opencode"}}"#;

    fn apply_line(backend: &'static Backend, line: &str, answer: &mut Answer) -> Vec<Update> {
        let event: Value = serde_json::from_str(line).expect("valid JSON");
        let updates = updates_from(backend, &event);
        for update in updates.clone() {
            answer.apply(update);
        }
        updates
    }

    #[test]
    fn claude_deltas_accumulate_into_one_paragraph() {
        let mut answer = Answer::default();
        for text in ["h", "ello", " there"] {
            let line = CLAUDE_DELTA.replace("ello", text);
            apply_line(CLAUDE, &line, &mut answer);
        }
        assert_eq!(answer.text(), "hello there");
    }

    #[test]
    fn a_new_claude_text_block_starts_a_paragraph() {
        let mut answer = Answer::default();
        apply_line(CLAUDE, CLAUDE_DELTA, &mut answer);
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#;
        apply_line(CLAUDE, start, &mut answer);
        apply_line(CLAUDE, &CLAUDE_DELTA.replace("ello", "second"), &mut answer);
        assert_eq!(answer.text(), "ello\n\nsecond");
    }

    #[test]
    fn a_claude_line_reports_its_session() {
        let updates = apply_line(CLAUDE, CLAUDE_DELTA, &mut Answer::default());
        assert!(updates.contains(&Update::Session("c1f31051".into())));
    }

    #[test]
    fn a_claude_result_is_the_final_answer_and_the_cost() {
        let line = r#"{"type":"result","subtype":"success","result":"hello from claude","total_cost_usd":0.139}"#;
        let updates = apply_line(CLAUDE, line, &mut Answer::default());
        assert!(updates.contains(&Update::Final("hello from claude".into())));
        assert!(updates.contains(&Update::Cost(0.139)));
    }

    #[test]
    fn an_opencode_part_replaces_itself_as_it_grows() {
        let mut answer = Answer::default();
        apply_line(OPENCODE, &OPENCODE_TEXT.replace("hello from opencode", "hel"), &mut answer);
        apply_line(OPENCODE, OPENCODE_TEXT, &mut answer);
        assert_eq!(answer.text(), "hello from opencode");
        // A second part is a second paragraph, not an overwrite.
        apply_line(
            OPENCODE,
            &OPENCODE_TEXT.replace("prt_fc870a6b", "prt_other").replace("hello from opencode", "more"),
            &mut answer,
        );
        assert_eq!(answer.text(), "hello from opencode\n\nmore");
    }

    #[test]
    fn a_thinking_or_tool_event_contributes_no_text() {
        let mut answer = Answer::default();
        for line in [
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read"}}}"#,
            r#"{"type":"system","subtype":"init","session_id":"c1f31051"}"#,
        ] {
            apply_line(CLAUDE, line, &mut answer);
        }
        assert_eq!(answer.text(), "");
    }

    // ---- progress: the reasoning, the tools, the phase -----------------------
    //
    // Every line below was captured from the installed CLIs, because the whole point
    // of this half is that a UI says what the agent is actually DOING — and a guessed
    // event shape shows a spinner that never changes.

    /// The real lines a Claude Code tool call is made of: the call is announced, its
    /// arguments stream as partial JSON, the whole turn repeats it with the arguments
    /// complete, and the result comes back as a user turn.
    const CLAUDE_TOOL_START: &str = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_bdrk_01J7","name":"Read","input":{}}},"session_id":"54d69776"}"#;
    const CLAUDE_TOOL_TURN: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_bdrk_01J7","name":"Read","input":{"file_path":"/tmp/agent-probe/NOTES.md"}}]},"session_id":"54d69776"}"#;
    const CLAUDE_TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_bdrk_01J7","type":"tool_result","content":"1\tThe answer is forty two."}]},"session_id":"54d69776"}"#;
    /// A real opencode tool part: one part carrying the call's whole state.
    const OPENCODE_TOOL: &str = r#"{"type":"tool_use","sessionID":"ses_036d02f8","part":{"type":"tool","tool":"read","callID":"tooluse_u8je","state":{"status":"completed","input":{"filePath":"/tmp/agent-probe/NOTES.md"},"title":"tmp/agent-probe/NOTES.md"}}}"#;

    #[test]
    fn a_claude_tool_call_is_named_when_it_starts_and_targeted_as_its_arguments_arrive() {
        let mut answer = Answer::default();
        apply_line(CLAUDE, CLAUDE_TOOL_START, &mut answer);
        // Named immediately, with no target yet: "Read" already beats a spinner.
        let progress = answer.progress();
        assert_eq!(progress.phase, Phase::Working);
        let activity = progress.activity.clone().expect("a running tool");
        assert_eq!(activity.tool, "Read");
        assert_eq!(activity.target, "");
        assert!(!activity.done);

        // The arguments arrive split mid-token, as they really do.
        for fragment in [r#"{"file_path": "/t"#, "mp/ag", "ent-probe/NOT", "ES.md", r#""}"#] {
            let line = CLAUDE_TOOL_START
                .replace(
                    r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_bdrk_01J7","name":"Read","input":{}}}"#,
                    &format!(
                        r#"{{"type":"content_block_delta","index":1,"delta":{{"type":"input_json_delta","partial_json":{}}}}}"#,
                        serde_json::to_string(fragment).unwrap()
                    ),
                );
            apply_line(CLAUDE, &line, &mut answer);
        }
        let activity = answer.progress().activity.expect("a running tool");
        assert_eq!(activity.target, "/tmp/agent-probe/NOTES.md");
        assert_eq!(answer.progress().tools_used, 1);
    }

    #[test]
    fn the_whole_claude_turn_targets_a_call_whose_arguments_never_parsed() {
        // The belt to the streamed braces' suspenders: a run that missed a fragment
        // still learns what the tool was pointed at.
        let mut answer = Answer::default();
        apply_line(CLAUDE, CLAUDE_TOOL_START, &mut answer);
        apply_line(CLAUDE, CLAUDE_TOOL_TURN, &mut answer);
        let activity = answer.progress().activity.expect("a tool");
        assert_eq!(activity.target, "/tmp/agent-probe/NOTES.md");
        // And the fuller description does not lose the name the first line gave.
        assert_eq!(activity.tool, "Read");
        // One call, described twice.
        assert_eq!(answer.progress().tools_used, 1);
    }

    #[test]
    fn a_tool_result_ends_the_call_and_the_phase_moves_on() {
        let mut answer = Answer::default();
        apply_line(CLAUDE, CLAUDE_TOOL_START, &mut answer);
        apply_line(CLAUDE, CLAUDE_TOOL_RESULT, &mut answer);
        let progress = answer.progress();
        assert!(progress.activity.expect("the finished call is still shown").done);
        // Nothing has been written yet, so the run is thinking again — not working.
        assert_eq!(progress.phase, Phase::Thinking);
        apply_line(CLAUDE, CLAUDE_DELTA, &mut answer);
        assert_eq!(answer.progress().phase, Phase::Writing);
    }

    #[test]
    fn an_opencode_tool_part_carries_its_own_state() {
        let mut answer = Answer::default();
        apply_line(OPENCODE, &OPENCODE_TOOL.replace("completed", "running"), &mut answer);
        let progress = answer.progress();
        assert_eq!(progress.phase, Phase::Working);
        let activity = progress.activity.expect("a running tool");
        assert_eq!(activity.tool, "read");
        assert_eq!(activity.target, "/tmp/agent-probe/NOTES.md");
        assert!(!activity.done);
        // The same part, re-sent as completed: the call ends, it is not a second one.
        apply_line(OPENCODE, OPENCODE_TOOL, &mut answer);
        assert!(answer.progress().activity.expect("a tool").done);
        assert_eq!(answer.progress().tools_used, 1);
    }

    #[test]
    fn reasoning_is_reported_apart_from_the_answer() {
        let mut answer = Answer::default();
        for text in ["let me ", "check the port"] {
            let line = format!(
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"thinking_delta","thinking":{}}}}}}}"#,
                serde_json::to_string(text).unwrap()
            );
            apply_line(CLAUDE, &line, &mut answer);
        }
        let progress = answer.progress();
        // Two deltas, one thought: the reasoning is a text that grows, not a list of
        // fragments — a UI that drew one row per delta would flicker a row a token.
        assert_eq!(progress.steps, vec![Step::Thought("let me check the port".into())]);
        assert_eq!(progress.thinking(), "let me check the port");
        // Reasoning is never part of the answer that goes to Teams.
        assert_eq!(progress.text, "");
        assert_eq!(progress.phase, Phase::Thinking);
    }

    /// The shape the whole streaming surface is built on: what the model said, then what
    /// it did about it, then what it said next — in that order, in one list.
    #[test]
    fn the_transcript_interleaves_the_reasoning_with_the_calls_that_followed_it() {
        let mut answer = Answer::default();
        answer.apply(Update::Thinking("the port is a constant".into()));
        apply_line(CLAUDE, CLAUDE_TOOL_START, &mut answer);
        apply_line(CLAUDE, CLAUDE_TOOL_RESULT, &mut answer);
        answer.apply(Update::Thinking("that is 19420".into()));
        assert_eq!(
            answer.progress().steps,
            vec![
                Step::Thought("the port is a constant".into()),
                Step::Tool(Activity { tool: "Read".into(), target: String::new(), done: true }),
                Step::Thought("that is 19420".into()),
            ]
        );
        // And the call it names is the one the reader is waiting on — the newest.
        assert_eq!(answer.progress().activity.expect("a tool").tool, "Read");
    }

    #[test]
    fn only_the_tail_of_the_reasoning_is_kept() {
        let mut answer = Answer::default();
        answer.apply(Update::Thinking("é".repeat(MAX_THINKING_BYTES)));
        // A call between the two, so the tail is dropped across entries rather than
        // inside one: an exhausted thought goes, and the call it explained stays.
        answer.apply(Update::Tool { id: "c1".into(), name: "Grep".into(), target: "x".into() });
        answer.apply(Update::Thinking("the end".into()));
        let progress = answer.progress();
        let thinking = progress.thinking();
        assert!(thinking.len() <= MAX_THINKING_BYTES);
        // The latest reasoning is what a reader is shown, so it must survive.
        assert!(thinking.ends_with("the end"), "{thinking}");
        assert!(
            progress.steps.iter().any(|step| matches!(step, Step::Tool(_))),
            "the calls are capped apart from the reasoning: {:?}",
            progress.steps
        );
        // No blank thought is left where the cut emptied one.
        assert!(!progress.steps.contains(&Step::Thought(String::new())));
    }

    #[test]
    fn the_tool_list_is_bounded_but_the_count_is_not() {
        let mut answer = Answer::default();
        for i in 0..MAX_TOOL_CALLS + 10 {
            answer.apply(Update::Tool {
                id: format!("call-{i}"),
                name: "Grep".into(),
                target: format!("pattern-{i}"),
            });
        }
        let progress = answer.progress();
        assert_eq!(progress.steps.len(), MAX_TOOL_CALLS);
        assert_eq!(progress.tools_used, MAX_TOOL_CALLS + 10);
        // The oldest calls are the ones dropped, so the transcript ends on the newest.
        assert_eq!(
            progress.steps.first(),
            Some(&Step::Tool(Activity {
                tool: "Grep".into(),
                target: "pattern-10".into(),
                done: false,
            }))
        );
        assert_eq!(
            progress.activity.expect("a tool").target,
            format!("pattern-{}", MAX_TOOL_CALLS + 9)
        );
    }

    #[test]
    fn a_target_is_read_from_a_known_argument_and_never_invented() {
        let target = |json: &str| target_from_input(&serde_json::from_str(json).unwrap());
        assert_eq!(target(r#"{"file_path":"src/agent.rs"}"#), "src/agent.rs");
        assert_eq!(target(r#"{"filePath":"src/agent.rs"}"#), "src/agent.rs");
        assert_eq!(target(r#"{"pattern":"fn main"}"#), "fn main");
        // An argument set this module does not recognise yields nothing, so the label
        // falls back to the tool's own name instead of showing a JSON blob.
        assert_eq!(target(r#"{"unknown_argument":"x"}"#), "");
        assert_eq!(target("null"), "");
        // A multi-line command collapses to one line, and is cut.
        let long = target(&format!(r#"{{"command":"echo {}"}}"#, "x".repeat(400)));
        assert_eq!(long.chars().count(), MAX_TARGET_CHARS);
        assert_eq!(target("{\"command\":\"a\\nb\"}"), "a b");
    }

    #[test]
    fn the_phase_of_a_run_that_has_said_nothing_is_thinking() {
        assert_eq!(Answer::default().progress().phase, Phase::Thinking);
        assert_eq!(Phase::Thinking.as_str(), "thinking");
        assert_eq!(Phase::Working.as_str(), "working");
        assert_eq!(Phase::Writing.as_str(), "writing");
    }

    #[test]
    fn the_answer_is_capped() {
        let mut answer = Answer::default();
        answer.apply(Update::Append("é".repeat(MAX_ANSWER_BYTES)));
        let text = answer.text();
        assert!(text.len() <= MAX_ANSWER_BYTES);
        // Cut on a character boundary, so the text is still valid UTF-8 text.
        assert!(text.chars().all(|c| c == 'é'));
    }

    #[test]
    fn the_tool_setting_falls_back_but_honours_an_empty_list() {
        assert_eq!(tools_from_setting(None), DEFAULT_TOOLS.to_vec());
        assert_eq!(tools_from_setting(Some("not json")), DEFAULT_TOOLS.to_vec());
        assert_eq!(tools_from_setting(Some("[]")), Vec::<String>::new());
        assert_eq!(tools_from_setting(Some(r#"["Bash","Read"]"#)), vec!["Bash", "Read"]);
    }

    /// The catalogue is a consent surface, so its shape is pinned rather than trusted.
    ///
    /// Two rules, and each one closes a hole a plausible entry would open:
    ///
    /// - **Three segments, never `mcp__<server>`.** A whole-server grant hands over
    ///   that server's writes too — `update_dashboard`, `save_issue`, `update_issue` —
    ///   and the two "call any endpoint" tools (`grafana_api_request`,
    ///   `execute_sentry_tool`) with them.
    /// - **A verb that reads.** Anything else in a group the UI switches on with one
    ///   click is a write the user did not ask for, in a system their colleagues share.
    #[test]
    fn every_granted_tool_reads() {
        const READ_VERBS: [&str; 7] =
            ["list_", "get_", "search_", "find_", "query_", "check_", "generate_"];
        for grant in TOOL_GRANTS {
            assert!(!grant.tools.is_empty(), "{} grants nothing", grant.key);
            for tool in grant.tools {
                if DEFAULT_TOOLS.contains(tool) {
                    continue; // the read-only built-ins
                }
                let segments: Vec<&str> = tool.split("__").collect();
                assert_eq!(
                    segments.len(),
                    3,
                    "{tool} must name one MCP tool (mcp__server__tool), never a whole \
                     server: a server grant carries its writes too"
                );
                assert_eq!(segments[0], "mcp", "{tool} is neither a built-in nor an MCP tool");
                assert!(
                    READ_VERBS.iter().any(|verb| segments[2].starts_with(verb)),
                    "{tool} does not start with a verb that reads ({READ_VERBS:?})"
                );
            }
        }
    }

    #[test]
    fn the_catalogue_starts_at_the_read_only_default_and_has_no_duplicate_key() {
        let files = TOOL_GRANTS.iter().find(|g| g.key == "files").expect("a files grant");
        assert_eq!(files.tools, DEFAULT_TOOLS, "the first switch must be what a fresh store holds");
        let mut keys: Vec<&str> = TOOL_GRANTS.iter().map(|g| g.key).collect();
        keys.sort_unstable();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count, "two grants share a key: a client cannot tell them apart");
    }

    /// The tools an MCP grant names must be spelled the way the CLI spells them, or the
    /// switch is on and the call is still refused — a setting that lies.
    ///
    /// Verified against Claude Code 2.1.220 and the user's own Grafana: `claude -p
    /// --permission-mode default --allowed-tools mcp__grafana__list_datasources`
    /// answered with the instance's datasources and reported no permission denial.
    #[test]
    fn an_mcp_grant_is_spelled_the_way_the_cli_spells_a_tool() {
        let grafana = TOOL_GRANTS.iter().find(|g| g.key == "grafana").expect("a grafana grant");
        assert!(grafana.tools.contains(&"mcp__grafana__list_datasources"));
        for tool in grafana.tools {
            assert!(tool.starts_with("mcp__grafana__"), "{tool} is not a grafana tool");
        }
    }

    #[test]
    fn the_default_workspace_is_not_the_checkout() {
        let workspace = default_workspace();
        assert!(workspace.ends_with("teams-lite/agent-workspace"), "{workspace:?}");
        assert_ne!(workspace, std::env::current_dir().unwrap());
    }

    #[tokio::test]
    async fn a_failed_resume_is_retried_once_and_still_reports_the_failure() {
        // `false` stands in for a CLI that refuses whatever it is given, so both the
        // resume and the fresh retry fail: the fallback must not mask the error, and
        // must not loop.
        static ALWAYS_FAILS: Backend =
            Backend {
            name: "opencode",
            prefix: "@opencode",
            program: "false",
            models: &[],
            catalogue: Catalogue::None,
        };
        let mut request = request(OPENCODE);
        request.backend = &ALWAYS_FAILS;
        request.resume_session = Some("ses_gone".into());
        let (progress, _rx) = watch::channel(Progress::default());
        let error = run(&request, &progress).await.expect_err("both attempts fail");
        assert!(error.to_string().contains("without saying anything"), "{error}");
    }

    /// A run is stopped by SILENCE, never by how long the work takes.
    ///
    /// This is what [`RUN_IDLE_TIMEOUT`] buys: the stream below takes four times the
    /// idle window to arrive, one event at a time, and every event pushes the deadline
    /// back. The cap this code held before was over the whole run, so it cut a question
    /// that needed forty minutes of tool calls at ten — half way, and in front of
    /// everybody in the thread.
    #[tokio::test(start_paused = true)]
    async fn a_run_that_keeps_talking_is_never_cut_short() {
        let idle = Duration::from_secs(60);
        let (mut writer, reader) = tokio::io::duplex(4096);
        let feed = tokio::spawn(async move {
            for _ in 0..4 {
                tokio::time::sleep(idle - Duration::from_secs(1)).await;
                writer.write_all(format!("{CLAUDE_DELTA}\n").as_bytes()).await.unwrap();
            }
            // Dropping the pipe is the child exiting.
        });
        let (progress, _rx) = watch::channel(Progress::default());
        let outcome = harvest(CLAUDE, reader, idle, &progress).await.expect("the run finishes");
        feed.await.unwrap();
        assert_eq!(outcome.text, "elloelloelloello");
    }

    /// And a CLI that stopped talking IS stopped, so the thread does not keep a
    /// "thinking…" message in front of a program that will never answer.
    #[tokio::test(start_paused = true)]
    async fn a_silent_run_is_stopped_after_the_idle_window() {
        let idle = Duration::from_secs(120);
        let (mut writer, reader) = tokio::io::duplex(4096);
        writer.write_all(format!("{CLAUDE_DELTA}\n").as_bytes()).await.unwrap();
        // `writer` is held, so the pipe stays open and silent: a wedged CLI, not one
        // that exited.
        let (progress, _rx) = watch::channel(Progress::default());
        let error =
            harvest(CLAUDE, reader, idle, &progress).await.expect_err("the silence stops it");
        assert!(error.to_string().contains("said nothing for 2 minutes"), "{error}");
    }

    #[test]
    fn the_backstop_is_far_above_the_idle_window() {
        // Two different jobs: the idle window catches a CLI that stopped, the backstop
        // catches one that never stops. A backstop near the idle window would take the
        // first one's job and cut a long, talkative run.
        assert!(RUN_MAX_DURATION >= RUN_IDLE_TIMEOUT * 8, "{RUN_MAX_DURATION:?}");
    }

    #[tokio::test]
    async fn a_missing_program_fails_before_anything_runs() {
        static MISSING: Backend = Backend {
            name: "nope",
            prefix: "@nope",
            program: "teams-lite-no-such-agent",
            models: &[],
            catalogue: Catalogue::None,
        };
        let mut request = request(CLAUDE);
        request.backend = &MISSING;
        let (progress, _rx) = watch::channel(Progress::default());
        let error = run(&request, &progress).await.expect_err("no such program");
        assert!(error.to_string().contains("not on PATH"), "{error}");
        assert!(!is_available(&MISSING));
    }

    /// The service unit must hand the backend a PATH that can hold a user-installed
    /// CLI.
    ///
    /// This is the bug that made the feature look broken: the systemd user manager's
    /// PATH holds neither `~/.local/bin` nor `~/.bun/bin`, so a service inherited a
    /// PATH with no `claude` in it, [`is_available`] answered false, and every
    /// `@claude` message was dropped with one line in the journal while the thread
    /// stayed silent. A unit that loses this line brings that back, and no test on this
    /// side of the process boundary would notice — so the test reads the template.
    #[test]
    fn the_service_unit_gives_the_backend_a_path_holding_the_users_own_bin() {
        let unit = include_str!("../packaging/systemd/teams-lite-backend.service");
        let path_line = unit
            .lines()
            .find(|line| line.starts_with("Environment=PATH="))
            .expect("the backend unit sets PATH");
        assert!(
            path_line.contains("@AGENT_PATH@"),
            "PATH must come from the installer's substitution, so it can name $HOME: {path_line}"
        );
        let installer = include_str!("../bin/teams-lite-service.sh");
        assert!(
            installer.contains("s|@AGENT_PATH@|"),
            "bin/teams-lite-service.sh must substitute @AGENT_PATH@, or the unit \
             refuses to install"
        );
        let assigned = installer
            .lines()
            .find(|line| line.starts_with("AGENT_PATH="))
            .expect("bin/teams-lite-service.sh computes AGENT_PATH");
        for dir in ["$HOME/.local/bin", "$HOME/.bun/bin"] {
            assert!(
                assigned.contains(dir),
                "the installed PATH must hold {dir}, where a coding-agent CLI installs \
                 itself: {assigned}"
            );
        }
    }
}
