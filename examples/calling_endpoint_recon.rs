// Manual live check for the CALLING plane's own endpoints, READ-ONLY.
//
// The real Teams web client reads its calling service URL out of the same authz
// directory this app already fetches for `chatService`: its own code names the keys
// `serviceUrls.calling_conversationServiceUrl` and `calling_uploadLogRequestUrl`
// (statics.teams.cdn.office.net → teams-modular-packages/hashed-assets/
// calling-pluginless-*.js, the browser calling stack). This example prints every
// regionGtms key so the calling ones can be read beside the messaging ones.
//
// It rings NOBODY and registers NOTHING: one authz POST (the bootstrap this app
// already makes on every start) and then printing. It never posts a callInvitation,
// never registers a trouter endpoint and never touches a conversation.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example calling_endpoint_recon
use anyhow::Result;
use serde_json::Value;

/// The keys the web client's calling stack reads out of the directory.
const CALLING_KEYS: &[&str] = &[
    "calling_conversationServiceUrl",
    "calling_uploadLogRequestUrl",
    "calling_trouterUrl",
    "callingService",
    "conversationServiceUrl",
];

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    println!("== region={} self={}", session.region, session.self_mri);

    let map = session.gtms.as_object().cloned().unwrap_or_default();
    println!("== regionGtms holds {} keys", map.len());

    let mut names: Vec<&String> = map.keys().collect();
    names.sort();
    for name in &names {
        let lowered = name.to_lowercase();
        let marker = if lowered.contains("call") || lowered.contains("media") {
            "*"
        } else {
            " "
        };
        let value = map.get(*name).map(render).unwrap_or_default();
        println!(" {marker} {name} = {value}");
    }

    println!("== the keys the web client's calling stack names");
    for key in CALLING_KEYS {
        match session.endpoint(key) {
            Some(url) => println!("   {key} = {url}"),
            None => println!("   {key} = <absent>"),
        }
    }
    Ok(())
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
