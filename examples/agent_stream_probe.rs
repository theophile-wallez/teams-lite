// Manual live check for the STREAMED agent reply: post one message, then edit it as
// a local agent writes its answer, so everybody in the thread watches it appear.
//
// It exercises the same pieces `agent_reply` in src/bin/server.rs does — the runner
// (`agent::run`), the message shape (`agent_policy::reply_html`), the send and the
// edits — without a backend, so the whole chain can be proven against the real tenant
// before the always-on service ever runs this code.
//
// It also pins the one fact the feature rests on: a send hands back an EDITABLE
// message id. Teams returns no `id` field at all, only
// `{"OriginalArrivalTime": 1785773946196}` — a message id IS its arrival time in
// epoch ms. Nothing in this crate had ever read that response body.
//
// It is NOT a unit test: it posts to real Teams. The conversation is therefore a
// CONST, not an argument — the sandbox channel from AGENTS.md, the one place a send is
// pre-authorized. Do not parameterize it: an example that can post anywhere is a send
// waiting for a typo, and `.claude/hooks/guard-live-automation.sh` (rule 1c) refuses
// to run one.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example agent_stream_probe -- "what does the Ports table say?" \
//       [claude|opencode] [model]
//
use anyhow::{Context, Result};

use teams_lite::{agent, agent_policy, teams, teams_send};

/// The sandbox channel (AGENTS.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

#[tokio::main]
async fn main() -> Result<()> {
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "In one sentence: what are you, and where are you running?".to_string());
    let backend = agent_policy::backend_named(
        &std::env::args().nth(2).unwrap_or_else(|| "claude".to_string()),
    )
    .context("unknown backend — pass `claude` or `opencode`")?;
    // A third argument runs a chosen model, the way Settings › AI providers does.
    // Absent, the CLI keeps its own configured one.
    let model = std::env::args().nth(3).filter(|m| !m.trim().is_empty());
    if let Some(model) = &model {
        anyhow::ensure!(agent_policy::is_valid_model(model), "`{model}` is not a model name");
    }
    anyhow::ensure!(
        agent::is_available(backend),
        "`{}` is not on PATH",
        backend.program
    );
    // The probe drives a PROVIDER run, so the line every body signs itself with is the
    // provider's own. A custom agent's is the same one function with its name in it (see
    // `agent_policy::Signature`), and nothing here needs a second spelling of it.
    let signer = agent_policy::Signature::of(backend);

    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // 1. Post the placeholder, and read the id back out of the response. The ic3 token
    // is only used to upload an image or emoji, and there is none here, so it stays empty.
    let sent = teams_send::send_message(
        &http,
        &session,
        "",
        SANDBOX_THREAD,
        "",
        None,
        Some(&agent_policy::thinking_html(&signer)),
        &[],
        &[],
        &[],
        None,
        None, // no title: a probe posts no channel post
    )
    .await
    .context("post the placeholder")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send returned no editable message id");
    println!("posted, editable id = {}", sent.id);

    // 2. Run the agent, editing that message as the answer grows.
    let request = agent::Request {
        backend,
        prompt: prompt.clone(),
        system_prompt: agent_policy::system_prompt(backend.name, "teams-lite sandbox"),
        resume_session: None,
        workspace: agent::default_workspace(),
        // The read-only default, never what the store happens to hold: a probe that
        // inherited `Permissions::OwnConfig` would run the widest configuration on this
        // machine from a command line, which is not what "try the streaming" asks for.
        permissions: agent::Permissions::Granted(agent::tools_from_setting(None)),
        model,
    };
    let (progress, mut watch) = tokio::sync::watch::channel(agent::Progress::default());
    let run = async move {
        let outcome = agent::run(&request, &progress).await;
        drop(progress);
        outcome
    };
    let stream = async {
        let mut edits = 0;
        let mut posted = String::new();
        while watch.changed().await.is_ok() {
            let current = watch.borrow_and_update().clone();
            // What the app's own frontends are told, printed as it happens — this is
            // the `agent_stream` event's payload in all but its JSON (see
            // `agent_stream_local` in src/bin/server.rs).
            println!(
                "  [{}] {} chars{}{}",
                current.phase.as_str(),
                current.text.chars().count(),
                current
                    .activity
                    .as_ref()
                    .map(|a| format!(
                        " — {}{}{}",
                        a.tool,
                        if a.target.is_empty() { String::new() } else { format!(" {}", a.target) },
                        if a.done { " ✓" } else { "" }
                    ))
                    .unwrap_or_default(),
                match current.thinking().chars().count() {
                    0 => String::new(),
                    n => format!(" ({n} chars of reasoning over {} steps)", current.steps.len()),
                },
            );
            // Only the answer is worth an edit: Teams sees the message, not the phase.
            if current.text.trim().is_empty() || current.text == posted {
                continue;
            }
            // `reply_html` mentions nobody, which is what this probe wants: it posts
            // to the sandbox channel and a mention notifies a real person.
            let html = agent_policy::reply_html(&signer, &current.text, false);
            teams_send::edit_message(
                &http, &session, SANDBOX_THREAD, &sent.id, "", Some(&html), &[],
                None, // a probe's message is untitled
            )
            .await?;
            posted = current.text;
            edits += 1;
            println!("edit {edits}: {} chars", posted.chars().count());
            tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
        }
        Ok::<usize, anyhow::Error>(edits)
    };
    let (outcome, edits) = tokio::join!(run, stream);

    // 3. Land the authoritative answer.
    let html = match &outcome {
        Ok(outcome) => agent_policy::reply_html(&signer, &outcome.text, true),
        Err(e) => agent_policy::failure_html(&signer, &e.to_string()),
    };
    teams_send::edit_message(&http, &session, SANDBOX_THREAD, &sent.id, "", Some(&html), &[], None)
        .await
        .context("post the final answer")?;

    // 4. Read the message back. A PUT that returns 2xx is not proof that Teams KEPT
    // the content: edits arrive seconds apart, and a server that coalesced or dropped
    // one would leave the thread showing half an answer forever.
    let stored = read_message(&http, &session, &sent.id).await?;
    println!("Teams holds: {}", stored.chars().take(300).collect::<String>());
    // Compared with the whitespace BETWEEN TAGS removed: the server pretty-prints the
    // body it stores (`</p>\r\n<ul>` for our `</p><ul>`), so an exact match would fail
    // for a reason that has nothing to do with the edit landing.
    let collapse = |html: &str| {
        html.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("> <", "><")
    };
    if collapse(&stored) != collapse(&html) {
        println!("sent:  {}", collapse(&html));
        println!("held:  {}", collapse(&stored));
        anyhow::bail!("the final edit is NOT what Teams holds");
    }

    println!("{} progress edits", edits.unwrap_or(0));
    match outcome {
        Ok(outcome) => {
            println!(
                "OK — {} answered in {} chars{}",
                backend.name,
                outcome.text.chars().count(),
                outcome.cost_usd.map(|c| format!(" for ${c:.2}")).unwrap_or_default()
            );
            // Prove the session is reusable for a follow-up, which is what keeps a
            // thread's conversation with the model going.
            println!("session = {}", outcome.session_id.unwrap_or_default());
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// The content Teams currently holds for one message in the sandbox channel.
async fn read_message(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
) -> Result<String> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(SANDBOX_THREAD),
        urlencoding::encode(message_id)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("read the message back")?;
    let body = resp.text().await.unwrap_or_default();
    let parsed: serde_json::Value =
        serde_json::from_str(&body).context("the message body is not JSON")?;
    Ok(parsed.get("content").and_then(|c| c.as_str()).unwrap_or_default().to_string())
}
