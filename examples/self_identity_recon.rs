// Manual live check: why does this account sign in with an EMPTY display name?
//
// `teams::fetch_self_identity` reads `/v1/users/ME/properties` and pulls the name out
// of `userDetails` (a JSON-encoded STRING). The store of this machine holds a
// `self_mri` and an empty `self_name`, so the mri half of that response parses and the
// name half does not — and every message this client SENDS carries
// `imdisplayname: ""` as a result (`teams_send::build_body`), which is what leaves the
// author line blank in every other teams-lite.
//
// This prints the raw response so the shape can be seen rather than guessed, plus what
// the DIRECTORY says about the same account — which is what the shipped fix leans on
// (`Ctx::adopt_session` → `Ctx::directory_name`), so this run is how that half is
// re-measured. It also names every field the response really carries, because the
// alternative fix — reading a name straight out of one of them — is only worth writing
// once somebody has seen what is in there. `primaryMemberName` in particular was asserted
// in a comment and read by nothing: it may be a name, or it may be the identity again,
// and the two lead to opposite designs.
//
// READ-ONLY: two GETs and one profile POST that fetches, never publishes.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example self_identity_recon
use anyhow::Result;
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    println!(
        "== connect(): region={} self_mri={:?} self_name={:?}",
        session.region, session.self_mri, session.self_name
    );

    let chat = session
        .endpoint("chatService")
        .ok_or_else(|| anyhow::anyhow!("no chatService endpoint"))?
        .trim_end_matches('/')
        .to_string();
    let body = http
        .get(format!("{chat}/v1/users/ME/properties"))
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await?
        .text()
        .await?;
    println!("\n-- GET {chat}/v1/users/ME/properties\n{body}");

    if let Ok(v) = serde_json::from_str::<Value>(&body) {
        // EVERY field, so a name hiding in one of them is seen rather than assumed. A
        // string that merely repeats `skypeName` is an identity and not a name — which is
        // the whole question about `primaryMemberName`, so the answer is printed beside it.
        if let Some(fields) = v.as_object() {
            let skype_name = v.get("skypeName").and_then(Value::as_str).unwrap_or("");
            println!("\n-- {} fields:", fields.len());
            for (key, value) in fields {
                let repeats = value.as_str().is_some_and(|s| {
                    !skype_name.is_empty() && s.contains(skype_name.trim_start_matches("8:"))
                });
                println!(
                    "   {key} = {value:?}{}",
                    if repeats { "   <- repeats skypeName: an identity, not a name" } else { "" }
                );
            }
        }
        println!("\n   skypeName   = {:?}", v.get("skypeName"));
        println!("   userDetails = {:?}  (the field that stopped arriving)", v.get("userDetails"));
    }

    let token = teams_lite::auth::get_token(teams_lite::teams_profiles::PROFILE_SCOPE).await?;
    for p in teams_lite::teams_profiles::fetch_profiles(
        &http,
        &session,
        &token,
        std::slice::from_ref(&session.self_mri),
    )
    .await?
    {
        println!("\n-- directory profile {}\n   display_name={:?}", p.mri, p.display_name);
        println!(
            "   ^ this is what Ctx::directory_name adopts into the session, so a name here \
             means a signed-in app sends `imdisplayname` correctly on a FRESH store too"
        );
    }
    Ok(())
}
